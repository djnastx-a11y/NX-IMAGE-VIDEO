"""LTX-Video 2B (Lightricks) through diffusers' LTXConditionPipeline: the small LTX, made for 16 GB
GPUs such as Kaggle's free T4.

  text_to_video     no condition
  image_to_video    the image at frame 0 (also used by Extend)
  first_last_frame  first image at frame 0, last image at the last frame, keyframes in between
  video_to_video    the source video as condition, at strength `videoStrength`

Weights: NX_LTXV_MODEL (default Lightricks/LTX-Video-0.9.5, 2B, diffusers format).
Steps: NX_LTXV_STEPS (default 40). 24 fps, up to 10 s (241 frames).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ._common import (
    env,
    env_int,
    fit_cover,
    frame_count,
    generator,
    gpu_errors,
    load_rgb,
    place,
    read_video,
    resolve_seed,
    scaled_guidance,
    step_callback,
    target_size,
    torch_dtype,
    video_prompt,
    write_video,
)
from .base import Engine, EngineError, JobContext, Output
from .ltx import DEFAULT_NEGATIVE, round_index

CAPABILITIES = ["text_to_video", "image_to_video", "video_to_video", "first_last_frame", "keyframes", "extend", "camera_control", "negative_prompt", "seed"]
LIMITS = {"maxDuration": 10, "durations": [5, 10], "resolutions": ["480p", "720p"]}
FPS = 24.0


@dataclass
class Cond:
    kind: str  # "image" | "video"
    field: str
    frame_index: int  # -1 = last frame
    strength: float


@dataclass
class Plan:
    prompt: str
    negative_prompt: str
    width: int
    height: int
    out_width: int
    out_height: int
    num_frames: int
    guidance_scale: float
    steps: int
    seed: int
    conditions: list[Cond]


def plan(operation: str, params: dict[str, Any], files: set[str], steps: int) -> Plan:
    out_w, out_h, w, h = target_size(params, 32)
    duration = float(max(1, min(LIMITS["maxDuration"], params.get("duration") or 5)))
    frames = frame_count(duration, FPS, 8)
    fidelity = float(params.get("sourceFidelity", 0.7))
    conds: list[Cond] = []
    if operation == "image_to_video":
        if "image" not in files:
            raise EngineError("image_to_video needs an image")
        conds.append(Cond("image", "image", 0, round(0.6 + 0.4 * fidelity, 3)))
    elif operation == "first_last_frame":
        kfs = [k for k in sorted(params.get("keyframes") or [], key=lambda k: k.get("position", 0)) if k.get("field") in files]
        if len(kfs) >= 2:
            conds += [Cond("image", k["field"], -1 if float(k.get("position", 0)) >= 1 else round_index(float(k.get("position", 0)), frames), 1.0) for k in kfs]
        elif "image" in files and "end_image" in files:
            conds += [Cond("image", "image", 0, 1.0), Cond("image", "end_image", -1, 1.0)]
        else:
            raise EngineError("first_last_frame needs a first and a last image")
    elif operation == "video_to_video":
        if "video" not in files:
            raise EngineError("video_to_video needs a video")
        conds.append(Cond("video", "video", 0, round(float(params.get("videoStrength", 0.6)), 3)))
    elif operation != "text_to_video":
        raise EngineError(f"LTX-Video does not support '{operation}'")
    return Plan(
        prompt=video_prompt(params),
        negative_prompt=str(params.get("negativePrompt") or "") or DEFAULT_NEGATIVE,
        width=w,
        height=h,
        out_width=out_w,
        out_height=out_h,
        num_frames=frames,
        guidance_scale=round(scaled_guidance(params.get("promptAdherence"), 7.0, 3.0, 1.0, 6.0), 3),
        steps=steps,
        seed=resolve_seed(params.get("seed")),
        conditions=conds,
    )


class LtxVideoEngine(Engine):
    def __init__(self, engine_id: str):
        super().__init__(id=engine_id, module="video", capabilities=list(CAPABILITIES), limits=dict(LIMITS))
        self.model = env("NX_LTXV_MODEL", "Lightricks/LTX-Video-0.9.5")
        self.steps = env_int("NX_LTXV_STEPS", 40)
        self.pipe: Any = None

    def load(self) -> None:
        from diffusers import LTXConditionPipeline

        self.pipe = place(LTXConditionPipeline.from_pretrained(self.model, torch_dtype=torch_dtype()))
        self.pipe.vae.enable_tiling()  # decodes long clips within 16 GB
        self.loaded = True

    def run(self, operation: str, params: dict[str, Any], ctx: JobContext) -> list[Output]:
        from diffusers.pipelines.ltx.pipeline_ltx_condition import LTXVideoCondition

        p = plan(operation, params, set(ctx.files), self.steps)
        conditions = []
        for c in p.conditions:
            path = ctx.file(c.field)
            assert path is not None
            if c.kind == "image":
                conditions.append(LTXVideoCondition(image=fit_cover(load_rgb(path), p.width, p.height), frame_index=c.frame_index, strength=c.strength))
            else:
                conditions.append(LTXVideoCondition(video=read_video(path, p.width, p.height, FPS, p.num_frames), frame_index=c.frame_index, strength=c.strength))
        ctx.progress(0.0, "Generating")
        with gpu_errors():
            frames = self.pipe(
                conditions=conditions or None,
                prompt=p.prompt,
                negative_prompt=p.negative_prompt,
                width=p.width,
                height=p.height,
                num_frames=p.num_frames,
                frame_rate=int(FPS),
                num_inference_steps=p.steps,
                guidance_scale=p.guidance_scale,
                decode_timestep=0.05,
                decode_noise_scale=0.025,
                generator=generator(p.seed),
                output_type="np",
                callback_on_step_end=step_callback(ctx, p.steps, 0.0, 0.95),
            ).frames
        out = write_video(frames, FPS, ctx.work_dir / "out.mp4", p.out_width, p.out_height)
        return [Output(path=out, seed=p.seed, mime="video/mp4")]


def create(engine_id: str) -> Engine:
    return LtxVideoEngine(engine_id)
