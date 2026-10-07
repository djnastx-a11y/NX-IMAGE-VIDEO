"""GPU agent: runs the engines on a machine with no public address (Kaggle, a home PC) by connecting
out to NX STUDIO and pulling work. The engines are the same as the HTTP server's.

    NX_URL=https://studio.example.com NX_GPU_AGENT_TOKEN=... NX_ENGINES=ltx-video,flux python -m nx_gpu.agent

NX STUDIO side: declare the agent in NX_GPU_AGENTS (id, tokenEnv, engines). See docs/GPU_WORKERS.md.
Standard library only for HTTP, so it runs in any notebook.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import ssl
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from . import __version__
from .engines import build_engines
from .engines.base import Cancelled, Engine, EngineError, JobContext
from .server import gpu_name, jlog

HEARTBEAT_SEC = 10
PROGRESS_MIN_INTERVAL = 1.0


class AgentError(Exception):
    pass


class Api:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self.headers = {"Authorization": f"Bearer {token}"}
        self.ssl = ssl.create_default_context()

    def _open(self, method: str, path: str, data: bytes | None = None, headers: dict[str, str] | None = None, timeout: float = 30) -> bytes:
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={**self.headers, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self.ssl) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            raise AgentError(f"{method} {path}: HTTP {e.code} {body}") from e

    def post(self, path: str, body: dict[str, Any] | None = None, timeout: float = 30) -> Any:
        raw = self._open("POST", path, json.dumps(body or {}).encode(), {"Content-Type": "application/json"}, timeout)
        return json.loads(raw or b"{}")

    def download(self, path: str, dest: Path) -> Path:
        req = urllib.request.Request(self.base + path, headers=self.headers)
        with urllib.request.urlopen(req, timeout=300, context=self.ssl) as r, dest.open("wb") as f:
            shutil.copyfileobj(r, f)
        return dest

    def upload(self, path: str, file: Path, mime: str) -> Any:
        boundary = uuid.uuid4().hex
        head = f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file.name}"\r\nContent-Type: {mime}\r\n\r\n'.encode()
        body = head + file.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        return json.loads(self._open("POST", path, body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=600))


class Agent:
    def __init__(self, api: Api, engines: list[Engine], data_dir: Path):
        self.api = api
        self.engines = {e.id: e for e in engines}
        self.data_dir = data_dir
        self.gpu = gpu_name()
        self.load_errors: dict[str, str] = {}
        self.load_locks = {e.id: threading.Lock() for e in engines}
        self.stop = threading.Event()

    # -- engines
    def ensure_loaded(self, engine: Engine) -> None:
        with self.load_locks[engine.id]:
            if not engine.loaded:
                engine.load()
                self.load_errors.pop(engine.id, None)

    def load_all(self) -> None:
        for e in self.engines.values():
            try:
                t = time.time()
                self.ensure_loaded(e)
                jlog(logging.INFO, "engine loaded", engine=e.id, seconds=round(time.time() - t, 1))
            except Exception as err:
                self.load_errors[e.id] = str(err)
                jlog(logging.ERROR, "engine failed to load", engine=e.id, error=str(err))
            self.heartbeat()

    # -- heartbeat
    def heartbeat(self) -> None:
        infos = [e.info() | ({"error": self.load_errors[e.id]} if e.id in self.load_errors else {}) for e in self.engines.values()]
        try:
            self.api.post(
                "/api/gpu-agent/heartbeat",
                {"gpu": self.gpu, "version": __version__, "engines": [i for i in infos if "error" not in i], "failed_engines": [i for i in infos if "error" in i]},
                timeout=15,
            )
        except Exception as err:
            jlog(logging.WARNING, "heartbeat failed", error=str(err))

    def _heartbeat_loop(self) -> None:
        while not self.stop.wait(HEARTBEAT_SEC):
            self.heartbeat()

    # -- tasks
    def run_task(self, task: dict[str, Any]) -> None:
        tid = task["id"]
        engine = self.engines.get(task["engine"])
        work = self.data_dir / tid
        work.mkdir(parents=True, exist_ok=True)
        cancelled = threading.Event()
        last = [0.0]

        def report(p: float, stage: str | None) -> None:
            now = time.time()
            if now - last[0] < PROGRESS_MIN_INTERVAL and p < 1:
                return
            last[0] = now
            try:
                if self.api.post(f"/api/gpu-agent/tasks/{tid}/progress", {"progress": round(p, 4), "stage": stage}, timeout=15).get("cancel"):
                    cancelled.set()
            except Exception as err:
                if "HTTP 404" in str(err):  # NX STUDIO dropped the task (cancelled, or the job gave up)
                    cancelled.set()

        started = time.time()
        try:
            if not engine:
                raise EngineError(f"Engine '{task['engine']}' is not served by this agent")
            report(0.0, "Downloading inputs")
            files = {f: self.api.download(f"/api/gpu-agent/tasks/{tid}/files/{f}", work / f"in_{f}") for f in task.get("files", [])}
            if not engine.loaded:
                report(0.0, "Loading model")
            self.ensure_loaded(engine)
            ctx = JobContext(job_id=tid, work_dir=work, files=files, _progress=report, _cancelled=cancelled.is_set)
            ctx.check()
            outputs = engine.run(task["operation"], task["params"], ctx)
            if not outputs:
                raise EngineError("Engine produced no output")
            report(1.0, "Uploading")
            for i, o in enumerate(outputs):
                q = f"index={i}&mime={o.mime}" + (f"&seed={o.seed}" if o.seed is not None else "")
                self.api.upload(f"/api/gpu-agent/tasks/{tid}/outputs?{q}", o.path, o.mime)
            self.api.post(f"/api/gpu-agent/tasks/{tid}/complete")
            jlog(logging.INFO, "task completed", task=tid, job=task.get("job_id"), engine=task["engine"], seconds=round(time.time() - started, 1))
        except Cancelled:
            self._fail(tid, cancelled=True)
            jlog(logging.INFO, "task cancelled", task=tid)
        except EngineError as err:
            self._fail(tid, str(err), err.retryable)
            jlog(logging.WARNING, "task failed", task=tid, error=str(err), retryable=err.retryable)
        except Exception as err:
            msg = f"{type(err).__name__}: {err}"
            self._fail(tid, msg, "out of memory" in msg.lower() or isinstance(err, (AgentError, OSError)))
            jlog(logging.ERROR, "task crashed", task=tid, error=msg, trace=traceback.format_exc()[-2000:])
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _fail(self, tid: str, error: str = "", retryable: bool = False, cancelled: bool = False) -> None:
        try:
            self.api.post(f"/api/gpu-agent/tasks/{tid}/fail", {"error": error[:4000] or "GPU agent error", "retryable": retryable, "cancelled": cancelled})
        except Exception as err:
            jlog(logging.WARNING, "could not report failure", task=tid, error=str(err))

    def run_forever(self, preload: bool = True) -> None:
        self.heartbeat()
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()
        if preload:
            threading.Thread(target=self.load_all, daemon=True).start()
        jlog(logging.INFO, "agent started", url=self.api.base, engines=list(self.engines), gpu=self.gpu)
        backoff = 1.0
        while not self.stop.is_set():
            try:
                task = self.api.post("/api/gpu-agent/claim", {"wait": 20}, timeout=40).get("task")
                backoff = 1.0
            except Exception as err:
                jlog(logging.WARNING, "cannot reach NX STUDIO", error=str(err), retry_in=backoff)
                self.stop.wait(backoff)
                backoff = min(backoff * 2, 30)
                continue
            if task:
                self.run_task(task)


def main() -> None:
    url, token = os.environ.get("NX_URL", ""), os.environ.get("NX_GPU_AGENT_TOKEN", "")
    if not url or not token:
        raise SystemExit("Set NX_URL (NX STUDIO address) and NX_GPU_AGENT_TOKEN")
    engines = build_engines(os.environ.get("NX_ENGINES", ""))
    if not engines:
        raise SystemExit("Set NX_ENGINES, e.g. ltx-video,flux")
    agent = Agent(Api(url, token), engines, Path(os.environ.get("NX_GPU_DATA_DIR", "/tmp/nx-gpu-agent")))
    try:
        agent.run_forever(preload=os.environ.get("NX_GPU_PRELOAD", "1") != "0")
    except KeyboardInterrupt:
        agent.stop.set()


if __name__ == "__main__":
    main()
