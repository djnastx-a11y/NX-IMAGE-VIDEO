import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, JobStatus, Media, Project } from "@nx/shared";
import { probe } from "../src/media/ffmpeg.js";
import { Client, makeFixtures, startHarness, waitFor, type Harness } from "./helpers.js";

let h: Harness;
let admin: Client;
let fx: ReturnType<typeof makeFixtures>;
let fxDir: string;

const ADMIN = { email: "jb@nx.studio", password: "correct-horse-battery", name: "Jb" };

beforeAll(async () => {
  h = await startHarness();
  fxDir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-fx-"));
  fx = makeFixtures(fxDir);
  admin = new Client(h.app);
});

afterAll(async () => {
  await h?.close();
  fs.rmSync(fxDir, { recursive: true, force: true });
});

/** Collects every status a job goes through by sampling it quickly. */
async function trackStatuses(c: Client, id: string): Promise<JobStatus[]> {
  const seen: JobStatus[] = [];
  const start = Date.now();
  for (;;) {
    const j = await c.get<Job>(`/api/jobs/${id}`);
    if (seen[seen.length - 1] !== j.status) seen.push(j.status);
    if (["completed", "failed", "cancelled"].includes(j.status)) return seen;
    if (Date.now() - start > 45_000) throw new Error(`timeout, seen ${seen.join(">")}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("auth", () => {
  it("requires setup on a fresh install, then creates the admin", async () => {
    expect((await admin.get("/api/auth/status")).setupRequired).toBe(true);
    await admin.post("/api/auth/setup", { ...ADMIN, password: "short" }, 400);
    const r = await admin.post("/api/auth/setup", ADMIN);
    expect(r.user.role).toBe("admin");
    await new Client(h.app).post("/api/auth/setup", { email: "x@example.com", password: "another-long-pass" }, 409);
  });

  it("protects routes and handles login / logout", async () => {
    const anon = new Client(h.app);
    await anon.req("GET", "/api/jobs", undefined, 401);
    await anon.req("GET", "/api/media", undefined, 401);
    await anon.post("/api/auth/login", { email: ADMIN.email, password: "wrong-password" }, 401);
    await anon.post("/api/auth/login", { email: ADMIN.email.toUpperCase(), password: ADMIN.password });
    expect((await anon.get("/api/auth/me")).user.email).toBe(ADMIN.email);
    await anon.post("/api/auth/logout");
    await anon.req("GET", "/api/auth/me", undefined, 401);
  });

  it("stores only hashed session tokens and scrypt password hashes", async () => {
    const { rows } = await h.s.pool.query("SELECT id FROM sessions LIMIT 1");
    expect(rows[0].id).toMatch(/^[0-9a-f]{64}$/);
    const u = await h.s.users.byEmail(ADMIN.email);
    expect(u!.password_hash.startsWith("scrypt$")).toBe(true);
  });

  it("enforces admin role", async () => {
    await admin.post("/api/admin/users", { email: "user@nx.studio", password: "user-password-123", role: "user" });
    const user = new Client(h.app);
    await user.post("/api/auth/login", { email: "user@nx.studio", password: "user-password-123" });
    await user.req("GET", "/api/admin/overview", undefined, 403);
    expect((await admin.get("/api/admin/overview")).db.ok).toBe(true);
  });
});

describe("projects", () => {
  it("creates, lists, updates and archives projects", async () => {
    const p = await admin.post<Project>("/api/projects", { name: "Australia Street", color: "#ff7a00" });
    await admin.post("/api/projects", { name: "Halloween" });
    expect((await admin.get<Project[]>("/api/projects")).map((x) => x.name)).toEqual(expect.arrayContaining(["Australia Street", "Halloween"]));
    const up = await admin.patch<Project>(`/api/projects/${p.id}`, { description: "Shooting rue" });
    expect(up.description).toBe("Shooting rue");
    await admin.post("/api/projects", { name: "" }, 400);
    // projects are private to their owner
    const user = new Client(h.app);
    await user.post("/api/auth/login", { email: "user@nx.studio", password: "user-password-123" });
    await user.req("GET", `/api/projects/${p.id}`, undefined, 404);
  });
});

describe("uploads", () => {
  it("accepts images and videos and records their metadata", async () => {
    const img = await admin.upload(fx.png, "image/png");
    expect(img).toMatchObject({ kind: "image", source: "upload", width: 640, height: 480, mime: "image/png" });
    const vid = await admin.upload(fx.mp4, "video/mp4");
    expect(vid.kind).toBe("video");
    expect(vid.durationSec).toBeCloseTo(2, 0);
    expect(vid.thumbUrl).toMatch(/thumb$/);
    const file = await admin.req("GET", img.url, undefined, 200);
    expect(file.raw.subarray(1, 4).toString()).toBe("PNG");
  });

  it("rejects bad MIME, mismatched extension, spoofed content and oversize files", async () => {
    const txt = path.join(fxDir, "notes.txt");
    fs.writeFileSync(txt, "hello");
    await admin.upload(txt, "text/plain", "", 415);
    await admin.upload(fx.fake, "image/png", "", 415); // content is not a PNG
    const misnamed = path.join(fxDir, "photo.jpg");
    fs.copyFileSync(fx.png, misnamed);
    await admin.upload(misnamed, "image/png", "", 415); // .jpg declared as image/png
    await admin.patch("/api/admin/settings", { uploads: { maxImageMb: 1 } });
    const big = path.join(fxDir, "big.png");
    const { execFileSync } = await import("node:child_process");
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=1400x1400,geq=random(1)*255:128:128", "-frames:v", "1", "-update", "1", big]);
    expect(fs.statSync(big).size).toBeGreaterThan(1024 * 1024);
    await admin.upload(big, "image/png", "", 413);
    await admin.patch("/api/admin/settings", { uploads: { maxImageMb: 25 } });
  });

  it("keeps media private to their owner", async () => {
    const img = await admin.upload(fx.png, "image/png");
    const user = new Client(h.app);
    await user.post("/api/auth/login", { email: "user@nx.studio", password: "user-password-123" });
    await user.req("GET", `/api/media/${img.id}/file`, undefined, 404);
    await new Client(h.app).req("GET", `/api/media/${img.id}/file`, undefined, 401);
  });
});

describe("NX IMAGE with MockImageProvider", () => {
  beforeAll(() => h.runner.start());

  it("text to image: queue → completed with N real PNG outputs and every status", async () => {
    const [job] = await admin.post<Job[]>("/api/jobs", {
      module: "image",
      params: { operation: "text_to_image", prompt: "A neon street at night", aspectRatio: "9:16", resolution: "1K", numOutputs: 2, seed: 1234 },
    });
    expect(job.status).toBe("queued");
    const seen = await trackStatuses(admin, job.id);
    expect(seen[seen.length - 1]).toBe("completed");
    expect(seen).toEqual(expect.arrayContaining(["processing", "completed"]));
    const done = await admin.get<Job>(`/api/jobs/${job.id}`);
    expect(done.providerId).toBe("mock-image");
    expect(done.outputs).toHaveLength(2);
    expect(done.durationMs).toBeGreaterThan(0);
    const out = done.outputs[0]!;
    expect([out.width, out.height]).toEqual([576, 1024]); // 9:16 at 1K long edge
    const bytes = await admin.req("GET", out.url, undefined, 200);
    expect(bytes.raw.subarray(1, 4).toString()).toBe("PNG");
  });

  it("image to image, edit (natural language), inpaint, outpaint, upscale, variation", async () => {
    const src = await admin.upload(fx.png, "image/png");
    const mask = await admin.upload(fx.mask, "image/png", "?purpose=mask");
    expect(mask.kind).toBe("mask");
    const run = async (params: Record<string, unknown>) => {
      const [j] = await admin.post<Job[]>("/api/jobs", { module: "image", params });
      const done = await waitFor(admin, j!.id);
      expect(done.status, `${params.operation}: ${done.error}`).toBe("completed");
      return done;
    };
    const i2i = await run({ operation: "image_to_image", sourceMediaId: src.id, prompt: "oil painting", strength: 0.6, aspectRatio: "1:1" });
    expect([i2i.outputs[0]!.width, i2i.outputs[0]!.height]).toEqual([1024, 1024]);
    expect(i2i.sources.map((m) => m.id)).toContain(src.id);

    const edit = await run({ operation: "edit", sourceMediaId: src.id, instruction: "Remplace uniquement le décor par une plage" });
    expect([edit.outputs[0]!.width, edit.outputs[0]!.height]).toEqual([640, 480]);
    const reframe = await run({ operation: "edit", sourceMediaId: src.id, instruction: "Passe cette image du 16:9 au 9:16 et reconstruis naturellement les zones manquantes" });
    const r = reframe.outputs[0]!;
    expect(r.width! / r.height!).toBeCloseTo(9 / 16, 1);

    const inp = await run({ operation: "inpaint", sourceMediaId: src.id, maskMediaId: mask.id, prompt: "a red ball", strength: 0.8 });
    expect(inp.outputs).toHaveLength(1);

    const out = await run({ operation: "outpaint", sourceMediaId: src.id, outpaint: { top: 0, bottom: 0, left: 100, right: 60 } });
    expect([out.outputs[0]!.width, out.outputs[0]!.height]).toEqual([800, 480]);

    const up = await run({ operation: "upscale", sourceMediaId: src.id, upscale: { factor: 4, enhanceDetails: true }, outputFormat: "webp" });
    expect([up.outputs[0]!.width, up.outputs[0]!.height]).toEqual([2560, 1920]);
    expect(up.outputs[0]!.mime).toBe("image/webp");

    const vars = await admin.post<Job[]>(`/api/jobs/${i2i.id}/variation`, { level: "strong", count: 3 });
    const v = await waitFor(admin, vars[0]!.id);
    expect(v.status).toBe("completed");
    expect(v.operation).toBe("variation");
    expect(v.outputs).toHaveLength(3);
    expect(v.parentJobId).toBe(i2i.id);
  });

  it("validates inputs before queueing", async () => {
    await admin.post("/api/jobs", { module: "image", params: { operation: "text_to_image", prompt: "" } }, 400);
    await admin.post("/api/jobs", { module: "image", params: { operation: "inpaint", sourceMediaId: "00000000-0000-4000-8000-000000000000", maskMediaId: "00000000-0000-4000-8000-000000000000" } }, 400);
    const vid = await admin.upload(fx.mp4, "video/mp4");
    await admin.post("/api/jobs", { module: "image", params: { operation: "image_to_image", sourceMediaId: vid.id } }, 400);
    await admin.post("/api/jobs", { module: "image", params: { operation: "text_to_image", prompt: "x", model: "does-not-exist" } }, 422);
  });

  it("exports images as PNG, JPEG and WebP", async () => {
    const lib = await admin.get<{ items: Media[] }>("/api/media?section=generated");
    const img = lib.items.find((m) => m.kind === "image")!;
    for (const [fmt, sig] of [["png", "PNG"], ["jpeg", "JFIF"], ["webp", "WEBP"]] as const) {
      const r = await admin.req("GET", `${img.url}?format=${fmt}`, undefined, 200);
      expect(String(r.headers["content-disposition"])).toContain(`.${fmt === "jpeg" ? "jpg" : fmt}`);
      expect(r.raw.subarray(0, 16).toString("latin1")).toContain(sig);
    }
  });
});

describe("NX VIDEO with MockVideoProvider", () => {
  it("text to video 10s 9:16 with camera preset → real MP4", async () => {
    const jobs = await admin.post<Job[]>("/api/jobs", {
      module: "video",
      params: { operation: "text_to_video", prompt: "Drone over a festival", duration: 10, aspectRatio: "9:16", resolution: "480p", camera: { move: "drone", intensity: 7 }, motionStrength: 0.8 },
    });
    const seen = await trackStatuses(admin, jobs[0]!.id);
    expect(seen).toEqual(expect.arrayContaining(["processing", "encoding", "completed"]));
    const done = await admin.get<Job>(`/api/jobs/${jobs[0]!.id}`);
    const v = done.outputs[0]!;
    expect(v.mime).toBe("video/mp4");
    expect([v.width, v.height]).toEqual([480, 854]);
    expect(v.durationSec).toBeCloseTo(10, 0);
    const local = await h.s.storage.localPath((await h.s.media.get(v.id))!.storage_key);
    const info = await probe(local);
    expect(info.codec).toBe("h264");
  });

  it("image to video, first/last frame, video to video, variants", async () => {
    const img = await admin.upload(fx.png, "image/png");
    const img2 = await admin.upload(fx.jpg, "image/jpeg");
    const clip = await admin.upload(fx.mp4, "video/mp4");
    const run = async (params: Record<string, unknown>, count = 1) => {
      const js = await admin.post<Job[]>("/api/jobs", { module: "video", params: { duration: 5, resolution: "480p", ...params }, count });
      expect(js).toHaveLength(count);
      const done = await Promise.all(js.map((j) => waitFor(admin, j.id)));
      for (const d of done) expect(d.status, d.error ?? "").toBe("completed");
      return done;
    };
    const [i2v] = await run({ operation: "image_to_video", sourceImageId: img.id, prompt: "slow push in", camera: { move: "zoom_in", intensity: 5 }, sourceFidelity: 0.9 });
    expect(i2v!.outputs[0]!.durationSec).toBeCloseTo(5, 0);
    await run({ operation: "first_last_frame", keyframes: [{ mediaId: img.id, position: 0 }, { mediaId: img2.id, position: 1 }], prompt: "morph" });
    await run({ operation: "video_to_video", sourceVideoId: clip.id, prompt: "anime style", videoStrength: 0.7 });
    const variants = await run({ operation: "text_to_video", prompt: "waves", seed: 42 }, 3);
    expect(variants.map((v) => (v.params as { seed: number }).seed)).toEqual([42, 43, 44]);
    expect(new Set(variants.map((v) => v.batchId)).size).toBe(1);
  });

  it("extend appends seconds to a finished video", async () => {
    const [j] = await admin.post<Job[]>("/api/jobs", { module: "video", params: { operation: "text_to_video", prompt: "clouds", duration: 5, resolution: "480p" } });
    const done = await waitFor(admin, j!.id);
    const [ext] = await admin.post<Job[]>(`/api/jobs/${done.id}/extend`, { seconds: 5 });
    const e = await waitFor(admin, ext!.id);
    expect(e.status, e.error ?? "").toBe("completed");
    expect(e.kind).toBe("extend");
    expect(e.outputs[0]!.durationSec).toBeCloseTo(10, 0);
    expect(e.sources.map((m) => m.id)).toContain(done.outputs[0]!.id);
  });
});

describe("queue: cancel, retry, auto-retry, failures, priority", () => {
  it("cancels a running job and a queued job", async () => {
    const [slow] = await admin.post<Job[]>("/api/jobs", { module: "video", params: { operation: "text_to_video", prompt: "long #slow", duration: 5, resolution: "480p" } });
    await waitFor(admin, slow!.id, ["processing"]);
    const c = await admin.post<Job>(`/api/jobs/${slow!.id}/cancel`);
    expect(c.status).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 800));
    const after = await admin.get<Job>(`/api/jobs/${slow!.id}`);
    expect(after.status).toBe("cancelled");
    expect(after.outputs).toHaveLength(0);
    const logs = await admin.get<{ message: string }[]>(`/api/jobs/${slow!.id}/logs`);
    expect(logs.map((l) => l.message).join("|")).toMatch(/Cancel/);
    await admin.post(`/api/jobs/${slow!.id}/cancel`, {}, 409);
  });

  it("permanent failure ends Failed with the error; manual retry re-runs the same job", async () => {
    const [j] = await admin.post<Job[]>("/api/jobs", { module: "image", params: { operation: "text_to_image", prompt: "boom #fail" } });
    const f = await waitFor(admin, j!.id);
    expect(f.status).toBe("failed");
    expect(f.error).toMatch(/Simulated engine failure/);
    expect(f.attempts).toBe(1); // permanent errors are not auto-retried
    // retry the same job (it will fail again since the hook is permanent, proving it re-ran)
    const r = await admin.post<Job>(`/api/jobs/${j!.id}/retry`);
    expect(r.status).toBe("queued");
    const f2 = await waitFor(admin, j!.id);
    expect(f2.status).toBe("failed");
    const logs = await admin.get<{ message: string; level: string }[]>(`/api/jobs/${j!.id}/logs`);
    expect(logs.filter((l) => l.level === "error")).toHaveLength(2);
  });

  it("transient failure is retried automatically and completes", async () => {
    await admin.patch("/api/admin/settings", { queue: { retryBackoffSec: 0 } });
    const [j] = await admin.post<Job[]>("/api/jobs", { module: "image", params: { operation: "text_to_image", prompt: "flaky gpu #fail-once" } });
    const done = await waitFor(admin, j!.id);
    expect(done.status).toBe("completed");
    expect(done.attempts).toBe(2);
    const logs = await admin.get<{ message: string }[]>(`/api/jobs/${j!.id}/logs`);
    expect(logs.map((l) => l.message).join("|")).toMatch(/transient/);
  });

  it("regenerate (new seed) and duplicate (same seed, overrides)", async () => {
    const [j] = await admin.post<Job[]>("/api/jobs", { module: "image", params: { operation: "text_to_image", prompt: "a cat", seed: 7 } });
    await waitFor(admin, j!.id);
    const [re] = await admin.post<Job[]>(`/api/jobs/${j!.id}/regenerate`);
    expect(re!.kind).toBe("regenerate");
    expect((re!.params as { seed: number }).seed).not.toBe(7);
    const [dup] = await admin.post<Job[]>(`/api/jobs/${j!.id}/duplicate`, { overrides: { prompt: "a cat wearing a hat" } });
    expect(dup!.kind).toBe("duplicate");
    expect((dup!.params as { seed: number; prompt: string }).seed).toBe(7);
    expect((dup!.params as { prompt: string }).prompt).toBe("a cat wearing a hat");
    expect((await waitFor(admin, dup!.id)).status).toBe("completed");
    expect((await waitFor(admin, re!.id)).status).toBe("completed");
  });

  it("higher priority jobs are picked first", async () => {
    await h.runner.stop();
    const [low] = await admin.post<Job[]>("/api/jobs", { module: "image", params: { operation: "text_to_image", prompt: "low" }, priority: 0 });
    const [high] = await admin.post<Job[]>("/api/jobs", { module: "image", params: { operation: "text_to_image", prompt: "high" }, priority: 5 });
    const lowQ = await admin.get<Job>(`/api/jobs/${low!.id}`);
    const highQ = await admin.get<Job>(`/api/jobs/${high!.id}`);
    expect(highQ.queuePosition).toBeLessThan(lowQ.queuePosition!);
    const claimed = await h.s.jobs.claimNext("probe");
    expect(claimed!.id).toBe(high!.id);
    await h.s.jobs.release(claimed!.id);
    h.runner.start();
    await waitFor(admin, low!.id);
    await waitFor(admin, high!.id);
  });

  it("a crashed worker's job is re-queued by the lease reaper", async () => {
    await h.runner.stop();
    const [j] = await admin.post<Job[]>("/api/jobs", { module: "image", params: { operation: "text_to_image", prompt: "orphan" } });
    await h.s.jobs.claimNext("ghost-worker");
    await h.s.pool.query("UPDATE generation_jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [j!.id]);
    const ids = await h.s.jobs.requeueStale(60);
    expect(ids).toContain(j!.id);
    h.runner.start();
    expect((await waitFor(admin, j!.id)).status).toBe("completed");
  });
});

describe("history, library, presets, admin", () => {
  it("history filters by module, status and text", async () => {
    const all = await admin.get<{ items: Job[]; total: number }>("/api/jobs?limit=200");
    expect(all.total).toBeGreaterThan(10);
    const vids = await admin.get<{ items: Job[] }>("/api/jobs?module=video&limit=200");
    expect(vids.items.every((j) => j.module === "video")).toBe(true);
    const failed = await admin.get<{ items: Job[] }>("/api/jobs?status=failed");
    expect(failed.items.every((j) => ["failed", "cancelled"].includes(j.status))).toBe(true);
    const cats = await admin.get<{ items: Job[] }>("/api/jobs?q=cat");
    expect(cats.items.length).toBeGreaterThanOrEqual(2);
  });

  it("library sections, favorites, project assignment, search, delete", async () => {
    const lib = await admin.get<{ items: Media[]; total: number }>("/api/media?section=all&limit=200");
    const ups = await admin.get<{ items: Media[] }>("/api/media?section=uploads&limit=200");
    const gen = await admin.get<{ items: Media[] }>("/api/media?section=generated&limit=200");
    expect(ups.items.every((m) => m.source === "upload")).toBe(true);
    expect(gen.items.every((m) => m.source === "generated")).toBe(true);
    expect(lib.items.some((m) => m.kind === "mask")).toBe(false);
    const vids = await admin.get<{ items: Media[] }>("/api/media?section=videos");
    expect(vids.items.every((m) => m.kind === "video")).toBe(true);

    const target = gen.items[0]!;
    await admin.patch(`/api/media/${target.id}`, { favorite: true });
    const favs = await admin.get<{ items: Media[] }>("/api/media?section=favorites");
    expect(favs.items.map((m) => m.id)).toContain(target.id);

    const [p] = await admin.get<Project[]>("/api/projects");
    await admin.patch(`/api/media/${target.id}`, { projectId: p!.id });
    const inProject = await admin.get<{ items: Media[] }>(`/api/media?projectId=${p!.id}`);
    expect(inProject.items.map((m) => m.id)).toContain(target.id);

    const search = await admin.get<{ items: Media[] }>("/api/media?q=neon");
    expect(search.items.length).toBeGreaterThan(0);

    await admin.del(`/api/media/${target.id}`);
    await admin.req("GET", `/api/media/${target.id}`, undefined, 404);
  });

  it("download returns the MP4 as an attachment", async () => {
    const vids = await admin.get<{ items: Media[] }>("/api/media?section=videos");
    const v = vids.items.find((m) => m.source === "generated")!;
    const r = await admin.req("GET", `${v.url}?download=1`, undefined, 200);
    expect(String(r.headers["content-disposition"])).toMatch(/attachment; filename="nx-video-.*\.mp4"/);
    expect(r.raw.subarray(4, 8).toString()).toBe("ftyp");
  });

  it("deleting a job removes it from history and its outputs from the library", async () => {
    const [j] = await admin.post<Job[]>("/api/jobs", { module: "image", params: { operation: "text_to_image", prompt: "to delete" } });
    const done = await waitFor(admin, j!.id);
    await admin.del(`/api/jobs/${j!.id}`);
    await admin.req("GET", `/api/jobs/${j!.id}`, undefined, 404);
    await admin.req("GET", `/api/media/${done.outputs[0]!.id}`, undefined, 404);
  });

  it("presets: built-ins are listed, user presets CRUD, private media stripped", async () => {
    const list = await admin.get<{ name: string; builtin: boolean; module: string }[]>("/api/presets");
    expect(list.filter((p) => p.builtin).map((p) => p.name)).toEqual(expect.arrayContaining(["DJ Promo", "Horror", "Poster Editing"]));
    const p = await admin.post("/api/presets", {
      module: "video",
      name: "Mon reel",
      params: { aspectRatio: "9:16", duration: 10, camera: { move: "orbit_left", intensity: 4 }, sourceImageId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(p.params).toMatchObject({ aspectRatio: "9:16", duration: 10 });
    expect(p.params.sourceImageId).toBeUndefined();
    await admin.post("/api/presets", { module: "video", name: "bad", params: { duration: "long" } }, 400);
    const builtin = list.find((x) => x.builtin) as unknown as { id: string };
    await admin.req("DELETE", `/api/presets/${builtin.id}`, undefined, 404);
    await admin.del(`/api/presets/${p.id}`);
  });

  it("admin: disable a provider → routing refuses; re-enable; set default; test; audit log", async () => {
    await admin.patch("/api/admin/providers/mock-video", { enabled: false });
    const r = await admin.req("POST", "/api/jobs", { module: "video", params: { operation: "text_to_video", prompt: "x" } }, 422);
    expect(r.body.error).toMatch(/désactivé/);
    await admin.patch("/api/admin/providers/mock-video", { enabled: true, isDefault: true });
    const infos = await admin.get<{ id: string; isDefault: boolean; available: boolean }[]>("/api/providers?module=video");
    expect(infos.find((i) => i.id === "mock-video")).toMatchObject({ isDefault: true, available: true });
    const t = await admin.post("/api/admin/providers/mock-image/test");
    expect(t.ok).toBe(true);
    const audit = await admin.get<{ action: string }[]>("/api/admin/audit");
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["admin.provider", "admin.settings", "auth.login", "auth.setup"]));
    const ov = await admin.get("/api/admin/overview");
    expect(JSON.stringify(ov.config)).not.toMatch(/secret|password/i);
  });
});
