"""Real-ESRGAN x4 (BSD-3) loaded with spandrel (MIT).

The image goes through the network in tiles (NX_ESRGAN_TILE, default 512 px) so any size fits in
memory, then it is resized to the requested factor or width.
Weights: NX_ESRGAN_WEIGHTS (a local .pth), or downloaded once from the official release into
NX_GPU_MODELS_DIR (default ~/.cache/nx-gpu).
"""

from __future__ import annotations

import urllib.request
from pathlib import Path
from typing import Any, Iterator

from PIL import Image

from ._common import env, env_int, gpu_errors, load_rgb, save_png
from .base import Engine, EngineError, JobContext, Output

WEIGHTS_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
OVERLAP = 16


def output_size(params: dict[str, Any], width: int, height: int) -> tuple[int, int]:
    u = params.get("upscale") or {}
    target_w = u.get("targetWidth")
    if target_w:
        tw = int(target_w)
        return tw, max(1, round(height * tw / width))
    factor = int(u.get("factor") or 2)
    if factor not in (2, 4):
        raise EngineError("upscale factor must be 2 or 4")
    return width * factor, height * factor


def tiles(width: int, height: int, tile: int, overlap: int = OVERLAP) -> Iterator[tuple[tuple[int, int, int, int], tuple[int, int, int, int]]]:
    """(core box, padded box) for each tile; core boxes cover the image exactly once."""
    for y in range(0, height, tile):
        for x in range(0, width, tile):
            core = (x, y, min(x + tile, width), min(y + tile, height))
            pad = (max(0, core[0] - overlap), max(0, core[1] - overlap), min(width, core[2] + overlap), min(height, core[3] + overlap))
            yield core, pad


class UpscaleEngine(Engine):
    def __init__(self, engine_id: str):
        super().__init__(id=engine_id, module="image", capabilities=["upscale"], limits={})
        self.tile = env_int("NX_ESRGAN_TILE", 512)
        self.model: Any = None

    def _weights(self) -> Path:
        local = env("NX_ESRGAN_WEIGHTS", "")
        if local:
            return Path(local)
        path = Path(env("NX_GPU_MODELS_DIR", str(Path.home() / ".cache" / "nx-gpu"))) / "RealESRGAN_x4plus.pth"
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".part")
            urllib.request.urlretrieve(WEIGHTS_URL, tmp)
            tmp.rename(path)
        return path

    def load(self) -> None:
        from spandrel import ModelLoader

        self.model = ModelLoader().load_from_file(self._weights()).cuda().eval()
        self.loaded = True

    def run(self, operation: str, params: dict[str, Any], ctx: JobContext) -> list[Output]:
        import numpy as np
        import torch

        if operation != "upscale":
            raise EngineError(f"Real-ESRGAN does not support '{operation}'")
        src_path = ctx.file("source")
        if not src_path:
            raise EngineError("upscale needs a source image")
        src = load_rgb(src_path)
        out_w, out_h = output_size(params, src.width, src.height)
        scale = self.model.scale
        arr = np.asarray(src, dtype=np.float32) / 255.0
        result = np.zeros((src.height * scale, src.width * scale, 3), dtype=np.float32)
        boxes = list(tiles(src.width, src.height, self.tile))
        with gpu_errors(), torch.inference_mode():
            for i, (core, pad) in enumerate(boxes):
                x0, y0, x1, y1 = pad
                t = torch.from_numpy(arr[y0:y1, x0:x1]).permute(2, 0, 1)[None].cuda()
                up = self.model(t)[0].permute(1, 2, 0).clamp(0, 1).float().cpu().numpy()
                cx0, cy0, cx1, cy1 = core
                result[cy0 * scale : cy1 * scale, cx0 * scale : cx1 * scale] = up[(cy0 - y0) * scale : (cy1 - y0) * scale, (cx0 - x0) * scale : (cx1 - x0) * scale]
                ctx.progress((i + 1) / len(boxes) * 0.95, f"Tile {i + 1}/{len(boxes)}")
        img = Image.fromarray((result * 255).round().astype(np.uint8))
        if img.size != (out_w, out_h):
            img = img.resize((out_w, out_h), Image.Resampling.LANCZOS)
        return [Output(path=save_png(img, ctx.work_dir / "out_0.png"), seed=None, mime="image/png")]


def create(engine_id: str) -> Engine:
    return UpscaleEngine(engine_id)
