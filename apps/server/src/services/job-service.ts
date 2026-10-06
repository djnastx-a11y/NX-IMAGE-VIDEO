import { randomInt, randomUUID } from "node:crypto";
import {
  firstLastFrames,
  imageParamsSchema,
  missingImageInputs,
  missingVideoInputs,
  videoParamsSchema,
  VARIATION_LEVELS,
  type CreateJobRequest,
  type ImageParams,
  type JobKind,
  type Module,
  type VideoParams,
} from "@nx/shared";
import { createJobSchema } from "@nx/shared";
import { HttpError } from "../lib/errors.js";
import type { JobRow, NewJob } from "../repos/jobs.js";
import type { Services } from "./container.js";

const newSeed = () => randomInt(0, 2_147_483_647);
type Params = ImageParams | VideoParams;

/**
 * All job-creating actions (Generate, Regenerate, Variation, Duplicate, Extend) go through here
 * so validation, ownership checks and routing are identical everywhere.
 */
export class JobService {
  constructor(private readonly s: Services) {}

  /** Checks every referenced media exists, belongs to the user and has the right kind. */
  private async checkMedia(userId: string, module: Module, p: Params) {
    const want: [string | null | undefined, "image" | "video" | "mask", string][] = [];
    if (module === "image") {
      const i = p as ImageParams;
      want.push([i.sourceMediaId, "image", "image source"], [i.maskMediaId, "mask", "masque"]);
      for (const r of i.references) want.push([r.mediaId, "image", "image de référence"]);
      const missing = missingImageInputs(i);
      if (missing.length) throw new HttpError(400, `Champ requis manquant : ${missing.join(", ")}`, "missing_input");
    } else {
      const v = p as VideoParams;
      want.push([v.sourceImageId, "image", "image source"], [v.referenceImageId, "image", "image de référence"]);
      want.push([v.sourceVideoId, "video", "vidéo source"], [v.extendMediaId, "video", "vidéo à prolonger"]);
      for (const k of v.keyframes) want.push([k.mediaId, "image", "keyframe"]);
      const missing = missingVideoInputs(v);
      if (missing.length) throw new HttpError(400, `Champ requis manquant : ${missing.join(", ")}`, "missing_input");
      if (v.operation === "first_last_frame" && (!firstLastFrames(v).first || !firstLastFrames(v).last)) {
        throw new HttpError(400, "First / Last Frame demande deux images", "missing_input");
      }
    }
    for (const [id, kind, label] of want) {
      if (!id) continue;
      const m = await this.s.media.get(id, userId);
      if (!m) throw new HttpError(400, `${label} introuvable`, "invalid_media");
      // A mask may be any image; a "mask" upload may not be used as a picture.
      if (kind === "mask" ? m.kind === "video" : m.kind !== kind) throw new HttpError(400, `${label} : type de média invalide (${m.kind})`, "invalid_media");
    }
  }

  private async checkProject(userId: string, projectId: string | null) {
    if (projectId && !(await this.s.projects.get(userId, projectId))) throw new HttpError(400, "Projet introuvable", "invalid_project");
  }

  private async insert(
    userId: string,
    module: Module,
    variants: Params[],
    o: { kind: JobKind; parentJobId: string | null; projectId: string | null; priority: number },
  ) {
    await this.checkProject(userId, o.projectId);
    await this.checkMedia(userId, module, variants[0]!);
    // Fail fast (422) when no engine can take it, instead of queueing a job that is doomed.
    await this.s.registry.resolve(module, variants[0]!);
    const sys = await this.s.settings.system();
    const batchId = randomUUID();
    const items: NewJob[] = variants.map((params) => ({
      ownerId: userId,
      projectId: o.projectId,
      module,
      operation: params.operation,
      kind: o.kind,
      parentJobId: o.parentJobId,
      batchId,
      params,
      priority: o.priority,
      maxAttempts: sys.queue.maxAttempts,
    }));
    const rows = await this.s.jobs.create(items);
    await this.s.projects.touch(o.projectId);
    this.s.pokeWorker?.();
    return rows;
  }

  async create(userId: string, body: CreateJobRequest): Promise<JobRow[]> {
    const req = createJobSchema.parse(body);
    if (req.module === "image") {
      const p = { ...req.params, seed: req.params.seed ?? newSeed() };
      return this.insert(userId, "image", [p], { kind: "generate", parentJobId: null, projectId: req.projectId, priority: req.priority });
    }
    // Video variants: a fixed seed gives seed, seed+1...; otherwise every variant gets a random seed.
    const fixed = req.params.seed;
    const variants = Array.from({ length: req.count }, (_, i) => ({
      ...req.params,
      seed: fixed !== null ? (fixed + i) % 2_147_483_647 : newSeed(),
    }));
    return this.insert(userId, "video", variants, { kind: "generate", parentJobId: null, projectId: req.projectId, priority: req.priority });
  }

  private async source(userId: string, id: string) {
    const row = await this.s.jobs.get(id, userId);
    if (!row) throw new HttpError(404, "Génération introuvable");
    return row;
  }

  private parse(module: Module, p: unknown): Params {
    return module === "image" ? imageParamsSchema.parse(p) : videoParamsSchema.parse(p);
  }

  /** Same parameters, new seed. */
  async regenerate(userId: string, id: string) {
    const row = await this.source(userId, id);
    const p = { ...row.params, seed: newSeed() } as Params;
    return this.insert(userId, row.module, [p], { kind: "regenerate", parentJobId: row.id, projectId: row.project_id, priority: row.priority });
  }

  /**
   * Variations of an existing generation.
   *  - image: a "variation" job on one of its outputs (level subtle/medium/strong, same or new seed)
   *  - video: same parameters with new (or the same) seed and slightly more creative freedom
   */
  async variation(userId: string, id: string, body: unknown) {
    const row = await this.source(userId, id);
    const o = (body ?? {}) as { count?: number; sameSeed?: boolean; level?: string; outputIndex?: number; prompt?: string };
    const count = Math.max(1, Math.min(4, Number(o.count ?? (row.module === "video" ? 2 : 1))));
    const level = (VARIATION_LEVELS as readonly string[]).includes(o.level ?? "") ? (o.level as ImageParams["variationLevel"]) : "medium";
    if (row.module === "image") {
      const job = (await this.s.jobs.dtos([row]))[0]!;
      const out = job.outputs[o.outputIndex ?? 0];
      if (!out) throw new HttpError(409, "Cette génération n'a pas encore d'image à varier");
      const base = row.params as ImageParams;
      const p: ImageParams = imageParamsSchema.parse({
        ...base,
        operation: "variation",
        sourceMediaId: out.id,
        maskMediaId: null,
        numOutputs: count,
        variationLevel: level,
        prompt: o.prompt ?? base.prompt,
        seed: o.sameSeed ? base.seed : newSeed(),
      });
      return this.insert(userId, "image", [p], { kind: "variation", parentJobId: row.id, projectId: row.project_id, priority: row.priority });
    }
    const base = row.params as VideoParams;
    const bump = { subtle: 0.05, medium: 0.15, strong: 0.3 }[level];
    const variants = Array.from({ length: count }, (_, i) =>
      videoParamsSchema.parse({
        ...base,
        prompt: o.prompt ?? base.prompt,
        seed: o.sameSeed ? ((base.seed ?? 0) + i) % 2_147_483_647 : newSeed(),
        creativity: Math.min(1, Math.round((base.creativity + bump) * 100) / 100),
      }),
    );
    return this.insert(userId, "video", variants, { kind: "variation", parentJobId: row.id, projectId: row.project_id, priority: row.priority });
  }

  /** Full copy of the parameters (same seed), optionally with overrides such as a modified prompt. */
  async duplicate(userId: string, id: string, overrides: Record<string, unknown> = {}) {
    const row = await this.source(userId, id);
    const p = this.parse(row.module, { ...row.params, ...overrides });
    const projectId = (overrides.projectId as string | null | undefined) ?? row.project_id;
    return this.insert(userId, row.module, [p], { kind: "duplicate", parentJobId: row.id, projectId, priority: row.priority });
  }

  /** Extend a generated video by N seconds (continuation from its last frame, appended). */
  async extend(userId: string, id: string, body: unknown) {
    const row = await this.source(userId, id);
    if (row.module !== "video") throw new HttpError(400, "Seules les vidéos peuvent être prolongées");
    const o = (body ?? {}) as { seconds?: number; prompt?: string };
    const seconds = Math.round(Number(o.seconds ?? 5));
    if (!(seconds >= 1 && seconds <= 30)) throw new HttpError(400, "Durée d'extension invalide (1 à 30 s)");
    const job = (await this.s.jobs.dtos([row]))[0]!;
    const video = job.outputs.find((m) => m.kind === "video");
    if (row.status !== "completed" || !video) throw new HttpError(409, "Seule une vidéo terminée peut être prolongée");
    const base = row.params as VideoParams;
    const p = videoParamsSchema.parse({
      ...base,
      operation: "extend",
      prompt: o.prompt ?? base.prompt,
      duration: seconds,
      seed: newSeed(),
      extendMediaId: video.id,
      sourceImageId: null,
      sourceVideoId: null,
      keyframes: [],
    });
    return this.insert(userId, "video", [p], { kind: "extend", parentJobId: row.id, projectId: row.project_id, priority: row.priority });
  }
}
