"""Helpers shared by the real (diffusers) engines.

Everything here that does not touch torch is plain Python so it can be unit-tested without a GPU.
"""

from __future__ import annotations

import os
import random
import subprocess
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

from PIL import Image, ImageOps

from .base import Cancelled, EngineError, JobContext


def env(name: str, default: str) -> str:
    return os.environ.get(name) or default


def env_int(name: str, default: int) -> int:
    return int(os.environ.get(name) or default)


def resolve_seed(seed: Any) -> int:
    return int(seed) if seed is not None else random.randint(0, 2**31 - 1)


def round_to(value: float, multiple: int, minimum: int | None = None) -> int:
    return max(minimum or multiple, int(round(value / multiple)) * multiple)


def frame_count(duration: float, fps: float, step: int) -> int:
    """Frames for `duration` seconds when the model needs `step * k + 1` frames (LTX: 8, Wan: 4)."""
    return round_to(duration * fps, step) + 1


def target_size(params: dict[str, Any], multiple: int) -> tuple[int, int, int, int]:
    """(width, height) requested by NX STUDIO and the nearest size the model accepts."""
    t = params.get("target") or {}
    w, h = int(t.get("width") or 1024), int(t.get("height") or 1024)
    return w, h, round_to(w, multiple), round_to(h, multiple)


# Camera moves are expressed in the prompt: the open video models follow camera language well,
# and no camera LoRA is needed for that. Intensity 0..10 picks the wording.
CAMERA_TEXT = {
    "static": "static camera, locked-off shot",
    "zoom_in": "the camera zooms in",
    "zoom_out": "the camera zooms out",
    "pan_left": "the camera pans left",
    "pan_right": "the camera pans right",
    "tilt_up": "the camera tilts up",
    "tilt_down": "the camera tilts down",
    "dolly_in": "the camera dollies in toward the subject",
    "dolly_out": "the camera dollies out away from the subject",
    "orbit_left": "the camera orbits left around the subject",
    "orbit_right": "the camera orbits right around the subject",
    "tracking": "tracking shot, the camera follows the subject",
    "drone": "aerial drone shot, the camera glides forward and rises",
    "crane": "crane shot, the camera rises smoothly",
    "handheld": "handheld camera with natural shake",
}


def camera_phrase(camera: dict[str, Any] | None) -> str:
    move = (camera or {}).get("move") or "static"
    text = CAMERA_TEXT.get(move)
    if not text or move == "static":
        return text or ""
    intensity = float((camera or {}).get("intensity", 5))
    pace = "slowly and subtly" if intensity <= 3 else "smoothly" if intensity <= 7 else "fast, dramatic movement"
    return f"{text} {pace}"


def video_prompt(params: dict[str, Any]) -> str:
    parts = [str(params.get("prompt") or "").strip()]
    cam = camera_phrase(params.get("camera"))
    if cam:
        parts.append(cam)
    motion = float(params.get("motionStrength", 0.5))
    if motion <= 0.2:
        parts.append("minimal motion")
    elif motion >= 0.8:
        parts.append("lots of dynamic motion")
    return ". ".join(p for p in parts if p)


def scaled_guidance(value: Any, ui_default: float, model_default: float, lo: float, hi: float) -> float:
    """Maps NX STUDIO's guidance slider onto a model's own scale, so the UI default gives the model default."""
    v = float(value if value is not None else ui_default)
    return max(lo, min(hi, model_default * v / ui_default))


def load_rgb(path: Path) -> Image.Image:
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    return img.convert("RGB")


def fit_cover(img: Image.Image, width: int, height: int) -> Image.Image:
    """Resize and centre-crop to exactly width x height (the source keeps its proportions)."""
    return ImageOps.fit(img, (width, height), Image.Resampling.LANCZOS)


def area_fit(width: int, height: int, area: int, multiple: int) -> tuple[int, int]:
    """A size with the proportions of width x height and about `area` pixels."""
    ratio = width / height
    h = (area / ratio) ** 0.5
    return round_to(h * ratio, multiple), round_to(h, multiple)


def _ffmpeg(args: list[str], stdin: bytes | None = None) -> bytes:
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], input=stdin, capture_output=True)
    if r.returncode != 0:
        raise EngineError(f"ffmpeg failed: {r.stderr.decode(errors='replace')[-400:]}")
    return r.stdout


def write_video(frames: Any, fps: float, out: Path, width: int, height: int) -> Path:
    """Encodes frames (array F x H x W x 3, floats 0..1 or uint8, or a list of PIL images) to an H.264 MP4
    of exactly width x height."""
    import numpy as np

    if isinstance(frames, list):
        arr = np.stack([np.asarray(f.convert("RGB")) for f in frames])
    else:
        arr = np.asarray(frames)
        if arr.ndim == 5:  # batch of one
            arr = arr[0]
        if arr.dtype != np.uint8:
            arr = (np.clip(arr, 0.0, 1.0) * 255).round().astype(np.uint8)
    n, h, w, _ = arr.shape
    vf = f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,crop={width}:{height},format=yuv420p"
    _ffmpeg(
        ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", f"{fps:g}", "-i", "-", "-vf", vf, "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-movflags", "+faststart", str(out)],
        stdin=arr.tobytes(),
    )
    return out


def read_video(path: Path, width: int, height: int, fps: float, max_frames: int) -> list[Image.Image]:
    """Decodes up to max_frames frames, resampled to fps and cropped to width x height."""
    vf = f"fps={fps:g},scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}"
    raw = _ffmpeg(["-i", str(path), "-vf", vf, "-frames:v", str(max_frames), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    size = width * height * 3
    return [Image.frombytes("RGB", (width, height), raw[i : i + size]) for i in range(0, len(raw) - size + 1, size)]


def save_png(img: Image.Image, path: Path) -> Path:
    img.save(path, format="PNG")
    return path


# --------------------------------------------------------------------------- torch side


def torch_dtype() -> Any:
    """bfloat16 where the GPU supports it natively (Ampere and later), float16 otherwise (T4, V100).
    NX_GPU_DTYPE=bf16|fp16 forces one."""
    import torch

    forced = env("NX_GPU_DTYPE", "")
    if forced:
        return torch.float16 if forced == "fp16" else torch.bfloat16
    return torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported(including_emulation=False) else torch.float16


def place(pipe: Any) -> Any:
    """Puts a pipeline on the GPU. NX_GPU_OFFLOAD: "none" (all in VRAM, fastest), "model" (default:
    each sub-model moves to the GPU only while it runs) or "sequential" (lowest VRAM, slowest)."""
    mode = env("NX_GPU_OFFLOAD", "model")
    if mode == "none":
        return pipe.to("cuda")
    if mode == "sequential":
        pipe.enable_sequential_cpu_offload()
    else:
        pipe.enable_model_cpu_offload()
    return pipe


def generator(seed: int) -> Any:
    import torch

    return torch.Generator(device="cpu").manual_seed(seed)


def step_callback(ctx: JobContext, total: int, start: float = 0.0, end: float = 1.0) -> Callable[..., dict[str, Any]]:
    """diffusers callback_on_step_end: reports progress and stops the pipeline when the job is cancelled."""

    def cb(_pipe: Any, step: int, _timestep: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
        ctx.progress(start + (end - start) * (step + 1) / max(1, total), f"Step {step + 1}/{total}")
        return kwargs

    return cb


@contextmanager
def gpu_errors() -> Iterator[None]:
    """Turns CUDA out-of-memory into a retryable EngineError and frees the cache."""
    import torch

    try:
        yield
    except (Cancelled, EngineError):
        raise
    except torch.cuda.OutOfMemoryError as e:
        torch.cuda.empty_cache()
        raise EngineError(f"CUDA out of memory: {str(e).splitlines()[0][:200]}", retryable=True) from e
    finally:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
