import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { probe, makeThumbnail } from "../media/ffmpeg.js";
import type { Services } from "./container.js";

// Deliberately narrow first integration: real original OpenMontage Remotion composition,
// safe user-authored title cards, no shell interpolation, paid APIs, or untrusted media URLs.
// Full OpenMontage agentic pipelines will require a separate authenticated worker.
export const openMontageSpec = z.object({
  title: z.string().trim().min(2).max(90),
  projectId: z.string().uuid().nullable().default(null),
  theme: z.enum(["clean-professional", "flat-motion-graphics", "minimalist-diagram"]).default("clean-professional"),
  scenes: z.array(z.object({
    title: z.string().trim().min(1).max(100),
    subtitle: z.string().trim().max(160).default(""),
    kind: z.enum(["hero_title", "text_card"]).default("text_card"),
    duration: z.number().int().min(2).max(6).default(3),
  }).strict()).min(1).max(6),
}).strict();

export type OpenMontageSpec = z.infer<typeof openMontageSpec>;
export type OpenMontageStatus = { enabled: boolean; sourcePresent: boolean; revisionPinned: boolean; dependenciesPresent: boolean; ready: boolean; mode: string; message: string };
const PIN = "e01dbf433f46eeb91d39bf905e194162921019a3";
const CUSTOM_ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "FAL_KEY", "FAL_API_KEY", "REPLICATE_API_TOKEN", "GOOGLE_API_KEY", "GEMINI_API_KEY"];

export function openMontageProps(spec: OpenMontageSpec) {
  let cursor = 0;
  const cuts = spec.scenes.map((scene, i) => {
    const start = cursor;
    cursor += scene.duration;
    return {
      id: "nx-scene-" + (i + 1),
      source: "",
      type: scene.kind,
      in_seconds: start,
      out_seconds: cursor,
      text: scene.title,
      subtitle: scene.subtitle,
    };
  });
  return { theme: spec.theme, cuts, overlays: [], captions: [], audio: {} };
}

interface RenderRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  status: "queued" | "running" | "completed" | "failed";
  error: string | null;
  media_id: string | null;
  created_at: Date;
  updated_at: Date;
  spec: OpenMontageSpec;
}

function jobDto(row: RenderRow) {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    status: row.status,
    error: row.error,
    mediaId: row.media_id,
    videoUrl: row.media_id ? `/api/media/${row.media_id}/file` : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class OpenMontageService {
  private readonly home: string;
  private readonly enabled: boolean;
  private readonly active = new Map<string, ChildProcess>();

  constructor(private readonly s: Services) {
    this.home = path.resolve(process.env.NX_OPENMONTAGE_HOME || path.resolve(process.cwd(), ".nx/openmontage"));
    // Disabled by default. A configured, pinned source checkout does not imply production permission.
    this.enabled = process.env.NX_OPENMONTAGE_ENABLED === "true";
  }

  status(): OpenMontageStatus {
    const sourcePresent = fs.existsSync(path.join(this.home, "AGENT_GUIDE.md")) &&
      fs.existsSync(path.join(this.home, "LICENSE"));
    const composer = path.join(this.home, "remotion-composer");
    const binary = path.join(composer, "node_modules", ".bin", "remotion");
    const dependenciesPresent = fs.existsSync(binary);
    let revisionPinned = false;
    if (sourcePresent) {
      const r = spawnSync("git", ["-C", this.home, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000 });
      revisionPinned = r.status === 0 && r.stdout.trim() === PIN;
    }
    const ready = this.enabled && sourcePresent && revisionPinned && dependenciesPresent;
    return {
      enabled: this.enabled,
      sourcePresent,
      revisionPinned,
      dependenciesPresent,
      ready,
      mode: "Composition Remotion OpenMontage, aperçus 16:9, un rendu local à la fois",
      message: !this.enabled ? "Moteur désactivé sur ce serveur." :
        !sourcePresent ? "Sources OpenMontage absentes du serveur." :
        !revisionPinned ? "Version OpenMontage non vérifiée." :
        !dependenciesPresent ? "Dépendances Remotion non installées." : "Moteur disponible pour les aperçus de montage.",
    };
  }

  async list(ownerId: string) {
    const { rows } = await this.s.pool.query<RenderRow>(
      "SELECT * FROM openmontage_jobs WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 30", [ownerId],
    );
    return rows.map(jobDto);
  }

  async get(ownerId: string, id: string) {
    const { rows } = await this.s.pool.query<RenderRow>(
      "SELECT * FROM openmontage_jobs WHERE owner_id = $1 AND id = $2", [ownerId, id],
    );
    if (!rows[0]) throw new HttpError(404, "Montage introuvable");
    return jobDto(rows[0]);
  }

  async submit(ownerId: string, input: unknown) {
    const state = this.status();
    if (!state.ready) throw new HttpError(503, state.message, "engine_offline");
    if (this.active.size > 0) throw new HttpError(409, "Un montage est déjà en cours. Réessaie après son export.", "busy");
    const spec = openMontageSpec.parse(input);
    if (spec.projectId && !(await this.s.projects.get(ownerId, spec.projectId))) {
      throw new HttpError(404, "Projet introuvable", "project_not_found");
    }
    // Single-host safe gate. Multi-instance queue and workers are a separate release.
    const { rows: existing } = await this.s.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM openmontage_jobs WHERE status IN ('queued','running') AND updated_at > now() - interval '6 minutes'",
    );
    if ((existing[0]?.n ?? 0) > 0) throw new HttpError(409, "Rendu en cours sur ce serveur", "busy");
    const id = randomUUID();
    await this.s.pool.query(
      "INSERT INTO openmontage_jobs (id, owner_id, project_id, title, spec) VALUES ($1,$2,$3,$4,$5::jsonb)",
      [id, ownerId, spec.projectId, spec.title, JSON.stringify(spec)],
    );
    // Asynchronous on this Node process; no claim of background worker durability.
    void this.render(id, ownerId, spec).catch((error: unknown) => {
      this.s.logger.error({ job: id, error: String(error) }, "OpenMontage render failed");
    });
    return this.get(ownerId, id);
  }

  private async render(id: string, ownerId: string, spec: OpenMontageSpec) {
    const { rows } = await this.s.pool.query<{ id: string }>(
      "UPDATE openmontage_jobs SET status='running', updated_at=now() WHERE id=$1 AND status='queued' RETURNING id", [id],
    );
    if (!rows.length) return;
    const composer = path.join(this.home, "remotion-composer");
    const tmp = path.join(this.s.config.dataDir, "om-renders", id);
    const propsFile = path.join(tmp, "props.json");
    const mp4 = path.join(tmp, "result.mp4");
    try {
      await fsp.mkdir(tmp, { recursive: true });
      await fsp.writeFile(propsFile, JSON.stringify(openMontageProps(spec)));
      const binary = path.join(composer, "node_modules", ".bin", "remotion");
      const args = ["render", "src/index.tsx", "Explainer", mp4,
        "--props", propsFile, "--codec", "h264", "--scale", "0.25", "--concurrency", "2"];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, args, {
          cwd: composer, shell: false, stdio: ["ignore", "ignore", "pipe"],
          env: { ...process.env, ...Object.fromEntries(CUSTOM_ENV_KEYS.map(k => [k, ""])), CI: "1" },
        });
        this.active.set(id, child);
        let tail = "";
        let stopped = false;
        const timer = setTimeout(() => {
          stopped = true;
          child.kill("SIGKILL");
        }, 180_000);
        child.stderr?.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2000); });
        child.once("error", (e) => { clearTimeout(timer); reject(e); });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code === 0 && !stopped) resolve();
          else reject(new Error(stopped ? "Limite de rendu atteinte (3 minutes)" : `Remotion a échoué (code ${code}): ${tail.slice(-400)}`));
        });
      });
      const info = await probe(mp4);
      if (!info.hasVideo || !info.width || !info.height || !info.durationSec) throw new Error("Export vidéo illisible");
      const thumb = path.join(tmp, "thumb.jpg");
      await makeThumbnail(mp4, thumb, info.durationSec);
      const key = `outputs/${ownerId}/openmontage/${id}.mp4`;
      const thumbKey = `outputs/${ownerId}/openmontage/${id}.thumb.jpg`;
      const size = await this.s.storage.putFile(key, mp4, "video/mp4");
      await this.s.storage.putFile(thumbKey, thumb, "image/jpeg");
      const media = await this.s.media.insert({
        ownerId, projectId: spec.projectId, kind: "video", source: "generated",
        storageKey: key, thumbKey, mime: "video/mp4", width: info.width,
        height: info.height, durationSec: info.durationSec, sizeBytes: size,
        originalName: "NX-Studio-" + id.slice(0, 8) + ".mp4",
      });
      await this.s.pool.query(
        "UPDATE openmontage_jobs SET status='completed', media_id=$2, updated_at=now() WHERE id=$1", [id, media.id],
      );
      await this.s.projects.touch(spec.projectId);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.s.pool.query(
        "UPDATE openmontage_jobs SET status='failed', error=$2, updated_at=now() WHERE id=$1",
        [id, reason.slice(0, 450)],
      );
    } finally {
      this.active.delete(id);
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}
