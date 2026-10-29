import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startHarness, type Harness } from "./helpers.js";

let h: Harness;
let owner: Client;
let other: Client;

beforeAll(async () => {
  process.env.NX_OPENMONTAGE_ENABLED = "true";
  process.env.NX_OPENMONTAGE_HOME = path.resolve(process.cwd(), "../../.nx/openmontage");
  h = await startHarness();
  owner = new Client(h.app);
  other = new Client(h.app);
  await owner.post("/api/auth/setup", { email: "render@nx.test", password: "the-tested-password-2026", name: "Render" });
  await owner.post("/api/admin/users", { email: "other@nx.test", password: "the-other-password-2026", name: "Other", role: "user" });
  await other.post("/api/auth/login", { email: "other@nx.test", password: "the-other-password-2026" });
}, 40_000);

afterAll(async () => {
  await h?.close();
  delete process.env.NX_OPENMONTAGE_ENABLED;
  delete process.env.NX_OPENMONTAGE_HOME;
});

describe("real OpenMontage authenticated preview E2E", () => {
  it("renders a custom storyboard to an owned MP4 in NX Studio library", async () => {
    const anon = new Client(h.app);
    await anon.req("GET", "/api/openmontage/status", undefined, 401);
    const status = await owner.get<{ready:boolean;revisionPinned:boolean}>("/api/openmontage/status");
    expect(status.ready).toBe(true);
    expect(status.revisionPinned).toBe(true);
    const p = await owner.post<{id:string; status:string}>("/api/openmontage/jobs", {
      title: "NX automated test",
      projectId: null,
      theme: "clean-professional",
      scenes: [
        { kind: "hero_title", title: "NX STUDIO", subtitle: "OpenMontage tested", duration: 2 },
        { kind: "text_card", title: "Premier export", subtitle: "Test de bout en bout", duration: 2 },
      ],
    }, 202);
    expect(p.status).toMatch(/queued|running/);
    await other.req("GET", "/api/openmontage/jobs/" + p.id, undefined, 404);
    let done: {status:string;mediaId:string|null;error?:string} | null = null;
    for (let i=0;i<125;i++) {
      const job = await owner.get<{status:string;mediaId:string|null;error?:string}>("/api/openmontage/jobs/" + p.id);
      if (job.status === "completed" || job.status === "failed") { done = job; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(done?.status, done?.error).toBe("completed");
    expect(done?.mediaId).toMatch(/^[a-f0-9-]{36}$/);
    const mediaId = done!.mediaId!;
    await other.req("GET", "/api/media/" + mediaId, undefined, 404);
    const media = await owner.get<{kind:string;mime:string;durationSec:number}>("/api/media/" + mediaId);
    expect(media.kind).toBe("video");
    expect(media.mime).toBe("video/mp4");
    expect(media.durationSec).toBeGreaterThan(2);
    const result = await owner.req("GET", "/api/media/" + mediaId + "/file", undefined, 200);
    expect(result.raw.subarray(4,8).toString("ascii")).toBe("ftyp");
    expect(result.raw.byteLength).toBeGreaterThan(1000);
  }, 150_000);
});
