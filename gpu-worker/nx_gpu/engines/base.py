"""Engine contract for the NX GPU worker.

An engine wraps one model family (Wan, FLUX, Qwen-Image...). The server calls `load()` once,
then `run()` for each job, on a single executor thread so the GPU is never shared by two jobs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


class EngineError(Exception):
    """A generation failure. `retryable` tells NX STUDIO whether trying again may succeed (OOM, timeout...)."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class Cancelled(Exception):
    """Raised inside an engine when the job was cancelled; the server marks the job cancelled."""


@dataclass
class JobContext:
    job_id: str
    work_dir: Path
    files: dict[str, Path]
    _progress: Callable[[float, str | None], None]
    _cancelled: Callable[[], bool]

    def progress(self, value: float, stage: str | None = None) -> None:
        """Report progress in [0, 1] (the share of the model's own work) and raise if the job was cancelled."""
        self._progress(max(0.0, min(1.0, value)), stage)
        self.check()

    def check(self) -> None:
        if self._cancelled():
            raise Cancelled()

    def file(self, name: str) -> Path | None:
        return self.files.get(name)


@dataclass
class Output:
    path: Path
    seed: int | None = None
    mime: str = "image/png"


@dataclass
class Engine:
    """Base class. Subclasses set id/module/capabilities/limits and implement load() and run()."""

    id: str
    module: str  # "image" | "video"
    capabilities: list[str] = field(default_factory=list)
    limits: dict[str, Any] = field(default_factory=dict)
    loaded: bool = False

    def load(self) -> None:  # pragma: no cover - real engines download/load weights here
        self.loaded = True

    def run(self, operation: str, params: dict[str, Any], ctx: JobContext) -> list[Output]:
        raise NotImplementedError

    def info(self) -> dict[str, Any]:
        return {"id": self.id, "module": self.module, "capabilities": self.capabilities, "limits": self.limits, "loaded": self.loaded}
