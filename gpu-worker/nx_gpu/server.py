"""HTTP server for the NX GPU protocol (see docs/GPU_WORKERS.md).

    GET  /v1/health                 -> { ok, gpu, engines: [{ id, module, capabilities, limits, loaded }] }
    POST /v1/jobs   (multipart)     -> { id }    fields: engine, operation, job_id, params (JSON), files...
    GET  /v1/jobs/{id}              -> { id, status, stage, progress, error, retryable, outputs: [{ index, seed, mime }] }
    POST /v1/jobs/{id}/cancel       -> { ok }
    GET  /v1/jobs/{id}/outputs/{n}  -> file

Jobs run one at a time per GPU (NX_GPU_CONCURRENCY), in submission order.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import queue
import re
import shutil
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse

from . import __version__
from .engines import build_engines
from .engines.base import Cancelled, Engine, EngineError, JobContext, Output

log = logging.getLogger("nx_gpu")
logging.basicConfig(level=os.environ.get("NX_GPU_LOG_LEVEL", "INFO"), format='{"time":"%(asctime)s","level":"%(levelname)s","msg":%(message)s}')


def jlog(level: int, msg: str, **data: Any) -> None:
    log.log(level, json.dumps({"message": msg, **data}))


@dataclass
class Job:
    id: str
    engine: str
    operation: str
    params: dict[str, Any]
    work_dir: Path
    files: dict[str, Path]
    nx_job_id: str | None = None
    status: str = "queued"  # queued | running | completed | failed | cancelled
    stage: str | None = None
    progress: float = 0.0
    error: str | None = None
    retryable: bool = False
    outputs: list[Output] = field(default_factory=list)
    cancel_requested: bool = False
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None

    def view(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "stage": self.stage,
            "progress": round(self.progress, 4),
            "error": self.error,
            "retryable": self.retryable,
            "outputs": [{"index": i, "seed": o.seed, "mime": o.mime} for i, o in enumerate(self.outputs)],
        }


def gpu_name() -> str:
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            return f"{torch.cuda.get_device_name(0)} ({torch.cuda.get_device_properties(0).total_memory // 2**30} GB)"
        return "no CUDA device"
    except ImportError:
        return "cpu (torch not installed)"


class Worker:
    def __init__(self, engines: list[Engine], data_dir: Path, concurrency: int = 1, ttl_seconds: int = 3600):
        self.engines = {e.id: e for e in engines}
        self.data_dir = data_dir
        self.jobs: dict[str, Job] = {}
        self.queue: queue.Queue[str] = queue.Queue()
        self.lock = threading.Lock()
        self.ttl = ttl_seconds
        self.gpu = gpu_name()
        self.load_errors: dict[str, str] = {}
        for _ in range(concurrency):
            threading.Thread(target=self._loop, daemon=True).start()
        threading.Thread(target=self._janitor, daemon=True).start()

    def load_all(self) -> None:
        for e in self.engines.values():
            try:
                t = time.time()
                e.load()
                jlog(logging.INFO, "engine loaded", engine=e.id, seconds=round(time.time() - t, 1))
            except Exception as err:  # keep serving the other engines
                self.load_errors[e.id] = str(err)
                jlog(logging.ERROR, "engine failed to load", engine=e.id, error=str(err))

    def submit(self, job: Job) -> None:
        with self.lock:
            self.jobs[job.id] = job
        self.queue.put(job.id)
        jlog(logging.INFO, "job queued", job=job.id, nx_job=job.nx_job_id, engine=job.engine, operation=job.operation)

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        job.cancel_requested = True
        if job.status == "queued":
            self._finish(job, "cancelled")
        return True

    def _finish(self, job: Job, status: str) -> None:
        job.status = status
        job.finished_at = time.time()

    def _loop(self) -> None:
        while True:
            job_id = self.queue.get()
            job = self.jobs.get(job_id)
            if not job or job.status != "queued":
                continue
            engine = self.engines[job.engine]
            job.status, job.stage = "running", "Loading model" if not engine.loaded else "Generating"
            started = time.time()

            def report(p: float, stage: str | None, job: Job = job) -> None:
                job.progress = p
                if stage:
                    job.stage = stage

            ctx = JobContext(job_id=job.id, work_dir=job.work_dir, files=job.files, _progress=report, _cancelled=lambda job=job: job.cancel_requested)
            try:
                if not engine.loaded:
                    engine.load()
                ctx.check()
                job.outputs = engine.run(job.operation, job.params, ctx)
                if not job.outputs:
                    raise EngineError("Engine produced no output")
                job.progress = 1.0
                self._finish(job, "completed")
                jlog(logging.INFO, "job completed", job=job.id, nx_job=job.nx_job_id, engine=job.engine, seconds=round(time.time() - started, 1))
            except Cancelled:
                self._finish(job, "cancelled")
                jlog(logging.INFO, "job cancelled", job=job.id, engine=job.engine)
            except EngineError as err:
                job.error, job.retryable = str(err), err.retryable
                self._finish(job, "failed")
                jlog(logging.WARNING, "job failed", job=job.id, engine=job.engine, error=str(err), retryable=err.retryable)
            except Exception as err:
                # CUDA OOM and similar runtime errors are worth one more try on NX STUDIO's side
                job.error = f"{type(err).__name__}: {err}"
                job.retryable = "out of memory" in str(err).lower()
                self._finish(job, "failed")
                jlog(logging.ERROR, "job crashed", job=job.id, engine=job.engine, error=job.error, trace=traceback.format_exc()[-2000:])

    def _janitor(self) -> None:
        while True:
            time.sleep(60)
            now = time.time()
            for job in list(self.jobs.values()):
                if job.finished_at and now - job.finished_at > self.ttl:
                    shutil.rmtree(job.work_dir, ignore_errors=True)
                    self.jobs.pop(job.id, None)


SAFE_FIELD = re.compile(r"^[a-z][a-z0-9_]{0,40}$")


def create_app(engines: list[Engine] | None = None, data_dir: Path | None = None, token: str | None = None, load: bool = True) -> FastAPI:
    engines = engines if engines is not None else build_engines(os.environ.get("NX_ENGINES", ""))
    data_dir = data_dir or Path(os.environ.get("NX_GPU_DATA_DIR", "/tmp/nx-gpu"))
    data_dir.mkdir(parents=True, exist_ok=True)
    token = token if token is not None else os.environ.get("NX_GPU_TOKEN", "")
    max_upload = int(os.environ.get("NX_GPU_MAX_UPLOAD_MB", "500")) * 2**20
    worker = Worker(engines, data_dir, int(os.environ.get("NX_GPU_CONCURRENCY", "1")), int(os.environ.get("NX_GPU_JOB_TTL", "3600")))
    if load and os.environ.get("NX_GPU_PRELOAD", "1") != "0":
        threading.Thread(target=worker.load_all, daemon=True).start()

    app = FastAPI(title="NX GPU worker", version=__version__)
    app.state.worker = worker

    def auth(request: Request) -> None:
        if not token:
            return
        given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(given.encode(), token.encode()):
            raise HTTPException(401, "Invalid token")

    @app.get("/v1/health", dependencies=[Depends(auth)])
    def health() -> dict[str, Any]:
        engines_info = []
        for e in worker.engines.values():
            info = e.info()
            if e.id in worker.load_errors:
                info["error"] = worker.load_errors[e.id]
            engines_info.append(info)
        busy = sum(1 for j in worker.jobs.values() if j.status in ("queued", "running"))
        return {"ok": True, "version": __version__, "gpu": worker.gpu, "queue": busy, "engines": [i for i in engines_info if "error" not in i], "failed_engines": [i for i in engines_info if "error" in i]}

    @app.post("/v1/jobs", dependencies=[Depends(auth)])
    async def create_job(request: Request) -> dict[str, str]:
        if int(request.headers.get("content-length") or 0) > max_upload:
            raise HTTPException(413, "Upload too large")
        form = await request.form()
        engine = str(form.get("engine") or "")
        operation = str(form.get("operation") or "")
        if engine not in worker.engines:
            raise HTTPException(400, f"Engine '{engine}' is not served here")
        if operation not in worker.engines[engine].capabilities:
            raise HTTPException(400, f"Engine '{engine}' does not support '{operation}'")
        try:
            params = json.loads(str(form.get("params") or "{}"))
        except json.JSONDecodeError:
            raise HTTPException(400, "params must be JSON")
        job_id = uuid.uuid4().hex
        work_dir = data_dir / job_id
        work_dir.mkdir(parents=True)
        files: dict[str, Path] = {}
        for name, value in form.multi_items():
            if hasattr(value, "read") and hasattr(value, "filename"):
                if not SAFE_FIELD.match(name):
                    raise HTTPException(400, f"Bad file field '{name}'")
                ext = Path(value.filename or "").suffix.lower()[:6]
                ext = ext if re.match(r"^\.[a-z0-9]+$", ext) else ""
                dest = work_dir / f"in_{name}{ext}"
                with dest.open("wb") as f:
                    shutil.copyfileobj(value.file, f)
                files[name] = dest
        job = Job(id=job_id, engine=engine, operation=operation, params=params, work_dir=work_dir, files=files, nx_job_id=str(form.get("job_id") or "") or None)
        worker.submit(job)
        return {"id": job_id}

    def get(job_id: str) -> Job:
        job = worker.jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Unknown job")
        return job

    @app.get("/v1/jobs/{job_id}", dependencies=[Depends(auth)])
    def job_status(job_id: str) -> dict[str, Any]:
        return get(job_id).view()

    @app.post("/v1/jobs/{job_id}/cancel", dependencies=[Depends(auth)])
    def cancel(job_id: str) -> dict[str, bool]:
        get(job_id)
        return {"ok": worker.cancel(job_id)}

    @app.get("/v1/jobs/{job_id}/outputs/{index}", dependencies=[Depends(auth)])
    def output(job_id: str, index: int) -> FileResponse:
        job = get(job_id)
        if job.status != "completed" or not 0 <= index < len(job.outputs):
            raise HTTPException(404, "No such output")
        o = job.outputs[index]
        return FileResponse(o.path, media_type=o.mime)

    return app


def main() -> None:
    import uvicorn

    uvicorn.run(create_app(), host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8188")), log_level="warning")


if __name__ == "__main__":
    main()
