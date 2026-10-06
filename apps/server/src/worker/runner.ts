import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  firstLastFrames,
  missingImageInputs,
  missingVideoInputs,
  type ImageParams,
  type JobStatus,
  type VideoParams,
} from "@nx/shared";
import { AbortedError, ProviderError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import type { JobRow, JobsRepo } from "../repos/jobs.js";
import type { MediaRepo, NewMedia } from "../repos/media.js";
import type { SettingsRepo } from "../repos/settings.js";
import type { StorageProvider } from "../storage/storage.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { runImage, runVideo, type ImageInputs, type ProviderContext, type ProviderStage, type VideoInputs } from "../providers/types.js";
import { deliveryEncodeArgs, encodeImage, extractFrame, ffmpeg, IMAGE_FORMAT_MIME, makeThumbnail, probe } from "../media/ffmpeg.js";

export interface RunnerDeps {
  jobs: JobsRepo;
  media: MediaRepo;
  settings: SettingsRepo;
  storage: StorageProvider;
  registry: ProviderRegistry;
  logger: Logger;
}

export interface RunnerOptions {
  workerId: string;
  /** Used when system settings are unavailable */
  concurrency: number;
  leaseSeconds: number;
  pollMs: number;
}

/** Share of the overall progress bar given to each phase. */
const PHASE = { starting: [0, 0.05], processing: [0.05, 0.9], encoding: [0.9, 1] } as const;

/**
 * Generation worker. Pulls jobs from the Postgres queue (SKIP LOCKED, so any number of worker
 * processes/machines can share it), routes each job to a provider, post-processes outputs
 * (delivery encode, Extend concatenation, thumbnails) and stores them.
 */
export class JobRunner {
  private running = new Map<string, AbortController>();
  private tasks = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private reaper: NodeJS.Timeout | null = null;
  private stopped = true;
  private filling = false;

  constructor(
    private readonly d: RunnerDeps,
    private readonly opts: RunnerOptions,
  ) {}

  start() {
    this.stopped = false;
    this.timer = setInterval(() => void this.fill(), this.opts.pollMs);
    this.reaper = setInterval(() => void this.reap(), 10_000);
    void this.reap();
    void this.fill();
  }

  /** Stops claiming jobs, aborts running ones and hands them back to the queue. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reaper) clearInterval(this.reaper);
    for (const c of this.running.values()) c.abort();
    await Promise.allSettled([...this.tasks]);
  }

  get active() {
    return this.running.size;
  }

  /** Wakes the loop immediately (e.g. right after a job is created in the same process). */
  poke() {
    void this.fill();
  }

  private async reap() {
    try {
      const ids = await this.d.jobs.requeueStale(this.opts.leaseSeconds);
      if (ids.length) this.d.logger.warn({ worker: this.opts.workerId, jobs: ids }, "re-queued jobs from a lost worker");
    } catch (e) {
      this.d.logger.error({ err: e }, "stale job reaper failed");
    }
  }

  private async fill() {
    if (this.filling || this.stopped) return;
    this.filling = true;
    try {
      const sys = await this.d.settings.system().catch(() => null);
      const concurrency = sys?.queue.concurrency ?? this.opts.concurrency;
      while (!this.stopped && this.running.size < concurrency) {
        const row = await this.d.jobs.claimNext(this.opts.workerId);
        if (!row) break;
        const t = this.run(row, sys?.queue.retryBackoffSec ?? 5).finally(() => this.tasks.delete(t));
        this.tasks.add(t);
      }
    } catch (e) {
      this.d.logger.error({ err: e }, "queue poll failed");
    } finally {
      this.filling = false;
    }
  }

  private async run(row: JobRow, backoffSec: number) {
    const { jobs } = this.d;
    const ctrl = new AbortController();
    this.running.set(row.id, ctrl);
    const started = Date.now();
    const log = this.d.logger.child({
      job: row.id,
      user: row.owner_id,
      module: row.module,
      operation: row.operation,
      worker: this.opts.workerId,
      attempt: row.attempts,
    });
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `nx-${row.id.slice(0, 8)}-`));
    const stageTimes: Record<string, number> = {};
    let currentStage = "starting";
    let stageStart = Date.now();

    const watch = setInterval(() => {
      jobs.isCancelled(row.id).then((c) => c && ctrl.abort(), () => {});
    }, 500);
    const heartbeat = setInterval(() => {
      jobs.updateRunning(row.id, {}).then((ok) => !ok && ctrl.abort(), () => {});
    }, 5000);

    let lastWrite = 0;
    let lastKey = "";
    const update = (status: JobStatus, stage: string, progress: number, force = false) => {
      if (status !== currentStage) {
        stageTimes[currentStage] = Date.now() - stageStart;
        currentStage = status;
        stageStart = Date.now();
      }
      const key = `${status}|${stage}`;
      const now = Date.now();
      if (!force && key === lastKey && now - lastWrite < 400) return;
      lastWrite = now;
      lastKey = key;
      jobs.updateRunning(row.id, { status, stage, progress: Math.round(progress * 1000) / 1000 }).then((ok) => !ok && ctrl.abort(), () => {});
    };

    let providerId: string | null = null;
    let model: string | null = null;
    try {
      await jobs.log(row.id, "info", `Attempt ${row.attempts} started on ${this.opts.workerId}`);
      const provider = await this.d.registry.resolve(row.module, row.params as ImageParams | VideoParams);
      providerId = provider.id;
      model = provider.engine;
      await jobs.updateRunning(row.id, { providerId, model, stage: `Routing to ${provider.name}` });
      await jobs.log(row.id, "info", `Routed to ${provider.name}`, { provider: providerId, model, backend: provider.backend });
      log.info({ provider: providerId, model }, "job started");

      const ctx: ProviderContext = {
        jobId: row.id,
        attempt: row.attempts,
        workDir,
        signal: ctrl.signal,
        report: (stage: ProviderStage, p: number, detail?: string) => {
          const [a, b] = PHASE[stage];
          update(stage, detail ?? (stage === "starting" ? "Starting engine" : "Processing"), a + (b - a) * Math.max(0, Math.min(1, p)));
        },
        log: (message, data) => {
          log.info({ provider: providerId, ...data }, message);
          void jobs.log(row.id, "info", message, data).catch(() => {});
        },
      };

      const outputs: (NewMedia & { seed: number | null })[] = [];
      if (provider.module === "image") {
        const params = row.params as ImageParams;
        const inputs = await this.imageInputs(row, params);
        const raw = await runImage(provider, params, inputs, ctx);
        update("encoding", `Encoding ${params.outputFormat.toUpperCase()}`, PHASE.encoding[0], true);
        for (const [i, r] of raw.entries()) {
          if (ctrl.signal.aborted) throw new AbortedError();
          const ext = params.outputFormat === "jpeg" ? "jpg" : params.outputFormat;
          const final = path.join(workDir, `final_${i}.${ext}`);
          await encodeImage(r.path, final, params.outputFormat, ctrl.signal);
          outputs.push(await this.store(row, final, `${i}.${ext}`, IMAGE_FORMAT_MIME[params.outputFormat], "image", r.seed));
          update("encoding", "Saving outputs", PHASE.encoding[0] + 0.09 * ((i + 1) / raw.length));
        }
      } else {
        const params = row.params as VideoParams;
        const inputs = await this.videoInputs(row, params, workDir, ctrl.signal);
        const raw = await runVideo(provider, params, inputs, ctx);
        update("encoding", "Encoding MP4", PHASE.encoding[0], true);
        const final = path.join(workDir, "final.mp4");
        const onProgress = (p: number) => update("encoding", "Encoding MP4", PHASE.encoding[0] + 0.09 * p);
        if (params.operation === "extend") {
          const src = inputs.extendSource!;
          const a = await probe(src);
          const b = await probe(raw.path);
          const w = a.width ?? 1280;
          const h = a.height ?? 720;
          const norm = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${params.fps},setsar=1,format=yuv420p`;
          await ffmpeg(
            ["-i", src, "-i", raw.path, "-filter_complex", `[0:v]${norm}[a];[1:v]${norm}[b];[a][b]concat=n=2:v=1:a=0[v]`, "-map", "[v]", ...deliveryEncodeArgs(), final],
            { signal: ctrl.signal, totalFrames: Math.round(((a.durationSec ?? 0) + (b.durationSec ?? 0)) * params.fps), onProgress },
          );
        } else {
          const b = await probe(raw.path);
          await ffmpeg(["-i", raw.path, "-map", "0:v:0", ...deliveryEncodeArgs(), final], {
            signal: ctrl.signal,
            totalFrames: b.frames ?? Math.round((b.durationSec ?? params.duration) * params.fps),
            onProgress,
          });
        }
        outputs.push(await this.store(row, final, "0.mp4", "video/mp4", "video", raw.seed));
      }
      stageTimes[currentStage] = Date.now() - stageStart;

      const saved = await jobs.complete(row.id, outputs);
      if (!saved) {
        for (const o of outputs) {
          await this.d.storage.delete(o.storageKey).catch(() => {});
          if (o.thumbKey) await this.d.storage.delete(o.thumbKey).catch(() => {});
        }
        log.info("job cancelled at commit, outputs discarded");
      } else {
        const ms = Date.now() - started;
        await jobs.log(row.id, "info", `Completed in ${(ms / 1000).toFixed(1)}s`, { stages: stageTimes, outputs: saved.map((m) => m.id) });
        log.info({ provider: providerId, model, durationMs: ms, stages: stageTimes, outputs: saved.length }, "job completed");
      }
    } catch (e) {
      const ms = Date.now() - started;
      if (e instanceof AbortedError || ctrl.signal.aborted) {
        if (this.stopped && !(await jobs.isCancelled(row.id))) {
          await jobs.release(row.id);
          await jobs.log(row.id, "warn", "Worker shutting down, job returned to the queue");
          log.warn("job released (worker shutdown)");
        } else {
          await jobs.log(row.id, "warn", "Cancelled by user", { atStage: currentStage });
          log.info({ provider: providerId, durationMs: ms }, "job cancelled");
        }
      } else {
        const err = e as Error;
        const pe = e instanceof ProviderError ? e : null;
        const code = pe?.code ?? (err as { code?: string }).code ?? "internal_error";
        const retryable = pe?.retryable ?? false;
        const status = await jobs.fail(row.id, err.message, code, retryable, backoffSec);
        await jobs.log(row.id, "error", err.message, { code, retryable, stage: currentStage, provider: providerId, next: status });
        log.error({ provider: providerId, model, stage: currentStage, code, retryable, next: status, durationMs: ms, err: err.message }, "job failed");
      }
    } finally {
      clearInterval(watch);
      clearInterval(heartbeat);
      this.running.delete(row.id);
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  }

  private async store(row: JobRow, file: string, name: string, mime: string, kind: "image" | "video", seed: number | null) {
    const info = await probe(file);
    const thumbLocal = `${file}.thumb.jpg`;
    await makeThumbnail(file, thumbLocal, kind === "video" ? info.durationSec : null);
    const key = `outputs/${row.owner_id}/${row.id}/${row.attempts}-${name}`;
    const thumbKey = `${key}.thumb.jpg`;
    const size = await this.d.storage.putFile(key, file, mime);
    await this.d.storage.putFile(thumbKey, thumbLocal, "image/jpeg");
    return {
      ownerId: row.owner_id,
      projectId: row.project_id,
      kind,
      source: "generated" as const,
      storageKey: key,
      thumbKey,
      mime,
      width: info.width,
      height: info.height,
      durationSec: kind === "video" ? info.durationSec : null,
      sizeBytes: size,
      seed,
    };
  }

  private async file(row: JobRow, id: string | null | undefined): Promise<string | undefined> {
    if (!id) return undefined;
    const m = await this.d.media.get(id, row.owner_id);
    if (!m) throw new ProviderError(`Le média source ${id} n'existe plus`, "missing_input");
    return this.d.storage.localPath(m.storage_key);
  }

  private async imageInputs(row: JobRow, p: ImageParams): Promise<ImageInputs> {
    const missing = missingImageInputs(p);
    if (missing.length) throw new ProviderError(`Entrée manquante : ${missing.join(", ")}`, "missing_input");
    return {
      source: await this.file(row, p.sourceMediaId),
      mask: await this.file(row, p.maskMediaId),
      references: await Promise.all(p.references.map(async (r) => ({ path: (await this.file(row, r.mediaId))!, type: r.type, weight: r.weight }))),
    };
  }

  private async videoInputs(row: JobRow, p: VideoParams, workDir: string, signal: AbortSignal): Promise<VideoInputs> {
    const missing = missingVideoInputs(p);
    if (missing.length) throw new ProviderError(`Entrée manquante : ${missing.join(", ")}`, "missing_input");
    const { first, last } = firstLastFrames(p);
    const inputs: VideoInputs = {
      image: await this.file(row, p.operation === "first_last_frame" ? first : p.sourceImageId),
      endImage: p.operation === "first_last_frame" ? await this.file(row, last) : undefined,
      keyframes: await Promise.all(p.keyframes.map(async (k) => ({ path: (await this.file(row, k.mediaId))!, position: k.position }))),
      reference: await this.file(row, p.referenceImageId),
      video: await this.file(row, p.sourceVideoId),
    };
    if (p.operation === "extend") {
      inputs.extendSource = await this.file(row, p.extendMediaId);
      inputs.extendLastFrame = path.join(workDir, "extend_last_frame.png");
      await extractFrame(inputs.extendSource!, inputs.extendLastFrame, "last", signal);
    }
    return inputs;
  }
}
