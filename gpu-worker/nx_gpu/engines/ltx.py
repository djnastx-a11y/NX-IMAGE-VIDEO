"""LTX-2.5 (Lightricks) through diffusers' LTX2ConditionPipeline.

One pipeline covers every video operation, through frame conditions:
  text_to_video     no condition
  image_to_video    the image at frame 0 (also used by Extend: NX STUDIO sends the last frame)
  first_last_frame  first image at frame 0, last image at the last frame, keyframes in between
  video_to_video    the source video as a multi-frame condition, at strength `videoStrength`

Weights: NX_LTX_MODEL (default Lightricks/LTX-2.5-Diffusers). Steps: NX_LTX_STEPS (default 30;
a distilled checkpoint needs about 8).
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

CAPABILITIES = ["text_to_video", "image_to_video", "video_to_video", "first_last_frame", "keyframes", "extend", "camera_control", "negative_prompt", "seed", "fps"]
LIMITS = {"maxDuration": 20, "durations": [5, 10, 15, 20], "resolutions": ["480p", "720p", "1080p"]}
DEFAULT_NEGATIVE = "worst quality, inconsistent motion, blurry, jittery, distorted"


@dataclass
class Cond:
    kind: str  # "image" | "video"
    field: str  # uploaded file field
    index: int  # frame index, -1 = last frame
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
    frame_rate: float
    guidance_scale: float
    steps: int
    seed: int
    conditions: list[Cond]


def plan(operation: str, params: dict[str, Any], files: set[str], steps: int) -> Plan:
    """Translates NX STUDIO parameters into an LTX-2 call (pure function, tested without a GPU)."""
    out_w, out_h, w, h = target_size(params, 32)
    fps = float(max(12, min(50, int(params.get("fps") or 24))))
    duration = float(max(1, min(LIMITS["maxDuration"], params.get("duration") or 5)))
    frames = frame_count(duration, fps, 8)
    fidelity = float(params.get("sourceFidelity", 0.7))
    conds: list[Cond] = []

    if operation == "image_to_video":
        if "image" not in files:
            raise EngineError("image_to_video needs an image")
        conds.append(Cond("image", "image", 0, round(0.6 + 0.4 * fidelity, 3)))
    elif operation == "first_last_frame":
        kfs = sorted(params.get("keyframes") or [], key=lambda k: k.get("position", 0))
        kfs = [k for k in kfs if k.get("field") in files]
        if len(kfs) >= 2:
            for k in kfs:
                pos = float(k.get("position", 0))
                idx = -1 if pos >= 1 else round_index(pos, frames)
                conds.append(Cond("image", k["field"], idx, 1.0))
        elif "image" in files and "end_image" in files:
            conds += [Cond("image", "image", 0, 1.0), Cond("image", "end_image", -1, 1.0)]
        else:
            raise EngineError("first_last_frame needs a first and a last image")
    elif operation == "video_to_video":
        if "video" not in files:
            raise EngineError("video_to_video needs a video")
        conds.append(Cond("video", "video", 0, round(float(params.get("videoStrength", 0.6)), 3)))
    elif operation != "text_to_video":
        raise EngineError(f"LTX does not support '{operation}'")

    return Plan(
        prompt=video_prompt(params),
        negative_prompt=str(params.get("negativePrompt") or "") or DEFAULT_NEGATIVE,
        width=w,
        height=h,
        out_width=out_w,
        out_height=out_h,
        num_frames=frames,
        frame_rate=fps,
        guidance_scale=round(scaled_guidance(params.get("promptAdherence"), 7.0, 3.0, 1.0, 6.0), 3),
        steps=steps,
        seed=resolve_seed(params.get("seed")),
        conditions=conds,
    )


def round_index(position: float, frames: int) -> int:
    """Frame index for a 0..1 position, on the 8-frame latent grid."""
    return min(frames - 1, int(round(position * (frames - 1) / 8)) * 8)


class LtxEngine(Engine):
    def __init__(self, engine_id: str):
        super().__init__(id=engine_id, module="video", capabilities=list(CAPABILITIES), limits=dict(LIMITS))
        self.model = env("NX_LTX_MODEL", "Lightricks/LTX-2.5-Diffusers")
        self.steps = env_int("NX_LTX_STEPS", 30)
        self.pipe: Any = None

    def load(self) -> None:
        from diffusers import LTX2ConditionPipeline

        self.pipe = place(LTX2ConditionPipeline.from_pretrained(self.model, torch_dtype=torch_dtype()))
        self.loaded = True

    def run(self, operation: str, params: dict[str, Any], ctx: JobContext) -> list[Output]:
        from diffusers.pipelines.ltx2.pipeline_ltx2_condition import LTX2VideoCondition

        p = plan(operation, params, set(ctx.files), self.steps)
        conditions = []
        for c in p.conditions:
            path = ctx.file(c.field)
            assert path is not None
            if c.kind == "image":
                frames: Any = fit_cover(load_rgb(path), p.width, p.height)
            else:
                frames = read_video(path, p.width, p.height, p.frame_rate, p.num_frames)
            conditions.append(LTX2VideoCondition(frames=frames, index=c.index, strength=c.strength))

        ctx.progress(0.0, "Generating")
        with gpu_errors():
            video, _audio = self.pipe(
                conditions=conditions or None,
                prompt=p.prompt,
                negative_prompt=p.negative_prompt,
                width=p.width,
                height=p.height,
                num_frames=p.num_frames,
                frame_rate=p.frame_rate,
                num_inference_steps=p.steps,
                guidance_scale=p.guidance_scale,
                generator=generator(p.seed),
                output_type="np",
                return_dict=False,
                callback_on_step_end=step_callback(ctx, p.steps, 0.0, 0.95),
            )
        out = write_video(video, p.frame_rate, ctx.work_dir / "out.mp4", p.out_width, p.out_height)
        return [Output(path=out, seed=p.seed, mime="video/mp4")]


def create(engine_id: str) -> Engine:
    return LtxEngine(engine_id)
