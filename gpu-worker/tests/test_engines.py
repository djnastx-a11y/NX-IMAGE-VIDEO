"""Wiring tests for the real engines, without a GPU.

torch, diffusers and the pipelines are replaced by stand-ins that check every keyword argument
against the real __call__ signatures (diffusers 0.41.0) and return frames/images of the right
shape. What this proves: parameters are translated correctly, the calls match the diffusers API,
progress, cancellation and out-of-memory are handled, and outputs are encoded. What it cannot
prove: image quality, speed or memory use, which need a real GPU (see bench.py).
"""

from __future__ import annotations

import json
import subprocess
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from nx_gpu.engines import build_engines
from nx_gpu.engines.base import Cancelled, EngineError, JobContext
from nx_gpu.engines import flux, ltx, ltx_video, qwen_image, upscale, wan

# Accepted keyword arguments of each pipeline's __call__, extracted from diffusers 0.41.0.
_COMMON = {"prompt", "negative_prompt", "prompt_embeds", "negative_prompt_embeds", "guidance_scale", "num_inference_steps", "width", "height", "generator", "latents", "output_type", "return_dict", "attention_kwargs", "callback_on_step_end", "callback_on_step_end_tensor_inputs", "max_sequence_length"}
_QWEN = _COMMON | {"true_cfg_scale", "prompt_embeds_mask", "negative_prompt_embeds_mask", "num_images_per_prompt", "sigmas"}
SIGNATURES = {
    "LTX2ConditionPipeline": _COMMON | {"conditions", "num_frames", "min_seconds", "max_seconds", "frame_rate", "sigmas", "timesteps", "stg_scale", "modality_scale", "guidance_rescale", "audio_guidance_scale", "audio_stg_scale", "audio_modality_scale", "audio_guidance_rescale", "spatio_temporal_guidance_blocks", "noise_scale", "num_videos_per_prompt", "audio_latents", "prompt_attention_mask", "negative_prompt_attention_mask", "decode_timestep", "decode_noise_scale", "use_cross_timestep", "system_prompt", "enable_prompt_enhancement", "prompt_max_new_tokens", "prompt_enhancement_kwargs", "prompt_enhancement_seed"},
    "LTXConditionPipeline": _COMMON | {"conditions", "image", "video", "frame_index", "strength", "denoise_strength", "num_frames", "frame_rate", "timesteps", "guidance_rescale", "image_cond_noise_scale", "num_videos_per_prompt", "prompt_attention_mask", "negative_prompt_attention_mask", "decode_timestep", "decode_noise_scale"},
    "WanPipeline": _COMMON | {"num_frames", "guidance_scale_2", "num_videos_per_prompt"},
    "WanImageToVideoPipeline": _COMMON | {"num_frames", "guidance_scale_2", "num_videos_per_prompt", "image", "last_image", "image_embeds"},
    "QwenImagePipeline": _QWEN,
    "QwenImageImg2ImgPipeline": _QWEN | {"image", "strength"},
    "QwenImageEditPlusPipeline": _QWEN | {"image"},
    "QwenImageEditInpaintPipeline": _QWEN | {"image", "mask_image", "masked_image_latents", "padding_mask_crop", "strength"},
    "Flux2KleinPipeline": (_COMMON - {"negative_prompt"}) | {"image", "num_images_per_prompt", "sigmas", "text_encoder_out_layers"},
}


class FakeOOM(RuntimeError):
    pass


calls: list[tuple[str, dict[str, Any]]] = []
loads: list[str] = []
behaviour: dict[str, Any] = {}


def fake_pipeline(name: str) -> type:
    class Pipe:
        config = types.SimpleNamespace(is_distilled=True)

        @classmethod
        def from_pretrained(cls, model: str, torch_dtype: Any = None, **kw: Any) -> "Pipe":
            p = cls()
            p.model = model
            p.loaded_with = {"torch_dtype": torch_dtype, **kw}
            loads.append(name)
            return p

        @classmethod
        def from_pipe(cls, other: Any) -> "Pipe":
            p = cls()
            p.model = other.model
            return p

        vae = types.SimpleNamespace(enable_tiling=lambda: None)

        def enable_model_cpu_offload(self) -> None:
            pass

        def __call__(self, **kw: Any) -> Any:
            unknown = set(kw) - SIGNATURES[name]
            assert not unknown, f"{name} does not accept {unknown}"
            calls.append((name, kw))
            if behaviour.get("oom"):
                raise FakeOOM("CUDA out of memory. Tried to allocate 2.00 GiB")
            for i in range(kw["num_inference_steps"]):
                kw["callback_on_step_end"](self, i, 1000 - i, {})
            if name == "LTXConditionPipeline":
                return types.SimpleNamespace(frames=np.random.rand(1, kw["num_frames"], 48, 64, 3).astype(np.float32))
            if name.startswith("LTX2"):
                return np.random.rand(1, kw["num_frames"], 48, 64, 3).astype(np.float32), None
            if name.startswith("Wan"):
                return types.SimpleNamespace(frames=np.random.rand(1, kw["num_frames"], 48, 64, 3).astype(np.float32))
            n = kw.get("num_images_per_prompt", 1)
            return types.SimpleNamespace(images=[Image.new("RGB", (kw["width"], kw["height"]), (40 * i, 90, 160)) for i in range(n)])

    Pipe.__name__ = name
    return Pipe


@dataclass
class VideoCondition:
    frames: Any
    index: int = 0
    strength: float = 1.0
    crf: int | None = None


@pytest.fixture(autouse=True)
def fake_stack(monkeypatch: pytest.MonkeyPatch) -> None:
    calls.clear()
    loads.clear()
    behaviour.clear()
    torch = types.ModuleType("torch")
    torch.bfloat16 = "bf16"  # type: ignore[attr-defined]
    torch.float16 = "fp16"  # type: ignore[attr-defined]
    torch.float32 = "fp32"  # type: ignore[attr-defined]
    torch.cuda = types.SimpleNamespace(OutOfMemoryError=FakeOOM, is_available=lambda: False, empty_cache=lambda: None)  # type: ignore[attr-defined]

    class Gen:
        def __init__(self, device: str = "cpu"):
            self.seed: int | None = None

        def manual_seed(self, s: int) -> "Gen":
            self.seed = s
            return self

    torch.Generator = Gen  # type: ignore[attr-defined]
    diffusers = types.ModuleType("diffusers")
    for name in SIGNATURES:
        setattr(diffusers, name, fake_pipeline(name))
    diffusers.AutoencoderKLWan = types.SimpleNamespace(from_pretrained=lambda model, subfolder=None, torch_dtype=None: ("vae", model, torch_dtype))  # type: ignore[attr-defined]

    @dataclass
    class LtxCondition:
        image: Any = None
        video: Any = None
        frame_index: int = 0
        strength: float = 1.0

    ltxv_mod = types.ModuleType("diffusers.pipelines.ltx.pipeline_ltx_condition")
    ltxv_mod.LTXVideoCondition = LtxCondition  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "diffusers.pipelines.ltx", types.ModuleType("diffusers.pipelines.ltx"))
    monkeypatch.setitem(sys.modules, "diffusers.pipelines.ltx.pipeline_ltx_condition", ltxv_mod)
    cond_mod = types.ModuleType("diffusers.pipelines.ltx2.pipeline_ltx2_condition")
    cond_mod.LTX2VideoCondition = VideoCondition  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "diffusers", diffusers)
    monkeypatch.setitem(sys.modules, "diffusers.pipelines", types.ModuleType("diffusers.pipelines"))
    monkeypatch.setitem(sys.modules, "diffusers.pipelines.ltx2", types.ModuleType("diffusers.pipelines.ltx2"))
    monkeypatch.setitem(sys.modules, "diffusers.pipelines.ltx2.pipeline_ltx2_condition", cond_mod)


def make_ctx(tmp_path: Path, files: dict[str, Path], cancel_after: int | None = None) -> tuple[JobContext, list[float]]:
    seen: list[float] = []

    def progress(p: float, _stage: str | None) -> None:
        seen.append(p)

    ctx = JobContext(job_id="t", work_dir=tmp_path, files=files, _progress=progress, _cancelled=lambda: cancel_after is not None and len(seen) > cancel_after)
    return ctx, seen


def png(tmp_path: Path, name: str, size: tuple[int, int] = (640, 960), color: tuple[int, int, int] = (200, 80, 40)) -> Path:
    p = tmp_path / f"{name}.png"
    Image.new("RGB", size, color).save(p)
    return p


def probe(path: Path) -> dict[str, Any]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name,nb_frames,r_frame_rate", "-of", "json", str(path)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)["streams"][0]


VIDEO_916_720 = {"target": {"width": 720, "height": 1280}, "aspectRatio": "9:16", "resolution": "720p"}


# ----------------------------------------------------------------------------- LTX


def test_ltx_image_to_video_10s_916(tmp_path: Path) -> None:
    eng = build_engines("ltx")[0]
    eng.load()
    ctx, seen = make_ctx(tmp_path, {"image": png(tmp_path, "src")})
    params = {**VIDEO_916_720, "prompt": "a dancer on a rooftop", "duration": 10, "fps": 24, "seed": 42, "camera": {"move": "dolly_in", "intensity": 8}, "sourceFidelity": 0.7}
    [out] = eng.run("image_to_video", params, ctx)
    name, kw = calls[-1]
    assert name == "LTX2ConditionPipeline"
    assert (kw["width"], kw["height"], kw["num_frames"], kw["frame_rate"]) == (704, 1280, 241, 24.0)
    assert "dollies in" in kw["prompt"] and "fast" in kw["prompt"]
    [c] = kw["conditions"]
    assert c.index == 0 and c.strength == pytest.approx(0.88) and c.frames.size == (704, 1280)
    assert kw["generator"].seed == 42 and out.seed == 42
    meta = probe(out.path)
    assert (meta["width"], meta["height"], meta["codec_name"], meta["nb_frames"]) == (720, 1280, "h264", "241")
    assert seen == sorted(seen) and seen[-1] == pytest.approx(0.95)


def test_ltx_first_last_and_keyframes(tmp_path: Path) -> None:
    files = {f"keyframe_{i}": png(tmp_path, f"k{i}") for i in range(3)}
    keyframes = [{"field": "keyframe_0", "position": 0}, {"field": "keyframe_2", "position": 1}, {"field": "keyframe_1", "position": 0.5}]
    p = ltx.plan("first_last_frame", {**VIDEO_916_720, "duration": 5, "keyframes": keyframes}, set(files), 30)
    assert [(c.field, c.index) for c in p.conditions] == [("keyframe_0", 0), ("keyframe_1", 64), ("keyframe_2", -1)]
    p2 = ltx.plan("first_last_frame", {**VIDEO_916_720}, {"image", "end_image"}, 30)
    assert [(c.field, c.index) for c in p2.conditions] == [("image", 0), ("end_image", -1)]
    with pytest.raises(EngineError):
        ltx.plan("first_last_frame", {**VIDEO_916_720}, {"image"}, 30)


def test_ltx_text_and_video_to_video(tmp_path: Path) -> None:
    eng = ltx.create("ltx")
    eng.load()
    ctx, _ = make_ctx(tmp_path, {})
    eng.run("text_to_video", {**VIDEO_916_720, "prompt": "rain on neon", "duration": 5}, ctx)
    assert calls[-1][1]["conditions"] is None and calls[-1][1]["num_frames"] == 121
    src = tmp_path / "src.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=320x240:d=2:r=24", str(src)], check=True)
    ctx2, _ = make_ctx(tmp_path, {"video": src})
    eng.run("video_to_video", {**VIDEO_916_720, "prompt": "anime style", "duration": 5, "videoStrength": 0.6}, ctx2)
    [c] = calls[-1][1]["conditions"]
    assert c.strength == 0.6 and len(c.frames) == 48 and c.frames[0].size == (704, 1280)


def test_cancel_and_oom(tmp_path: Path) -> None:
    eng = ltx.create("ltx")
    eng.load()
    ctx, _ = make_ctx(tmp_path, {}, cancel_after=3)
    with pytest.raises(Cancelled):
        eng.run("text_to_video", {**VIDEO_916_720, "prompt": "x"}, ctx)
    behaviour["oom"] = True
    ctx2, _ = make_ctx(tmp_path, {})
    with pytest.raises(EngineError) as e:
        eng.run("text_to_video", {**VIDEO_916_720, "prompt": "x"}, ctx2)
    assert e.value.retryable and "out of memory" in str(e.value)


# ----------------------------------------------------------------------------- Wan


def test_wan_image_and_first_last(tmp_path: Path) -> None:
    eng = wan.create("wan")
    eng.load()
    ctx, _ = make_ctx(tmp_path, {"image": png(tmp_path, "a"), "end_image": png(tmp_path, "b")})
    target = {"target": {"width": 480, "height": 854}}
    [out] = eng.run("first_last_frame", {**target, "prompt": "walk", "duration": 5}, ctx)
    name, kw = calls[-1]
    assert name == "WanImageToVideoPipeline"
    assert (kw["width"], kw["height"], kw["num_frames"]) == (480, 848, 81)
    assert kw["image"].size == (480, 848) and kw["last_image"].size == (480, 848)
    meta = probe(out.path)
    assert (meta["width"], meta["height"], meta["r_frame_rate"]) == (480, 854, "16/1")
    ctx2, _ = make_ctx(tmp_path, {})
    eng.run("text_to_video", {**target, "prompt": "city"}, ctx2)
    assert calls[-1][0] == "WanPipeline"
    assert list(eng.pipes) == ["t2v"]  # only one checkpoint stays loaded
    with pytest.raises(EngineError):
        wan.plan("video_to_video", target, {"video"}, 40)


# ----------------------------------------------------------------------------- 16 GB engines (Kaggle T4)


def test_ltx_video_2b_image_to_video_10s_in_fp16(tmp_path: Path) -> None:
    eng = build_engines("ltx-video")[0]
    eng.load()
    assert loads == ["LTXConditionPipeline"] and eng.pipe.loaded_with["torch_dtype"] == "fp16"  # no CUDA here -> fp16, as on a T4
    ctx, _ = make_ctx(tmp_path, {"image": png(tmp_path, "src")})
    [out] = eng.run("image_to_video", {**VIDEO_916_720, "prompt": "walk", "duration": 10, "camera": {"move": "pan_left", "intensity": 2}}, ctx)
    name, kw = calls[-1]
    assert name == "LTXConditionPipeline"
    assert (kw["width"], kw["height"], kw["num_frames"], kw["frame_rate"]) == (704, 1280, 241, 24)
    [c] = kw["conditions"]
    assert c.frame_index == 0 and c.image.size == (704, 1280) and "slowly" in kw["prompt"]
    meta = probe(out.path)
    assert (meta["width"], meta["height"], meta["nb_frames"]) == (720, 1280, "241")
    with pytest.raises(EngineError):
        ltx_video.plan("image_to_video", VIDEO_916_720, set(), 40)


def test_wan_5b_one_checkpoint_for_text_and_image(tmp_path: Path) -> None:
    eng = build_engines("wan-5b")[0]
    assert "first_last_frame" not in eng.capabilities
    eng.load()
    ctx, _ = make_ctx(tmp_path, {"image": png(tmp_path, "src")})
    [out] = eng.run("image_to_video", {**VIDEO_916_720, "prompt": "smile", "duration": 5}, ctx)
    name, kw = calls[-1]
    assert name == "WanImageToVideoPipeline" and (kw["width"], kw["height"], kw["num_frames"]) == (704, 1280, 121)
    assert probe(out.path)["r_frame_rate"] == "24/1"
    ctx2, _ = make_ctx(tmp_path, {})
    eng.run("text_to_video", {**VIDEO_916_720, "prompt": "city"}, ctx2)
    assert calls[-1][0] == "WanPipeline"
    assert loads == ["WanImageToVideoPipeline"]  # text-to-video reuses the loaded weights
    assert eng.pipes["i2v"].loaded_with["vae"][2] == "fp32"
    with pytest.raises(EngineError):
        wan.plan("first_last_frame", VIDEO_916_720, {"image", "end_image"}, 30, wan.VARIANTS["wan-5b"])


# ----------------------------------------------------------------------------- Qwen


def test_qwen_image_text_and_variation(tmp_path: Path) -> None:
    eng = qwen_image.create("qwen-image")
    eng.load()
    ctx, _ = make_ctx(tmp_path, {})
    outs = eng.run("text_to_image", {"target": {"width": 1024, "height": 1536}, "prompt": "poster", "numOutputs": 3, "guidance": 5}, ctx)
    name, kw = calls[-1]
    assert name == "QwenImagePipeline" and kw["true_cfg_scale"] == 4.0 and len(outs) == 3
    assert Image.open(outs[0].path).size == (1024, 1536)
    ctx2, _ = make_ctx(tmp_path, {"source": png(tmp_path, "s")})
    eng.run("variation", {"target": {"width": 1024, "height": 1024}, "variationLevel": "strong"}, ctx2)
    assert calls[-1][0] == "QwenImageImg2ImgPipeline" and calls[-1][1]["strength"] == 0.75


def test_qwen_edit_keeps_source_proportions_and_passes_references(tmp_path: Path) -> None:
    eng = qwen_image.create("qwen-image-edit")
    eng.load()
    files = {"source": png(tmp_path, "s", (800, 1200)), "reference_0": png(tmp_path, "r0"), "reference_1": png(tmp_path, "r1")}
    ctx, _ = make_ctx(tmp_path, files)
    params = {"target": {"width": 1024, "height": 1024}, "instruction": "Change le texte en NX STUDIO", "intent": {"type": "text", "targetRatio": None}}
    eng.run("edit", params, ctx)
    name, kw = calls[-1]
    assert name == "QwenImageEditPlusPipeline" and kw["prompt"] == "Change le texte en NX STUDIO"
    assert len(kw["image"]) == 3 and abs(kw["width"] / kw["height"] - 800 / 1200) < 0.02


def test_qwen_inpaint_and_outpaint(tmp_path: Path) -> None:
    eng = qwen_image.create("qwen-image-edit")
    eng.load()
    mask = tmp_path / "mask.png"
    Image.new("L", (640, 960), 0).save(mask)
    ctx, _ = make_ctx(tmp_path, {"source": png(tmp_path, "s"), "mask": mask})
    eng.run("inpaint", {"target": {"width": 1024, "height": 1024}, "prompt": "a red hat"}, ctx)
    assert calls[-1][0] == "QwenImageEditInpaintPipeline" and calls[-1][1]["mask_image"].mode == "L"
    ctx2, _ = make_ctx(tmp_path, {"source": png(tmp_path, "s")})
    eng.run("outpaint", {"target": {"width": 1024, "height": 1024}, "outpaint": {"targetRatio": "16:9"}}, ctx2)
    kw = calls[-1][1]
    assert kw["image"].size == (1707, 960)  # 640x960 widened to 16:9
    assert kw["mask_image"].getpixel((0, 0)) == 255 and kw["mask_image"].getpixel((853, 480)) == 0
    assert abs(kw["width"] / kw["height"] - 16 / 9) < 0.03


# ----------------------------------------------------------------------------- FLUX


def test_flux_distilled_steps_and_edit(tmp_path: Path) -> None:
    eng = flux.create("flux")
    eng.load()
    ctx, _ = make_ctx(tmp_path, {})
    outs = eng.run("text_to_image", {"target": {"width": 1024, "height": 1024}, "prompt": "a cat", "numOutputs": 2}, ctx)
    kw = calls[-1][1]
    assert kw["num_inference_steps"] == 4 and kw["guidance_scale"] == 1.0 and kw["image"] is None and len(outs) == 2
    ctx2, _ = make_ctx(tmp_path, {"source": png(tmp_path, "s"), "reference_0": png(tmp_path, "r")})
    eng.run("edit", {"target": {"width": 1024, "height": 1024}, "instruction": "put the jacket from image 2 on the person"}, ctx2)
    kw = calls[-1][1]
    assert len(kw["image"]) == 2 and kw["prompt"].startswith("put the jacket")
    with pytest.raises(EngineError):
        flux.plan("inpaint", {}, {"source"}, True, 50, 4)


# ----------------------------------------------------------------------------- Real-ESRGAN


def test_upscale_sizes_and_tiles_cover_image() -> None:
    assert upscale.output_size({"upscale": {"factor": 2}}, 640, 480) == (1280, 960)
    assert upscale.output_size({"upscale": {"targetWidth": 3000}}, 1000, 500) == (3000, 1500)
    covered = np.zeros((700, 1100), dtype=int)
    for (x0, y0, x1, y1), (px0, py0, px1, py1) in upscale.tiles(1100, 700, 512):
        covered[y0:y1, x0:x1] += 1
        assert px0 <= x0 and py0 <= y0 and px1 >= x1 and py1 >= y1
    assert (covered == 1).all()


# ----------------------------------------------------------------------------- registry


def test_real_engines_build_without_torch_and_fail_load_cleanly(monkeypatch: pytest.MonkeyPatch) -> None:
    """On a machine without the GPU stack, the server still starts and reports which engines failed."""
    from fastapi.testclient import TestClient

    from nx_gpu.server import create_app

    monkeypatch.delitem(sys.modules, "diffusers")
    monkeypatch.setitem(sys.modules, "diffusers", None)  # import diffusers -> ImportError
    engines = build_engines("ltx,fake:wan")
    client = TestClient(create_app(engines, token="", load=True))
    h = client.get("/v1/health").json()
    assert [e["id"] for e in h["engines"]] == ["wan"]
    assert h["failed_engines"][0]["id"] == "ltx" and "diffusers" in h["failed_engines"][0]["error"]
