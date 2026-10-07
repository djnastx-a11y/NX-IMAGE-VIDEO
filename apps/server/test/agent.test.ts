import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, ProviderInfo } from "@nx/shared";
import {
  Client,
  makeFixtures,
  startHarness,
  waitFor,
  type Harness,
} from "./helpers.js";

/**
 * Pull mode, end to end: NX STUDIO listens on a real port, the Python GPU agent (gpu-worker/nx_gpu/agent.py)
 * connects out to it with its token, claims tasks, downloads inputs and uploads outputs.
 * This is how a Kaggle notebook or a home PC without a public address runs the engines.
 */
const WORKER_DIR = path.resolve(__dirname, "../../../gpu-worker");
const PYTHON = path.join(WORKER_DIR, ".venv/bin/python");
const hasWorker = fs.existsSync(PYTHON);
const TOKEN = "agent-test-token-0123456789";

let agent: ChildProcess | undefined;
let h: Harness;
let c: Client;
let fx: ReturnType<typeof makeFixtures>;
let base = "";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nx-agent-"));

function startAgent(token = TOKEN) {
  return spawn(PYTHON, ["-m", "nx_gpu.agent"], {
    cwd: WORKER_DIR,
    env: {
      ...process.env,
      NX_URL: base,
      NX_GPU_AGENT_TOKEN: token,
      NX_ENGINES: "fake:wan,fake:flux,fake:real-esrgan",
      NX_FAKE_SECONDS: "1",
      NX_GPU_DATA_DIR: path.join(tmp, "agent"),
    },
    stdio: [
      "ignore",
      "ignore",
      fs.openSync(process.env.NX_AGENT_LOG ?? "/dev/null", "a"),
    ],
  });
}

async function providers() {
  return c.get<ProviderInfo[]>("/api/providers");
}

describe.skipIf(!hasWorker)(
  "GPU agent (pull mode, Python agent with fake engines)",
  () => {
    beforeAll(async () => {
      process.env.NX_TEST_AGENT_TOKEN = TOKEN;
      h = await startHarness({
        NX_ENABLE_MOCK: "false",
        NX_GPU_AGENTS: JSON.stringify([
          {
            id: "kaggle",
            tokenEnv: "NX_TEST_AGENT_TOKEN",
            engines: ["wan", "flux", "real-esrgan"],
          },
        ]),
      });
      await h.app.listen({ port: 0, host: "127.0.0.1" });
      base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
      fx = makeFixtures(tmp);
      c = new Client(h.app);
      await c.post("/api/auth/setup", {
        email: "jb@nx.studio",
        password: "correct-horse-battery",
        name: "Jb",
      });
      await c.patch("/api/admin/settings", {
        queue: { retryBackoffSec: 0, maxAttempts: 2 },
      });
      h.runner.start();
    }, 60_000);

    afterAll(async () => {
      agent?.kill();
      await h?.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("before the agent connects, its engines are listed but unavailable and jobs are refused", async () => {
      const list = await providers();
      expect(list.map((p) => p.id).sort()).toEqual([
        "flux@kaggle",
        "real-esrgan@kaggle",
        "wan@kaggle",
      ]);
      expect(list.every((p) => !p.available)).toBe(true);
      const r = await c.req(
        "POST",
        "/api/jobs",
        {
          module: "video",
          params: {
            operation: "text_to_video",
            prompt: "x",
            duration: 5,
            resolution: "480p",
          },
        },
        422,
      );
      expect(r.body.code).toBe("no_provider");
    });

    it("rejects an agent with a wrong token", async () => {
      const r = await fetch(`${base}/api/gpu-agent/claim`, {
        method: "POST",
        headers: {
          authorization: "Bearer nope",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(r.status).toBe(401);
    });

    it("once the agent connects, its engines become available", async () => {
      agent = startAgent();
      for (let i = 0; i < 100; i++) {
        if ((await providers()).every((p) => p.available)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect((await providers()).every((p) => p.available)).toBe(true);
    });

    it("image to video 9:16 runs on the agent, then Extend to 10 s", async () => {
      const img = await c.upload(fx.jpg, "image/jpeg");
      const [job] = await c.post<Job[]>("/api/jobs", {
        module: "video",
        params: {
          operation: "image_to_video",
          sourceImageId: img.id,
          prompt: "she turns and smiles",
          duration: 5,
          aspectRatio: "9:16",
          resolution: "480p",
          camera: { move: "dolly_in", intensity: 7 },
        },
      });
      const done = await waitFor(c, job!.id);
      expect(done.status).toBe("completed");
      expect(done.providerId).toBe("wan@kaggle");
      expect([done.outputs[0]!.width, done.outputs[0]!.height]).toEqual([
        480, 854,
      ]);
      expect(done.outputs[0]!.durationSec).toBeCloseTo(5, 0);

      const [ext] = await c.post<Job[]>(`/api/jobs/${done.id}/extend`, {
        seconds: 5,
      });
      const extDone = await waitFor(c, ext!.id);
      expect(extDone.status).toBe("completed");
      expect(extDone.outputs[0]!.durationSec).toBeCloseTo(10, 0);
    });

    it("several images come back from one task, and the task files are cleaned up", async () => {
      const [job] = await c.post<Job[]>("/api/jobs", {
        module: "image",
        params: {
          operation: "text_to_image",
          prompt: "neon club",
          numOutputs: 3,
          aspectRatio: "1:1",
          resolution: "1K",
          seed: 3,
        },
      });
      const done = await waitFor(c, job!.id);
      expect(done.providerId).toBe("flux@kaggle");
      expect(done.outputs).toHaveLength(3);
      const { rows } = await h.s.pool.query(
        "SELECT count(*)::int AS n FROM gpu_tasks",
      );
      expect(rows[0].n).toBe(0);
      const dir = path.join(h.dataDir, "media", "gpu-tasks");
      const left = fs.existsSync(dir)
        ? fs
            .readdirSync(dir, { recursive: true })
            .filter((f) => fs.statSync(path.join(dir, String(f))).isFile())
        : [];
      expect(left).toEqual([]);
    });

    it("failures from the agent: permanent fails at once, out-of-memory is retried", async () => {
      const [bad] = await c.post<Job[]>("/api/jobs", {
        module: "video",
        params: {
          operation: "text_to_video",
          prompt: "x #fail",
          duration: 5,
          resolution: "480p",
        },
      });
      const failed = await waitFor(c, bad!.id);
      expect(failed.status).toBe("failed");
      expect(failed.attempts).toBe(1);
      expect(failed.error).toContain("#fail");

      const [oom] = await c.post<Job[]>("/api/jobs", {
        module: "video",
        params: {
          operation: "text_to_video",
          prompt: "x #oom",
          duration: 5,
          resolution: "480p",
        },
      });
      const oomDone = await waitFor(c, oom!.id);
      expect(oomDone.status).toBe("failed");
      expect(oomDone.attempts).toBe(2);
    });

    it("cancelling in NX STUDIO stops the work on the agent, which then takes the next job", async () => {
      const [job] = await c.post<Job[]>("/api/jobs", {
        module: "video",
        params: {
          operation: "text_to_video",
          prompt: "long one #slow",
          duration: 5,
          resolution: "480p",
        },
      });
      await waitFor(c, job!.id, ["processing"]);
      const t0 = Date.now();
      await c.post(`/api/jobs/${job!.id}/cancel`);
      expect((await waitFor(c, job!.id)).status).toBe("cancelled");
      // the slow fake job takes ~5 s; a stopped agent is free again well before that
      const [next] = await c.post<Job[]>("/api/jobs", {
        module: "image",
        params: {
          operation: "text_to_image",
          prompt: "after cancel",
          aspectRatio: "1:1",
          resolution: "1K",
        },
      });
      expect((await waitFor(c, next!.id)).status).toBe("completed");
      expect(Date.now() - t0).toBeLessThan(4500);
    });
  },
);
