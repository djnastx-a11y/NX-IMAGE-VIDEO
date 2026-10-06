"""Measures a running NX GPU server: time per job, peak GPU memory, and output checks.

    python bench.py --url http://127.0.0.1:8188 --token $NX_GPU_TOKEN --image photo.jpg
    python bench.py --cases ltx-i2v-10s,qwen-edit --repeat 2 --out results.json

Runs the standard cases from docs/MODELS.md for every engine the server reports as loaded,
saves the outputs next to the JSON report so they can be compared by eye, and prints a table.
Standard library only, so it can run from any machine that reaches the server.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

PORTRAIT_720 = {"aspectRatio": "9:16", "resolution": "720p", "target": {"width": 720, "height": 1280}}

# id: (engine, operation, params, files)  files: field -> "image"
CASES: dict[str, tuple[str, str, dict[str, Any], dict[str, str]]] = {
    "ltx-i2v-5s": ("ltx", "image_to_video", {**PORTRAIT_720, "duration": 5, "fps": 24, "prompt": "the subject turns to the camera and smiles", "camera": {"move": "dolly_in", "intensity": 5}}, {"image": "image"}),
    "ltx-i2v-10s": ("ltx", "image_to_video", {**PORTRAIT_720, "duration": 10, "fps": 24, "prompt": "slow cinematic movement, natural motion", "camera": {"move": "orbit_right", "intensity": 6}}, {"image": "image"}),
    "ltx-t2v-5s": ("ltx", "text_to_video", {**PORTRAIT_720, "duration": 5, "fps": 24, "prompt": "a neon-lit street at night in the rain, reflections on the ground"}, {}),
    "wan-i2v-5s": ("wan", "image_to_video", {**PORTRAIT_720, "duration": 5, "prompt": "the subject turns to the camera and smiles", "camera": {"move": "dolly_in", "intensity": 5}}, {"image": "image"}),
    "qwen-edit": ("qwen-image-edit", "edit", {"target": {"width": 1024, "height": 1024}, "instruction": "Change the background to a night street in the rain, keep the person identical"}, {"source": "image"}),
    "qwen-t2i": ("qwen-image", "text_to_image", {"target": {"width": 1024, "height": 1536}, "prompt": "concert poster with the text NX STUDIO in bold letters"}, {}),
    "flux-t2i": ("flux", "text_to_image", {"target": {"width": 1024, "height": 1024}, "prompt": "studio portrait, soft light, 85mm"}, {}),
    "esrgan-x2": ("real-esrgan", "upscale", {"upscale": {"factor": 2}}, {"source": "image"}),
}


class Client:
    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}

    def _req(self, path: str, data: bytes | None = None, headers: dict[str, str] | None = None) -> bytes:
        req = urllib.request.Request(self.url + path, data=data, headers={**self.headers, **(headers or {})}, method="POST" if data is not None else "GET")
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()

    def get(self, path: str) -> Any:
        return json.loads(self._req(path))

    def submit(self, engine: str, operation: str, params: dict[str, Any], files: dict[str, Path]) -> str:
        boundary = uuid.uuid4().hex
        parts: list[bytes] = []
        for k, v in {"engine": engine, "operation": operation, "job_id": f"bench-{uuid.uuid4().hex[:8]}", "params": json.dumps(params)}.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        for field, path in files.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{path.name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + path.read_bytes() + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        return json.loads(self._req("/v1/jobs", b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={boundary}"}))["id"]

    def download(self, job_id: str, index: int, dest: Path) -> Path:
        dest.write_bytes(self._req(f"/v1/jobs/{job_id}/outputs/{index}"))
        return dest


class VramSampler:
    """Peak GPU memory via nvidia-smi, when the bench runs on the GPU machine itself."""

    def __init__(self) -> None:
        self.peak_mb: int | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> "VramSampler":
        if shutil.which("nvidia-smi"):
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()
        return self

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5).stdout
                used = max(int(x) for x in out.split())
                self.peak_mb = max(self.peak_mb or 0, used)
            except Exception:
                pass
            self._stop.wait(0.5)

    def stop(self) -> int | None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        return self.peak_mb


def probe(path: Path) -> str:
    if not shutil.which("ffprobe"):
        return ""
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames,r_frame_rate", "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    return r.stdout.strip()


def default_image(dest: Path) -> Path:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1920", "-frames:v", "1", str(dest)], check=True)
    return dest


def run_case(client: Client, case_id: str, image: Path, out_dir: Path) -> dict[str, Any]:
    engine, operation, params, file_spec = CASES[case_id]
    files = {field: image for field in file_spec}
    vram = VramSampler().start()
    t0 = time.time()
    job_id = client.submit(engine, operation, {**params, "seed": 1234}, files)
    started = None
    while True:
        st = client.get(f"/v1/jobs/{job_id}")
        if st["status"] == "running" and started is None:
            started = time.time()
        if st["status"] in ("completed", "failed", "cancelled"):
            break
        time.sleep(0.5)
    total = time.time() - t0
    peak = vram.stop()
    result: dict[str, Any] = {"case": case_id, "engine": engine, "status": st["status"], "seconds": round(total, 1), "queue_seconds": round((started or t0) - t0, 1), "peak_vram_mb": peak, "error": st.get("error")}
    if st["status"] == "completed":
        outs = []
        for o in st["outputs"]:
            ext = "mp4" if "video" in (o.get("mime") or "") else "png"
            path = client.download(job_id, o["index"], out_dir / f"{case_id}_{o['index']}.{ext}")
            outs.append({"file": path.name, "probe": probe(path)})
        result["outputs"] = outs
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:8188")
    ap.add_argument("--token", default="")
    ap.add_argument("--image", type=Path, help="source image for image-to-video, edit and upscale (default: a test pattern)")
    ap.add_argument("--cases", default="", help=f"comma-separated, default: every case whose engine is loaded ({', '.join(CASES)})")
    ap.add_argument("--repeat", type=int, default=1, help="runs per case (the first run includes model warm-up)")
    ap.add_argument("--out", type=Path, default=Path("bench-results/results.json"))
    args = ap.parse_args()

    client = Client(args.url, args.token)
    try:
        health = client.get("/v1/health")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{args.url}/v1/health: HTTP {e.code}" + (" (wrong or missing --token)" if e.code == 401 else ""))
    except OSError as e:
        raise SystemExit(f"cannot reach {args.url}: {e}")
    loaded = {e["id"] for e in health.get("engines", [])}
    cases = [c for c in (args.cases.split(",") if args.cases else CASES) if c]
    unknown = [c for c in cases if c not in CASES]
    if unknown:
        raise SystemExit(f"unknown case(s): {', '.join(unknown)}")
    cases = [c for c in cases if CASES[c][0] in loaded]
    if not cases:
        raise SystemExit(f"no case matches the loaded engines ({', '.join(sorted(loaded)) or 'none'})")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    image = args.image or default_image(args.out.parent / "source.png")

    print(f"GPU: {health.get('gpu')}  engines: {', '.join(sorted(loaded))}")
    results = []
    for case_id in cases:
        for n in range(args.repeat):
            r = run_case(client, case_id, image, args.out.parent)
            r["run"] = n + 1
            results.append(r)
            vram = f"{r['peak_vram_mb']} MB" if r["peak_vram_mb"] else "n/a"
            detail = ", ".join(o["probe"] for o in r.get("outputs", [])) or (r["error"] or "")
            print(f"{case_id:14} run {n + 1}  {r['status']:9} {r['seconds']:7.1f} s  VRAM {vram:>9}  {detail}")
    args.out.write_text(json.dumps({"gpu": health.get("gpu"), "server": args.url, "results": results}, indent=2))
    print(f"report: {args.out}")


if __name__ == "__main__":
    main()
