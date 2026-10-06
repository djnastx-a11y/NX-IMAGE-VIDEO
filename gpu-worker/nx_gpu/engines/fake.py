"""Fake engines: speak the full protocol without a GPU or model weights.

They stand in for real engines (same ids, same capabilities) so the whole chain
NX STUDIO → GPU endpoint → outputs can be tested anywhere. Outputs are drawn with ffmpeg.

Test hooks in the prompt: "#fail" (permanent error), "#oom" (retryable error), "#slow" (5x longer).
"""

from __future__ import annotations

import os
import random
import subprocess
import time
from typing import Any

from .base import Engine, EngineError, JobContext, Output

# Same ids as NX STUDIO's engine catalog, so a fake endpoint looks exactly like a real one.
FAKE_SPECS: dict[str, tuple[str, list[str], dict[str, Any]]] = {
    "wan": ("video", ["text_to_video", "image_to_video", "first_last_frame", "extend", "camera_control", "negative_prompt", "seed"], {"maxDuration": 5, "durations": [5], "resolutions": ["480p", "720p"]}),
    "ltx": ("video", ["text_to_video", "image_to_video", "video_to_video", "first_last_frame", "keyframes", "extend", "camera_control", "negative_prompt", "seed", "fps"], {"maxDuration": 20, "durations": [5, 10, 15, 20], "resolutions": ["480p", "720p", "1080p"]}),
    "hunyuan": ("video", ["text_to_video", "image_to_video", "negative_prompt", "seed"], {"maxDuration": 5, "resolutions": ["480p", "720p"]}),
    "flux": ("image", ["text_to_image", "image_to_image", "edit", "variation", "seed", "guidance", "steps", "custom_size", "multi_output", "reference_image", "multi_reference", "style_reference"], {"maxOutputs": 4}),
    "qwen-image": ("image", ["text_to_image", "image_to_image", "variation", "negative_prompt", "seed", "guidance", "steps", "custom_size", "multi_output"], {"maxOutputs": 4}),
    "qwen-image-edit": ("image", ["edit", "inpaint", "outpaint", "seed", "guidance", "steps", "reference_image"], {"maxOutputs": 2}),
    "real-esrgan": ("image", ["upscale"], {}),
}

SECONDS = float(os.environ.get("NX_FAKE_SECONDS", "2"))


def _ffmpeg(args: list[str]) -> None:
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise EngineError(f"ffmpeg failed: {r.stderr[-400:]}")


class FakeEngine(Engine):
    def __init__(self, engine_id: str):
        module, caps, limits = FAKE_SPECS[engine_id]
        super().__init__(id=engine_id, module=module, capabilities=caps, limits=limits)

    def load(self) -> None:
        self.loaded = True

    def _work(self, ctx: JobContext, slow: bool, steps: int = 10) -> None:
        for i in range(steps):
            time.sleep(SECONDS * (5 if slow else 1) / steps)
            ctx.progress((i + 1) / steps, f"fake step {i + 1}/{steps}")

    def run(self, operation: str, params: dict[str, Any], ctx: JobContext) -> list[Output]:
        prompt = str(params.get("prompt") or params.get("instruction") or "")
        if "#fail" in prompt:
            ctx.progress(0.2, "about to fail")
            raise EngineError("Simulated engine failure (#fail)")
        if "#oom" in prompt:
            raise EngineError("CUDA out of memory (simulated #oom)", retryable=True)
        target = params.get("target") or {}
        w, h = int(target.get("width") or 1024), int(target.get("height") or 1024)
        w, h = w - w % 2, h - h % 2
        seed = params.get("seed")
        seed = int(seed) if seed is not None else random.randint(0, 2**31 - 1)
        self._work(ctx, "#slow" in prompt)
        if self.module == "video":
            return [self._video(operation, params, ctx, w, h, seed)]
        count = int(params.get("numOutputs") or 1) if operation in ("text_to_image", "image_to_image", "variation") else 1
        return [self._image(operation, params, ctx, w, h, seed + n, n) for n in range(count)]

    def _label(self, text: str) -> str:
        return text.replace("\\", "").replace(":", " ").replace("'", " ")[:60]

    def _image(self, operation: str, params: dict[str, Any], ctx: JobContext, w: int, h: int, seed: int, n: int) -> Output:
        out = ctx.work_dir / f"out_{n}.png"
        src = ctx.file("source")
        label = self._label(f"{self.id} {operation} seed {seed}")
        draw = f"drawbox=x=0:y=0:w=iw:h=40:color=black@0.6:t=fill,drawtext=text='{label}':x=12:y=12:fontsize=18:fontcolor=white"
        if operation == "upscale" and src:
            factor = int((params.get("upscale") or {}).get("factor") or 2)
            _ffmpeg(["-i", str(src), "-vf", f"scale=iw*{factor}:ih*{factor}:flags=lanczos", "-frames:v", "1", str(out)])
        elif src:
            hue = seed % 360
            _ffmpeg(["-i", str(src), "-vf", f"hue=h={hue},{draw}", "-frames:v", "1", str(out)])
        else:
            _ffmpeg(["-f", "lavfi", "-i", f"gradients=s={w}x{h}:seed={seed % 100000}:n=3", "-vf", draw, "-frames:v", "1", str(out)])
        return Output(path=out, seed=seed, mime="image/png")

    def _video(self, operation: str, params: dict[str, Any], ctx: JobContext, w: int, h: int, seed: int) -> Output:
        out = ctx.work_dir / "out.mp4"
        dur = float(params.get("duration") or 5)
        fps = int(params.get("fps") or 24)
        label = self._label(f"{self.id} {operation} seed {seed}")
        draw = f"drawbox=x=0:y=0:w=iw:h=40:color=black@0.6:t=fill,drawtext=text='{label}':x=12:y=12:fontsize=18:fontcolor=white"
        image = ctx.file("image") or ctx.file("keyframe_0")
        video = ctx.file("video")
        if video:
            inp = ["-i", str(video), "-t", str(dur)]
            vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},hue=h={seed % 360},{draw}"
        elif image:
            inp = ["-loop", "1", "-framerate", str(fps), "-t", str(dur), "-i", str(image)]
            vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},zoompan=z='1+0.0015*on':d=1:s={w}x{h}:fps={fps},{draw}"
        else:
            inp = ["-f", "lavfi", "-t", str(dur), "-i", f"gradients=s={w}x{h}:r={fps}:seed={seed % 100000}:speed=0.02"]
            vf = draw
        _ffmpeg([*inp, "-vf", vf, "-r", str(fps), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", str(out)])
        return Output(path=out, seed=seed, mime="video/mp4")
