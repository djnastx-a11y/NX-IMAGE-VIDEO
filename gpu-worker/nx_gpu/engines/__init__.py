"""Engine registry. NX_ENGINES lists what this machine serves, e.g. "wan,flux" or "fake:wan,fake:flux"."""

from __future__ import annotations

import importlib

from .base import Engine

# engine id -> module in nx_gpu.engines that defines create() -> Engine
REAL_ENGINES = {
    "wan": "wan",
    "flux": "flux",
    "qwen-image": "qwen_image",
    "qwen-image-edit": "qwen_image",
    "ltx": "ltx",
    "ltx-video": "ltx_video",
    "wan-5b": "wan",
    "real-esrgan": "upscale",
}


def build_engines(spec: str) -> list[Engine]:
    engines: list[Engine] = []
    for raw in [s.strip() for s in spec.split(",") if s.strip()]:
        if raw.startswith("fake:"):
            from .fake import FakeEngine

            engines.append(FakeEngine(raw.removeprefix("fake:")))
            continue
        module = REAL_ENGINES.get(raw)
        if not module:
            raise ValueError(f"Unknown engine '{raw}'. Known: {', '.join(sorted(REAL_ENGINES))} (or fake:<id>)")
        engines.append(importlib.import_module(f"{__name__}.{module}").create(raw))
    return engines
