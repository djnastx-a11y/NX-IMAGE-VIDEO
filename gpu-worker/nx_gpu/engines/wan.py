"""Wan 2.2 A14B (Alibaba, Apache-2.0) through diffusers.

  text_to_video     WanPipeline             (NX_WAN_T2V_MODEL, default Wan-AI/Wan2.2-T2V-A14B-Diffusers)
  image_to_video    WanImageToVideoPipeline (NX_WAN_I2V_MODEL, default Wan-AI/Wan2.2-I2V-A14B-Diffusers)
  first_last_frame  WanImageToVideoPipeline with last_image
  extend            NX STUDIO sends it as image_to_video from the last frame

Wan renders about 5 s at 16 fps (81 frames). The two checkpoints are large, so only the one in use
stays loaded unless NX_WAN_KEEP_BOTH=1. Steps: NX_WAN_STEPS (default 40).
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
    resolve_seed,
    scaled_guidance,
    step_callback,
    target_size,
    torch_dtype,
    video_prompt,
    write_video,
)
from .base import Engine, EngineError, JobContext, Output

CAPABILITIES = ["text_to_video", "image_to_video", "first_last_frame", "extend", "camera_control", "negative_prompt", "seed"]
LIMITS = {"maxDuration": 5, "durations": [5], "resolutions": ["480p", "720p"]}
FPS = 16.0


@dataclass
class Plan:
    pipeline: str  # "t2v" | "i2v"
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
    image: str | None
    last_image: str | None


def plan(operation: str, params: dict[str, Any], files: set[str], steps: int) -> Plan:
    out_w, out_h, w, h = target_size(params, 16)
    duration = float(max(1, min(LIMITS["maxDuration"], params.get("duration") or 5)))
    image = last = None
    if operation == "text_to_video":
        pipeline = "t2v"
    elif operation == "image_to_video":
        if "image" not in files:
            raise EngineError("image_to_video needs an image")
        pipeline, image = "i2v", "image"
    elif operation == "first_last_frame":
        kfs = [k for k in sorted(params.get("keyframes") or [], key=lambda k: k.get("position", 0)) if k.get("field") in files]
        if len(kfs) >= 2:
            image, last = kfs[0]["field"], kfs[-1]["field"]
        elif "image" in files and "end_image" in files:
            image, last = "image", "end_image"
        else:
            raise EngineError("first_last_frame needs a first and a last image")
        pipeline = "i2v"
    else:
        raise EngineError(f"Wan does not support '{operation}'")
    return Plan(
        pipeline=pipeline,
        prompt=video_prompt(params),
        negative_prompt=str(params.get("negativePrompt") or ""),
        width=w,
        height=h,
        out_width=out_w,
        out_height=out_h,
        num_frames=frame_count(duration, FPS, 4),
        guidance_scale=round(scaled_guidance(params.get("promptAdherence"), 7.0, 5.0, 1.0, 10.0), 3),
        steps=steps,
        seed=resolve_seed(params.get("seed")),
        image=image,
        last_image=last,
    )


class WanEngine(Engine):
    def __init__(self, engine_id: str):
        super().__init__(id=engine_id, module="video", capabilities=list(CAPABILITIES), limits=dict(LIMITS))
        self.models = {"t2v": env("NX_WAN_T2V_MODEL", "Wan-AI/Wan2.2-T2V-A14B-Diffusers"), "i2v": env("NX_WAN_I2V_MODEL", "Wan-AI/Wan2.2-I2V-A14B-Diffusers")}
        self.steps = env_int("NX_WAN_STEPS", 40)
        self.keep_both = env("NX_WAN_KEEP_BOTH", "0") == "1"
        self.pipes: dict[str, Any] = {}

    def _pipe(self, kind: str) -> Any:
        if kind in self.pipes:
            return self.pipes[kind]
        import torch
        from diffusers import WanImageToVideoPipeline, WanPipeline

        if not self.keep_both and self.pipes:
            self.pipes.clear()
            torch.cuda.empty_cache()
        cls = WanImageToVideoPipeline if kind == "i2v" else WanPipeline
        self.pipes[kind] = place(cls.from_pretrained(self.models[kind], torch_dtype=torch_dtype()))
        return self.pipes[kind]

    def load(self) -> None:
        self._pipe("i2v")  # image → video is the main use
        self.loaded = True

    def run(self, operation: str, params: dict[str, Any], ctx: JobContext) -> list[Output]:
        p = plan(operation, params, set(ctx.files), self.steps)
        ctx.progress(0.0, "Loading model" if p.pipeline not in self.pipes else "Generating")
        with gpu_errors():
            pipe = self._pipe(p.pipeline)
            kwargs: dict[str, Any] = dict(
                prompt=p.prompt,
                negative_prompt=p.negative_prompt or None,
                width=p.width,
                height=p.height,
                num_frames=p.num_frames,
                num_inference_steps=p.steps,
                guidance_scale=p.guidance_scale,
                generator=generator(p.seed),
                output_type="np",
                callback_on_step_end=step_callback(ctx, p.steps, 0.0, 0.95),
            )
            if p.image:
                kwargs["image"] = fit_cover(load_rgb(ctx.file(p.image)), p.width, p.height)  # type: ignore[arg-type]
            if p.last_image:
                kwargs["last_image"] = fit_cover(load_rgb(ctx.file(p.last_image)), p.width, p.height)  # type: ignore[arg-type]
            frames = pipe(**kwargs).frames
        out = write_video(frames, FPS, ctx.work_dir / "out.mp4", p.out_width, p.out_height)
        return [Output(path=out, seed=p.seed, mime="video/mp4")]


def create(engine_id: str) -> Engine:
    return WanEngine(engine_id)
