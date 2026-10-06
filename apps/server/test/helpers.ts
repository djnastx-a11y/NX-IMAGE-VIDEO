import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { createServices, type Services } from "../src/services/container.js";
import { buildApp } from "../src/api/app.js";
import { JobRunner } from "../src/worker/runner.js";
import type { Job, JobStatus } from "@nx/shared";

export const TEST_DB = process.env.DATABASE_URL_TEST ?? "postgres://nx@127.0.0.1:5432/nxstudio_test";

export interface Harness {
  s: Services;
  app: FastifyInstance;
  runner: JobRunner;
  dataDir: string;
  close(): Promise<void>;
}

/** Fresh database schema + temp storage + API + in-process worker with fast mocks. */
export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const admin = new pg.Client({ connectionString: TEST_DB });
  await admin.connect();
  await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await admin.end();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-test-"));
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DB,
    NX_DATA_DIR: dataDir,
    NX_WEB_DIR: path.join(dataDir, "no-web"),
    NX_MOCK_MIN_SECONDS: "0.3",
    NX_WORKER_POLL_MS: "100",
    RATE_LIMIT_LOGIN_MAX: "1000",
    RATE_LIMIT_MAX: "100000",
    ...env,
  });
  const s = await createServices(config, { listen: true });
  const app = await buildApp(s);
  await app.ready();
  const runner = new JobRunner(
    { jobs: s.jobs, media: s.media, settings: s.settings, storage: s.storage, registry: s.registry, logger: s.logger },
    { workerId: "test-worker", concurrency: 2, leaseSeconds: 60, pollMs: 100 },
  );
  s.pokeWorker = () => runner.poke();
  return {
    s,
    app,
    runner,
    dataDir,
    async close() {
      await runner.stop();
      await app.close();
      await s.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A logged-in API client (cookie session) on top of fastify.inject. */
export class Client {
  cookie = "";
  constructor(private readonly app: FastifyInstance) {}

  async req<T = any>(method: string, url: string, body?: unknown, expect?: number): Promise<{ status: number; body: T; headers: Record<string, unknown>; raw: Buffer }> {
    const res = await this.app.inject({
      method: method as "GET",
      url,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers["set-cookie"];
    if (set) {
      const c = (Array.isArray(set) ? set : [set]).map((x) => x.split(";")[0]).join("; ");
      this.cookie = c.includes("nx_session=;") || /nx_session=$/.test(c) ? "" : c;
    }
    let parsed: any = undefined;
    try {
      parsed = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      parsed = res.body;
    }
    if (expect !== undefined && res.statusCode !== expect) {
      throw new Error(`${method} ${url} → ${res.statusCode} (expected ${expect}): ${res.body.slice(0, 500)}`);
    }
    return { status: res.statusCode, body: parsed, headers: res.headers, raw: res.rawPayload };
  }

  get<T = any>(url: string, expect = 200) {
    return this.req<T>("GET", url, undefined, expect).then((r) => r.body);
  }
  post<T = any>(url: string, body: unknown = {}, expect = 200) {
    return this.req<T>("POST", url, body, expect).then((r) => r.body);
  }
  patch<T = any>(url: string, body: unknown, expect = 200) {
    return this.req<T>("PATCH", url, body, expect).then((r) => r.body);
  }
  del(url: string, expect = 204) {
    return this.req("DELETE", url, undefined, expect);
  }

  async upload(file: string, mime: string, query = "", expect = 200): Promise<any> {
    const form = new FormData();
    form.set("file", new Blob([fs.readFileSync(file)], { type: mime }), path.basename(file));
    const r = new Request("http://x/", { method: "POST", body: form });
    const res = await this.app.inject({
      method: "POST",
      url: `/api/media${query}`,
      headers: { cookie: this.cookie, "content-type": r.headers.get("content-type")! },
      payload: Buffer.from(await r.arrayBuffer()),
    });
    if (res.statusCode !== expect) throw new Error(`upload → ${res.statusCode}: ${res.body}`);
    return JSON.parse(res.body);
  }
}

export async function waitFor(c: Client, jobId: string, statuses: JobStatus[] = ["completed", "failed", "cancelled"], timeoutMs = 45_000): Promise<Job> {
  const start = Date.now();
  for (;;) {
    const j = await c.get<Job>(`/api/jobs/${jobId}`);
    if (statuses.includes(j.status)) return j;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} stuck in ${j.status} (${j.stage}): ${j.error}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Creates fixture media with ffmpeg (a PNG, a JPEG, a mask and a short MP4). */
export function makeFixtures(dir: string) {
  const f = (name: string) => path.join(dir, name);
  const ff = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  ff("-f", "lavfi", "-i", "testsrc2=s=640x480:d=1", "-frames:v", "1", "-update", "1", f("photo.png"));
  ff("-f", "lavfi", "-i", "testsrc2=s=480x640:d=1", "-frames:v", "1", "-update", "1", f("portrait.jpg"));
  ff("-f", "lavfi", "-i", "color=black:s=640x480:d=1", "-vf", "drawbox=x=200:y=150:w=240:h=180:color=white:t=fill", "-frames:v", "1", "-update", "1", f("mask.png"));
  ff("-f", "lavfi", "-i", "testsrc2=s=640x360:d=2:r=24", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("clip.mp4"));
  fs.writeFileSync(f("fake.png"), "this is not a png");
  return { png: f("photo.png"), jpg: f("portrait.jpg"), mask: f("mask.png"), mp4: f("clip.mp4"), fake: f("fake.png") };
}
