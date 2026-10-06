import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, ProviderInfo } from "@nx/shared";
import { probe } from "../src/media/ffmpeg.js";
import { Client, makeFixtures, startHarness, waitFor, type Harness } from "./helpers.js";

/**
 * The whole remote chain: NX STUDIO → NX GPU protocol → the Python GPU worker (gpu-worker/),
 * running its fake engines (same ids and capabilities as the real ones, no GPU needed).
 * Mocks are disabled, so every job here really goes over HTTP to the worker.
 */
const WORKER_DIR = path.resolve(__dirname, "../../../gpu-worker");
const PYTHON = path.join(WORKER_DIR, ".venv/bin/python");
const hasWorker = fs.existsSync(PYTHON);
const PORT = 18188;
const TOKEN = "remote-test-token";

let gpu: ChildProcess;
let h: Harness;
let c: Client;
let fx: ReturnType<typeof makeFixtures>;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nx-remote-"));

async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("GPU worker did not start");
}

describe.skipIf(!hasWorker)("remote GPU endpoint (Python worker, fake engines)", () => {
  beforeAll(async () => {
    gpu = spawn(PYTHON, ["-m", "uvicorn", "nx_gpu.server:create_app", "--factory", "--port", String(PORT), "--log-level", "warning"], {
      cwd: WORKER_DIR,
      env: { ...process.env, NX_ENGINES: "fake:wan,fake:flux,fake:real-esrgan", NX_GPU_TOKEN: TOKEN, NX_FAKE_SECONDS: "1", NX_GPU_DATA_DIR: path.join(tmp, "gpu") },
      stdio: "ignore",
    });
    await waitHealthy();
    process.env.NX_TEST_GPU_TOKEN = TOKEN;
    h = await startHarness({
      NX_ENABLE_MOCK: "false",
      NX_GPU_ENDPOINTS: JSON.stringify([{ id: "testgpu", url: `http://127.0.0.1:${PORT}`, tokenEnv: "NX_TEST_GPU_TOKEN" }]),
    });
    fx = makeFixtures(tmp);
    c = new Client(h.app);
    await c.post("/api/auth/setup", { email: "jb@nx.studio", password: "correct-horse-battery", name: "Jb" });
    await c.patch("/api/admin/settings", { queue: { retryBackoffSec: 0, maxAttempts: 2 } });
    h.runner.start();
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    gpu?.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("discovers the engines served by the endpoint, with their health", async () => {
    const list = await c.get<ProviderInfo[]>("/api/providers");
    expect(list.map((p) => p.id).sort()).toEqual(["flux@testgpu", "real-esrgan@testgpu", "wan@testgpu"]);
    expect(list.every((p) => p.available)).toBe(true);
    const t = await c.post("/api/admin/providers/wan@testgpu/test");
    expect(t.ok).toBe(true);
  });

  it("text to video goes to Wan on the GPU and comes back at the requested size and length", async () => {
    const [job] = await c.post<Job[]>("/api/jobs", { module: "video", params: { operation: "text_to_video", prompt: "drone over Sydney", duration: 5, aspectRatio: "9:16", resolution: "480p", seed: 99 } });
    const done = await waitFor(c, job!.id);
    expect(done.status).toBe("completed");
    expect(done.providerId).toBe("wan@testgpu");
    const out = done.outputs[0]!;
    expect([out.width, out.height]).toEqual([480, 854]);
    expect(out.durationSec).toBeCloseTo(5, 0);

    // Extend on the same engine: the continuation is generated remotely and appended locally
    const [ext] = await c.post<Job[]>(`/api/jobs/${done.id}/extend`, { seconds: 5 });
    const extDone = await waitFor(c, ext!.id);
    expect(extDone.status).toBe("completed");
    expect(extDone.outputs[0]!.durationSec).toBeCloseTo(10, 0);
  });

  it("images: several outputs from FLUX, upscale from Real-ESRGAN with an uploaded source", async () => {
    const [job] = await c.post<Job[]>("/api/jobs", { module: "image", params: { operation: "text_to_image", prompt: "neon club", numOutputs: 2, aspectRatio: "16:9", resolution: "1K", seed: 5 } });
    const done = await waitFor(c, job!.id);
    expect(done.providerId).toBe("flux@testgpu");
    expect(done.outputs).toHaveLength(2);
    expect([done.outputs[0]!.width, done.outputs[0]!.height]).toEqual([1024, 576]);

    const src = await c.upload(fx.png, "image/png");
    const [up] = await c.post<Job[]>("/api/jobs", { module: "image", params: { operation: "upscale", sourceMediaId: src.id, upscale: { factor: 2 } } });
    const upDone = await waitFor(c, up!.id);
    expect(upDone.providerId).toBe("real-esrgan@testgpu");
    const file = path.join(tmp, "up.png");
    fs.writeFileSync(file, (await c.req("GET", upDone.outputs[0]!.url)).raw);
    expect((await probe(file)).width).toBe(1280);
  });

  it("routes only to engines that support the operation", async () => {
    const vid = await c.upload(fx.mp4, "video/mp4");
    const r = await c.req("POST", "/api/jobs", { module: "video", params: { operation: "video_to_video", prompt: "anime", sourceVideoId: vid.id } }, 422);
    expect(r.body.code).toBe("no_provider");
  });

  it("remote failures: permanent errors fail at once, retryable ones are retried", async () => {
    const [bad] = await c.post<Job[]>("/api/jobs", { module: "video", params: { operation: "text_to_video", prompt: "x #fail", duration: 5, resolution: "480p" } });
    const failed = await waitFor(c, bad!.id);
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(1);
    expect(failed.error).toContain("#fail");

    const [oom] = await c.post<Job[]>("/api/jobs", { module: "video", params: { operation: "text_to_video", prompt: "x #oom", duration: 5, resolution: "480p" } });
    const oomDone = await waitFor(c, oom!.id);
    expect(oomDone.status).toBe("failed");
    expect(oomDone.attempts).toBe(2);
  });

  it("cancelling in NX STUDIO cancels the job on the GPU", async () => {
    const [job] = await c.post<Job[]>("/api/jobs", { module: "video", params: { operation: "text_to_video", prompt: "long one #slow", duration: 5, resolution: "480p" } });
    await waitFor(c, job!.id, ["processing"]);
    await c.post(`/api/jobs/${job!.id}/cancel`);
    expect((await waitFor(c, job!.id)).status).toBe("cancelled");
    // the worker received the cancel: its job list shows it cancelled
    let remoteStatus = "";
    for (let i = 0; i < 50 && remoteStatus !== "cancelled"; i++) {
      const logs = await c.get<{ message: string; data: { remoteId?: string } | null }[]>(`/api/jobs/${job!.id}/logs`);
      const remoteId = logs.find((l) => l.data?.remoteId)?.data?.remoteId;
      if (remoteId) {
        const r = await fetch(`http://127.0.0.1:${PORT}/v1/jobs/${remoteId}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        remoteStatus = ((await r.json()) as { status: string }).status;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(remoteStatus).toBe("cancelled");
  });
});
