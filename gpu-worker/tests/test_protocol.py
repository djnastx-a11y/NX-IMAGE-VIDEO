import json
import os
import subprocess
import time
from pathlib import Path

os.environ.setdefault("NX_FAKE_SECONDS", "0.3")

from fastapi.testclient import TestClient  # noqa: E402

from nx_gpu.engines import build_engines  # noqa: E402
from nx_gpu.server import create_app  # noqa: E402

TOKEN = "test-token"
AUTH = {"authorization": f"Bearer {TOKEN}"}


def make_client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(build_engines("fake:wan,fake:flux,fake:real-esrgan"), tmp_path, TOKEN))


def wait(c: TestClient, job_id: str, timeout: float = 30) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        st = c.get(f"/v1/jobs/{job_id}", headers=AUTH).json()
        if st["status"] in ("completed", "failed", "cancelled"):
            return st
        time.sleep(0.05)
    raise TimeoutError(job_id)


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", str(path)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_auth_required(tmp_path):
    c = make_client(tmp_path)
    assert c.get("/v1/health").status_code == 401
    assert c.get("/v1/health", headers={"authorization": "Bearer nope"}).status_code == 401
    h = c.get("/v1/health", headers=AUTH).json()
    assert h["ok"] is True
    assert {e["id"] for e in h["engines"]} == {"wan", "flux", "real-esrgan"}


def test_text_to_video_and_download(tmp_path):
    c = make_client(tmp_path)
    params = {"prompt": "drone over a beach", "duration": 2, "fps": 24, "seed": 7, "target": {"width": 360, "height": 640}}
    r = c.post("/v1/jobs", headers=AUTH, data={"engine": "wan", "operation": "text_to_video", "params": json.dumps(params)})
    assert r.status_code == 200, r.text
    st = wait(c, r.json()["id"])
    assert st["status"] == "completed", st
    assert st["outputs"] == [{"index": 0, "seed": 7, "mime": "video/mp4"}]
    f = tmp_path / "dl.mp4"
    f.write_bytes(c.get(f"/v1/jobs/{st['id']}/outputs/0", headers=AUTH).content)
    info = probe(f)
    assert (info["streams"][0]["width"], info["streams"][0]["height"]) == (360, 640)
    assert abs(float(info["format"]["duration"]) - 2) < 0.2


def test_image_inputs_multiple_outputs_and_upscale(tmp_path):
    c = make_client(tmp_path)
    src = tmp_path / "src.png"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240", "-frames:v", "1", str(src)], check=True)
    r = c.post("/v1/jobs", headers=AUTH, data={"engine": "flux", "operation": "image_to_image", "params": json.dumps({"prompt": "x", "numOutputs": 3, "seed": 10})}, files={"source": ("src.png", src.read_bytes(), "image/png")})
    st = wait(c, r.json()["id"])
    assert st["status"] == "completed"
    assert [o["seed"] for o in st["outputs"]] == [10, 11, 12]
    r = c.post("/v1/jobs", headers=AUTH, data={"engine": "real-esrgan", "operation": "upscale", "params": json.dumps({"upscale": {"factor": 2}})}, files={"source": ("src.png", src.read_bytes(), "image/png")})
    st = wait(c, r.json()["id"])
    up = tmp_path / "up.png"
    up.write_bytes(c.get(f"/v1/jobs/{st['id']}/outputs/0", headers=AUTH).content)
    assert probe(up)["streams"][0]["width"] == 640


def test_rejects_unknown_engine_or_operation(tmp_path):
    c = make_client(tmp_path)
    assert c.post("/v1/jobs", headers=AUTH, data={"engine": "nope", "operation": "text_to_video"}).status_code == 400
    assert c.post("/v1/jobs", headers=AUTH, data={"engine": "wan", "operation": "video_to_video"}).status_code == 400


def test_failures_and_cancel(tmp_path):
    c = make_client(tmp_path)
    r = c.post("/v1/jobs", headers=AUTH, data={"engine": "wan", "operation": "text_to_video", "params": json.dumps({"prompt": "boom #fail", "duration": 1})})
    st = wait(c, r.json()["id"])
    assert st["status"] == "failed" and st["retryable"] is False and "#fail" in st["error"]
    r = c.post("/v1/jobs", headers=AUTH, data={"engine": "wan", "operation": "text_to_video", "params": json.dumps({"prompt": "#oom", "duration": 1})})
    st = wait(c, r.json()["id"])
    assert st["status"] == "failed" and st["retryable"] is True
    os.environ["NX_FAKE_SECONDS"] = "0.3"
    r = c.post("/v1/jobs", headers=AUTH, data={"engine": "wan", "operation": "text_to_video", "params": json.dumps({"prompt": "long", "duration": 1})})
    job_id = r.json()["id"]
    while c.get(f"/v1/jobs/{job_id}", headers=AUTH).json()["status"] != "running":
        time.sleep(0.01)
    assert c.post(f"/v1/jobs/{job_id}/cancel", headers=AUTH).json() == {"ok": True}
    assert wait(c, job_id)["status"] == "cancelled"
    assert c.get(f"/v1/jobs/{job_id}/outputs/0", headers=AUTH).status_code == 404
