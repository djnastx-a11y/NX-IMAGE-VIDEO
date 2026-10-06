"""Qwen-Image and Qwen-Image-Edit (Alibaba, Apache-2.0) through diffusers.

qwen-image       (NX_QWEN_IMAGE_MODEL, default Qwen/Qwen-Image)
  text_to_image    QwenImagePipeline
  image_to_image   QwenImageImg2ImgPipeline (same weights)
  variation        image_to_image with a strength set by the variation level

qwen-image-edit  (NX_QWEN_EDIT_MODEL, default Qwen/Qwen-Image-Edit-2511)
  edit             QwenImageEditPlusPipeline: the instruction as written, the source image first,
                   then the reference images (character, style, object)
  inpaint          QwenImageEditInpaintPipeline (same weights): only the white part of the mask changes
  outpaint         the same inpaint pipeline on a canvas extended by the requested margins

Steps: NX_QWEN_STEPS (default 40).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from PIL import Image

from ._common import (
    area_fit,
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

SPECS: dict[str, tuple[list[str], dict[str, Any]]] = {
    "qwen-image": (["text_to_image", "image_to_image", "variation", "negative_prompt", "seed", "guidance", "steps", "custom_size", "multi_output"], {"maxOutputs": 4}),
    "qwen-image-edit": (["edit", "inpaint", "outpaint", "seed", "guidance", "steps", "reference_image", "multi_reference", "character_reference"], {"maxOutputs": 2}),
}
VARIATION_STRENGTH = {"subtle": 0.35, "medium": 0.55, "strong": 0.75}
OUTPAINT_PROMPT = "Extend the scene naturally beyond the original borders, same style, lighting and perspective."


@dataclass
class Plan:
    pipeline: str  # "t2i" | "i2i" | "edit" | "inpaint"
    prompt: str
    negative_prompt: str
    width: int
    height: int
    steps: int
    true_cfg_scale: float
    num_images: int
    seed: int
    strength: float | None = None
    images: list[str] = field(default_factory=list)  # file fields, source first
    mask: str | None = None
    outpaint: dict[str, int] | None = None


def outpaint_margins(params: dict[str, Any], src_w: int, src_h: int) -> dict[str, int]:
    """Pixels to add on each side: explicit margins, or what reaches the target ratio (centred)."""
    o = params.get("outpaint") or {}
    m = {k: int(o.get(k) or 0) for k in ("top", "bottom", "left", "right")}
    ratio = o.get("targetRatio")
    if ratio and not any(m.values()):
        rw, rh = (int(x) for x in str(ratio).split(":"))
        if src_w / src_h < rw / rh:
            extra = round(src_h * rw / rh) - src_w
            m["left"], m["right"] = extra // 2, extra - extra // 2
        else:
            extra = round(src_w * rh / rw) - src_h
            m["top"], m["bottom"] = extra // 2, extra - extra // 2
    if not any(m.values()):
        raise EngineError("outpaint needs margins or a target ratio")
    return m


def plan(engine: str, operation: str, params: dict[str, Any], files: set[str], steps: int, source_size: tuple[int, int] | None = None) -> Plan:
    out_w, out_h, w, h = target_size(params, 16)
    n = max(1, min(SPECS[engine][1]["maxOutputs"], int(params.get("numOutputs") or 1)))
    base = dict(
        prompt=str(params.get("prompt") or ""),
        negative_prompt=str(params.get("negativePrompt") or "") or " ",
        width=w,
        height=h,
        steps=int(params.get("steps") or steps),
        true_cfg_scale=round(scaled_guidance(params.get("guidance"), 5.0, 4.0, 1.0, 10.0), 3),
        num_images=n,
        seed=resolve_seed(params.get("seed")),
    )
    if operation not in SPECS[engine][0]:
        raise EngineError(f"{engine} does not support '{operation}'")
    needs_source = operation != "text_to_image"
    if needs_source and "source" not in files:
        raise EngineError(f"{operation} needs a source image")
    refs = sorted((f for f in files if f.startswith("reference_")), key=lambda f: int(f.split("_")[1]))

    if operation == "text_to_image":
        return Plan(pipeline="t2i", **base)
    if operation in ("image_to_image", "variation"):
        strength = float(params.get("strength", 0.55)) if operation == "image_to_image" else VARIATION_STRENGTH.get(str(params.get("variationLevel")), 0.55)
        return Plan(pipeline="i2i", strength=strength, images=["source"], **base)

    # Edit-family: keep the source's proportions unless the instruction asks for another frame.
    if source_size and not ((params.get("intent") or {}).get("targetRatio")):
        sw, sh = source_size
        base["width"], base["height"] = area_fit(sw, sh, w * h, 16)
    if operation == "edit":
        base["prompt"] = str(params.get("instruction") or params.get("prompt") or "")
        if not base["prompt"]:
            raise EngineError("edit needs an instruction")
        return Plan(pipeline="edit", images=["source", *refs[:2]], **base)
    if operation == "inpaint":
        if "mask" not in files:
            raise EngineError("inpaint needs a mask")
        return Plan(pipeline="inpaint", strength=1.0, images=["source"], mask="mask", **base)
    # outpaint
    sw, sh = source_size or (out_w, out_h)
    m = outpaint_margins(params, sw, sh)
    canvas_w, canvas_h = sw + m["left"] + m["right"], sh + m["top"] + m["bottom"]
    base["width"], base["height"] = area_fit(canvas_w, canvas_h, max(w * h, sw * sh), 16)
    base["prompt"] = f"{base['prompt']}. {OUTPAINT_PROMPT}".lstrip(". ")
    return Plan(pipeline="inpaint", strength=1.0, images=["source"], outpaint=m, **base)


def outpaint_canvas(src: Image.Image, m: dict[str, int]) -> tuple[Image.Image, Image.Image]:
    """The source on a larger canvas (edges stretched as a starting point) and the mask of the new area."""
    w, h = src.width + m["left"] + m["right"], src.height + m["top"] + m["bottom"]
    canvas = src.resize((w, h), Image.Resampling.BICUBIC)
    canvas.paste(src, (m["left"], m["top"]))
    mask = Image.new("L", (w, h), 255)
    mask.paste(0, (m["left"], m["top"], m["left"] + src.width, m["top"] + src.height))
    return canvas, mask


class QwenImageEngine(Engine):
    def __init__(self, engine_id: str):
        caps, limits = SPECS[engine_id]
        super().__init__(id=engine_id, module="image", capabilities=list(caps), limits=dict(limits))
        default = "Qwen/Qwen-Image" if engine_id == "qwen-image" else "Qwen/Qwen-Image-Edit-2511"
        self.model = env("NX_QWEN_IMAGE_MODEL" if engine_id == "qwen-image" else "NX_QWEN_EDIT_MODEL", default)
        self.steps = env_int("NX_QWEN_STEPS", 40)
        self.pipes: dict[str, Any] = {}

    def load(self) -> None:
        import diffusers as d

        if self.id == "qwen-image":
            main = place(d.QwenImagePipeline.from_pretrained(self.model, torch_dtype=torch_dtype()))
            self.pipes = {"t2i": main, "i2i": d.QwenImageImg2ImgPipeline.from_pipe(main)}
        else:
            main = place(d.QwenImageEditPlusPipeline.from_pretrained(self.model, torch_dtype=torch_dtype()))
            self.pipes = {"edit": main, "inpaint": d.QwenImageEditInpaintPipeline.from_pipe(main)}
        self.loaded = True

    def run(self, operation: str, params: dict[str, Any], ctx: JobContext) -> list[Output]:
        src_path = ctx.file("source")
        src = load_rgb(src_path) if src_path else None
        p = plan(self.id, operation, params, set(ctx.files), self.steps, src.size if src else None)
        kwargs: dict[str, Any] = dict(
            prompt=p.prompt,
            negative_prompt=p.negative_prompt,
            true_cfg_scale=p.true_cfg_scale,
            width=p.width,
            height=p.height,
            num_inference_steps=p.steps,
            num_images_per_prompt=p.num_images,
            generator=generator(p.seed),
            callback_on_step_end=step_callback(ctx, p.steps, 0.0, 0.95),
        )
        if p.pipeline == "i2i":
            kwargs.update(image=src, strength=p.strength)
        elif p.pipeline == "edit":
            kwargs["image"] = [load_rgb(ctx.file(f)) for f in p.images]  # type: ignore[arg-type]
        elif p.pipeline == "inpaint":
            assert src is not None
            if p.outpaint:
                image, mask = outpaint_canvas(src, p.outpaint)
            else:
                image, mask = src, Image.open(ctx.file(p.mask)).convert("L")  # type: ignore[arg-type]
            kwargs.update(image=image, mask_image=mask, strength=p.strength)
        ctx.progress(0.0, "Generating")
        with gpu_errors():
            images = self.pipes[p.pipeline](**kwargs).images
        return [Output(path=save_png(img, ctx.work_dir / f"out_{i}.png"), seed=p.seed, mime="image/png") for i, img in enumerate(images)]


def create(engine_id: str) -> Engine:
    return QwenImageEngine(engine_id)

