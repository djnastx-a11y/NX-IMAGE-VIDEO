"""FLUX.2 [klein] 4B (Black Forest Labs, Apache-2.0) through diffusers' Flux2KleinPipeline.

FLUX.2 has no strength-based img2img: every image-conditioned operation passes the images as
references and lets the prompt say what to do with them.
  text_to_image    prompt only
  image_to_image   source image as reference + prompt
  variation        source image as reference + "a variation of this image"
  edit             source image first, then the reference images, + the instruction

Weights: NX_FLUX_MODEL (default black-forest-labs/FLUX.2-klein-4B). A step-distilled checkpoint
runs in NX_FLUX_STEPS_DISTILLED steps (default 4), otherwise NX_FLUX_STEPS (default 50).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ._common import (
    env,
    env_int,
    generator,
    gpu_errors,
    load_rgb,
    place,
    resolve_seed,
    save_png,
    scaled_guidance,
    step_callback,
    target_size,
    torch_dtype,
)
from .base import Engine, EngineError, JobContext, Output

CAPABILITIES = ["text_to_image", "image_to_image", "edit", "variation", "seed", "guidance", "steps", "custom_size", "multi_output", "reference_image", "multi_reference", "style_reference"]
LIMITS = {"maxOutputs": 4}
VARIATION_PROMPT = {
    "subtle": "A subtle variation of this image: same subject, composition and style, small changes in details.",
    "medium": "A variation of this image: same subject and style, a different take on pose, framing and details.",
    "strong": "A loose reinterpretation of this image: same subject, new composition, lighting and details.",
}


@dataclass
class Plan:
    prompt: str
    width: int
    height: int
    steps: int
    guidance_scale: float
    num_images: int
    seed: int
    images: list[str] = field(default_factory=list)


def plan(operation: str, params: dict[str, Any], files: set[str], distilled: bool, steps: int, distilled_steps: int) -> Plan:
    if operation not in CAPABILITIES[:4]:
        raise EngineError(f"FLUX.2 klein does not support '{operation}'")
    _, _, w, h = target_size(params, 16)
    refs = sorted((f for f in files if f.startswith("reference_")), key=lambda f: int(f.split("_")[1]))
    prompt = str(params.get("prompt") or "")
    images: list[str] = []
    if operation != "text_to_image":
        if "source" not in files:
            raise EngineError(f"{operation} needs a source image")
        images = ["source", *refs]
    elif refs:
        images = refs
    if operation == "variation":
        prompt = " ".join(x for x in (VARIATION_PROMPT.get(str(params.get("variationLevel")), VARIATION_PROMPT["medium"]), prompt) if x)
    elif operation == "edit":
        prompt = str(params.get("instruction") or prompt)
    if not prompt:
        raise EngineError("A prompt is required")
    return Plan(
        prompt=prompt,
        width=w,
        height=h,
        steps=int(params.get("steps") or (distilled_steps if distilled else steps)),
        guidance_scale=1.0 if distilled else round(scaled_guidance(params.get("guidance"), 5.0, 4.0, 1.0, 10.0), 3),
        num_images=max(1, min(LIMITS["maxOutputs"], int(params.get("numOutputs") or 1))),
        seed=resolve_seed(params.get("seed")),
        images=images[:4],
    )


class FluxEngine(Engine):
    def __init__(self, engine_id: str):
        super().__init__(id=engine_id, module="image", capabilities=list(CAPABILITIES), limits=dict(LIMITS))
        self.model = env("NX_FLUX_MODEL", "black-forest-labs/FLUX.2-klein-4B")
        self.steps = env_int("NX_FLUX_STEPS", 50)
        self.distilled_steps = env_int("NX_FLUX_STEPS_DISTILLED", 4)
        self.pipe: Any = None

    def load(self) -> None:
        from diffusers import Flux2KleinPipeline

        self.pipe = place(Flux2KleinPipeline.from_pretrained(self.model, torch_dtype=torch_dtype()))
        self.loaded = True

    def run(self, operation: str, params: dict[str, Any], ctx: JobContext) -> list[Output]:
        distilled = bool(getattr(self.pipe.config, "is_distilled", False))
        p = plan(operation, params, set(ctx.files), distilled, self.steps, self.distilled_steps)
        images = [load_rgb(ctx.file(f)) for f in p.images]  # type: ignore[arg-type]
        ctx.progress(0.0, "Generating")
        with gpu_errors():
            out = self.pipe(
                image=images or None,
                prompt=p.prompt,
                width=p.width,
                height=p.height,
                num_inference_steps=p.steps,
                guidance_scale=p.guidance_scale,
                num_images_per_prompt=p.num_images,
                generator=generator(p.seed),
                callback_on_step_end=step_callback(ctx, p.steps, 0.0, 0.95),
            ).images
        return [Output(path=save_png(img, ctx.work_dir / f"out_{i}.png"), seed=p.seed, mime="image/png") for i, img in enumerate(out)]


def create(engine_id: str) -> Engine:
    return FluxEngine(engine_id)
