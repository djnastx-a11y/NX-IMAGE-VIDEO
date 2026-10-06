import type { Job, JobKind, JobLog, JobParams, JobStatus, Module, Operation } from "@nx/shared";
import { tx, type Pool, type Queryable } from "../db/pool.js";
import { mediaDto, type MediaRepo, type MediaRow, type NewMedia } from "./media.js";

export interface JobRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  module: Module;
  operation: Operation;
  kind: JobKind;
  parent_job_id: string | null;
  batch_id: string;
  params: JobParams;
  provider_id: string | null;
  model: string | null;
  status: JobStatus;
  stage: string | null;
  progress: number;
  priority: number;
  attempts: number;
  max_attempts: number;
  error: string | null;
  error_code: string | null;
  cancel_requested: boolean;
  run_after: Date;
  worker_id: string | null;
  heartbeat_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  duration_ms: number | null;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface NewJob {
  ownerId: string;
  projectId: string | null;
  module: Module;
  operation: Operation;
  kind: JobKind;
  parentJobId: string | null;
  batchId: string;
  params: JobParams;
  priority: number;
  maxAttempts: number;
}

export interface JobFilter {
  module?: Module;
  status?: "active" | "completed" | "failed" | "all";
  projectId?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

const RUNNING = "('starting','processing','encoding')";
const ACTIVE = "('queued','starting','processing','encoding')";

/** Media ids a job reads from (shown as "fichier source" in the history). */
export function sourceMediaIds(p: JobParams): string[] {
  const ids: (string | null | undefined)[] = [];
  const a = p as unknown as Record<string, unknown>;
  for (const k of ["sourceMediaId", "maskMediaId", "sourceImageId", "referenceImageId", "sourceVideoId", "extendMediaId"]) ids.push(a[k] as string | null);
  for (const r of (a.references as { mediaId: string }[] | undefined) ?? []) ids.push(r.mediaId);
  for (const k of (a.keyframes as { mediaId: string }[] | undefined) ?? []) ids.push(k.mediaId);
  return [...new Set(ids.filter((x): x is string => !!x))];
}

export class JobsRepo {
  constructor(
    private readonly pool: Pool,
    private readonly media: MediaRepo,
  ) {}

  async create(items: NewJob[]): Promise<JobRow[]> {
    return tx(this.pool, async (c) => {
      const out: JobRow[] = [];
      for (const j of items) {
        const { rows } = await c.query<JobRow>(
          `INSERT INTO generation_jobs (owner_id, project_id, module, operation, kind, parent_job_id, batch_id, params, priority, max_attempts)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [j.ownerId, j.projectId, j.module, j.operation, j.kind, j.parentJobId, j.batchId, JSON.stringify(j.params), j.priority, j.maxAttempts],
        );
        out.push(rows[0]!);
        await c.query("INSERT INTO job_logs (job_id, message, data) VALUES ($1, $2, $3)", [
          rows[0]!.id,
          `Job created (${j.kind})`,
          JSON.stringify({ operation: j.operation, model: (j.params as { model: string }).model }),
        ]);
      }
      return out;
    });
  }

  async get(id: string, ownerId?: string): Promise<JobRow | undefined> {
    const { rows } = await this.pool.query<JobRow>(
      "SELECT * FROM generation_jobs WHERE id = $1 AND ($2::uuid IS NULL OR owner_id = $2) AND deleted_at IS NULL",
      [id, ownerId ?? null],
    );
    return rows[0];
  }

  async getAny(id: string): Promise<JobRow | undefined> {
    return (await this.pool.query<JobRow>("SELECT * FROM generation_jobs WHERE id = $1", [id])).rows[0];
  }

  async list(ownerId: string, f: JobFilter): Promise<{ rows: JobRow[]; total: number }> {
    const where = ["owner_id = $1", "deleted_at IS NULL"];
    const args: unknown[] = [ownerId];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace("?", `$${args.length}`));
    };
    if (f.module) add("module = ?", f.module);
    if (f.status === "active") where.push(`status IN ${ACTIVE}`);
    if (f.status === "completed") where.push("status = 'completed'");
    if (f.status === "failed") where.push("status IN ('failed','cancelled')");
    if (f.projectId) add("project_id = ?", f.projectId);
    if (f.q) add("(params->>'prompt' || ' ' || COALESCE(params->>'instruction','') || ' ' || COALESCE(provider_id,'')) ILIKE ?", `%${f.q}%`);
    const w = where.join(" AND ");
    const total = (await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM generation_jobs WHERE ${w}`, args)).rows[0]!.n;
    args.push(f.limit ?? 50, f.offset ?? 0);
    const rows = (
      await this.pool.query<JobRow>(
        `SELECT * FROM generation_jobs WHERE ${w} ORDER BY created_at DESC, id LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args,
      )
    ).rows;
    return { rows, total };
  }

  async queuePositions(): Promise<Map<string, number>> {
    const { rows } = await this.pool.query<{ id: string }>(
      "SELECT id FROM generation_jobs WHERE status = 'queued' AND deleted_at IS NULL ORDER BY priority DESC, created_at, id",
    );
    return new Map(rows.map((r, i) => [r.id, i + 1]));
  }

  /** Builds API objects for many jobs with two batched queries (outputs + sources). */
  async dtos(rows: JobRow[]): Promise<Job[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const outputs = (
      await this.pool.query<MediaRow & { out_job: string; idx: number }>(
        `SELECT m.*, o.job_id AS out_job, o.idx, COALESCE(j.params->>'prompt','') AS prompt FROM generation_outputs o
         JOIN media m ON m.id = o.media_id JOIN generation_jobs j ON j.id = o.job_id
         WHERE o.job_id = ANY($1::uuid[]) AND m.deleted_at IS NULL ORDER BY o.idx`,
        [ids],
      )
    ).rows;
    const srcIds = [...new Set(rows.flatMap((r) => sourceMediaIds(r.params)))];
    const sources = new Map((await this.media.getMany(srcIds)).map((m) => [m.id, m]));
    const positions = rows.some((r) => r.status === "queued") ? await this.queuePositions() : new Map<string, number>();
    return rows.map((r) => ({
      id: r.id,
      module: r.module,
      operation: r.operation,
      kind: r.kind,
      parentJobId: r.parent_job_id,
      batchId: r.batch_id,
      projectId: r.project_id,
      userId: r.owner_id,
      params: r.params,
      providerId: r.provider_id,
      model: r.model,
      status: r.status,
      stage: r.stage,
      progress: r.progress,
      priority: r.priority,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      error: r.error,
      createdAt: r.created_at.toISOString(),
      startedAt: r.started_at?.toISOString() ?? null,
      finishedAt: r.finished_at?.toISOString() ?? null,
      updatedAt: r.updated_at.toISOString(),
      durationMs: r.duration_ms,
      queuePosition: r.status === "queued" ? positions.get(r.id) ?? null : null,
      outputs: outputs.filter((o) => o.out_job === r.id).map(mediaDto),
      sources: sourceMediaIds(r.params)
        .map((id) => sources.get(id))
        .filter((m): m is MediaRow => !!m)
        .map(mediaDto),
    }));
  }

  async dto(row: JobRow): Promise<Job> {
    return (await this.dtos([row]))[0]!;
  }

  // ------------------------------------------------------------------ worker side

  /** Atomically claims the next runnable job (highest priority, oldest first). Safe across many workers. */
  async claimNext(workerId: string): Promise<JobRow | undefined> {
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE generation_jobs SET status = 'starting', stage = 'Allocating worker', progress = 0, worker_id = $1,
         heartbeat_at = now(), started_at = now(), finished_at = NULL, attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM generation_jobs
         WHERE status = 'queued' AND deleted_at IS NULL AND run_after <= now()
         ORDER BY priority DESC, created_at, id
         LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      [workerId],
    );
    return rows[0];
  }

  /** Worker progress update. Returns false when the job was cancelled/deleted meanwhile (the worker must stop). */
  async updateRunning(id: string, p: { status?: JobStatus; stage?: string | null; progress?: number; providerId?: string; model?: string }): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE generation_jobs SET status = COALESCE($2, status), stage = CASE WHEN $3 THEN $4 ELSE stage END,
         progress = COALESCE($5, progress), provider_id = COALESCE($6, provider_id), model = COALESCE($7, model),
         heartbeat_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ${RUNNING} AND NOT cancel_requested AND deleted_at IS NULL`,
      [id, p.status ?? null, p.stage !== undefined, p.stage ?? null, p.progress ?? null, p.providerId ?? null, p.model ?? null],
    );
    return r.rowCount === 1;
  }

  async isCancelled(id: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ c: boolean }>(
      "SELECT (cancel_requested OR deleted_at IS NOT NULL OR status = 'cancelled') AS c FROM generation_jobs WHERE id = $1",
      [id],
    );
    return rows[0]?.c ?? true;
  }

  /** Stores outputs and marks the job completed in one transaction. Returns null if the job was cancelled at the last moment. */
  async complete(id: string, outputs: (NewMedia & { seed: number | null })[]): Promise<MediaRow[] | null> {
    try {
      return await tx(this.pool, async (c) => {
        const job = (
          await c.query<JobRow>(
            `SELECT * FROM generation_jobs WHERE id = $1 AND status IN ${RUNNING} AND NOT cancel_requested AND deleted_at IS NULL FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!job) throw new CancelledDuringCommit();
        const rows: MediaRow[] = [];
        for (const [i, o] of outputs.entries()) {
          const m = await this.media.insert({ ...o, jobId: id }, c);
          await c.query("INSERT INTO generation_outputs (job_id, media_id, idx, seed) VALUES ($1, $2, $3, $4)", [id, m.id, i, o.seed]);
          rows.push(m);
        }
        await c.query(
          `UPDATE generation_jobs SET status = 'completed', stage = NULL, progress = 1, error = NULL, error_code = NULL,
             finished_at = now(), duration_ms = (extract(epoch from (now() - started_at)) * 1000)::int, heartbeat_at = now(), updated_at = now()
           WHERE id = $1`,
          [id],
        );
        return rows;
      });
    } catch (e) {
      if (e instanceof CancelledDuringCommit) return null;
      throw e;
    }
  }

  /**
   * Records a failure. Retryable errors go back to the queue with linear backoff while attempts remain;
   * otherwise the job is failed. Returns the resulting status.
   */
  async fail(id: string, error: string, code: string, retryable: boolean, backoffSec: number): Promise<JobStatus | null> {
    const { rows } = await this.pool.query<{ status: JobStatus }>(
      `UPDATE generation_jobs SET
         status = CASE WHEN $4 AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
         run_after = CASE WHEN $4 AND attempts < max_attempts THEN now() + make_interval(secs => $5 * attempts) ELSE run_after END,
         stage = CASE WHEN $4 AND attempts < max_attempts THEN 'Retry scheduled' ELSE NULL END,
         progress = CASE WHEN $4 AND attempts < max_attempts THEN 0 ELSE progress END,
         finished_at = CASE WHEN $4 AND attempts < max_attempts THEN NULL ELSE now() END,
         duration_ms = (extract(epoch from (now() - started_at)) * 1000)::int,
         worker_id = NULL, error = $2, error_code = $3, updated_at = now()
       WHERE id = $1 AND status IN ${RUNNING} AND NOT cancel_requested
       RETURNING status`,
      [id, error.slice(0, 4000), code, retryable, backoffSec],
    );
    return rows[0]?.status ?? null;
  }

  /** Graceful shutdown: hand a running job back to the queue without consuming an attempt. */
  async release(id: string) {
    await this.pool.query(
      `UPDATE generation_jobs SET status = 'queued', stage = NULL, progress = 0, worker_id = NULL,
         attempts = GREATEST(0, attempts - 1), updated_at = now()
       WHERE id = $1 AND status IN ${RUNNING} AND NOT cancel_requested`,
      [id],
    );
  }

  /** Jobs whose worker stopped heartbeating (crash, OOM, redeploy) go back to the queue, or fail when out of attempts. */
  async requeueStale(leaseSeconds: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE generation_jobs SET
         status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
         error = CASE WHEN attempts < max_attempts THEN error ELSE 'Worker stopped responding' END,
         error_code = CASE WHEN attempts < max_attempts THEN error_code ELSE 'worker_lost' END,
         finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END,
         stage = NULL, progress = 0, worker_id = NULL, updated_at = now()
       WHERE status IN ${RUNNING} AND heartbeat_at < now() - make_interval(secs => $1)
       RETURNING id`,
      [leaseSeconds],
    );
    return rows.map((r) => r.id);
  }

  // ------------------------------------------------------------------ user actions

  async cancel(id: string, ownerId: string): Promise<JobRow | undefined> {
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE generation_jobs SET status = 'cancelled', cancel_requested = true, stage = NULL, finished_at = now(), updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND status IN ${ACTIVE} AND deleted_at IS NULL RETURNING *`,
      [id, ownerId],
    );
    return rows[0];
  }

  /** Manual retry: same job, same parameters, fresh attempt budget. */
  async retry(id: string, ownerId: string): Promise<JobRow | undefined> {
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE generation_jobs SET status = 'queued', stage = NULL, progress = 0, error = NULL, error_code = NULL, cancel_requested = false,
         attempts = 0, run_after = now(), worker_id = NULL, heartbeat_at = NULL, started_at = NULL, finished_at = NULL, duration_ms = NULL,
         updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND status IN ('failed','cancelled') AND deleted_at IS NULL RETURNING *`,
      [id, ownerId],
    );
    return rows[0];
  }

  async setPriority(id: string, ownerId: string, priority: number): Promise<JobRow | undefined> {
    const { rows } = await this.pool.query<JobRow>(
      "UPDATE generation_jobs SET priority = $3, updated_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING *",
      [id, ownerId, priority],
    );
    return rows[0];
  }

  async setProject(id: string, ownerId: string, projectId: string | null): Promise<JobRow | undefined> {
    return tx(this.pool, async (c) => {
      const { rows } = await c.query<JobRow>(
        "UPDATE generation_jobs SET project_id = $3, updated_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING *",
        [id, ownerId, projectId],
      );
      await c.query("UPDATE media SET project_id = $2 WHERE job_id = $1", [id, projectId]);
      return rows[0];
    });
  }

  /** Deletes a job from the history (cancelling it if still active). Its outputs are deleted too. */
  async softDelete(id: string, ownerId: string): Promise<boolean> {
    return tx(this.pool, async (c) => {
      const r = await c.query(
        `UPDATE generation_jobs SET deleted_at = now(), cancel_requested = true,
           status = CASE WHEN status IN ${ACTIVE} THEN 'cancelled' ELSE status END, updated_at = now()
         WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
        [id, ownerId],
      );
      await c.query("UPDATE media SET deleted_at = now() WHERE job_id = $1 AND deleted_at IS NULL", [id]);
      return r.rowCount === 1;
    });
  }

  // ------------------------------------------------------------------ logs & stats

  async log(jobId: string, level: JobLog["level"], message: string, data?: Record<string, unknown>, db: Queryable = this.pool) {
    await db.query("INSERT INTO job_logs (job_id, level, message, data) VALUES ($1, $2, $3, $4)", [
      jobId,
      level,
      message.slice(0, 2000),
      data ? JSON.stringify(data) : null,
    ]);
  }

  async logs(jobId: string): Promise<JobLog[]> {
    const { rows } = await this.pool.query<{ at: Date; level: JobLog["level"]; message: string; data: Record<string, unknown> | null }>(
      "SELECT at, level, message, data FROM job_logs WHERE job_id = $1 ORDER BY id",
      [jobId],
    );
    return rows.map((r) => ({ at: r.at.toISOString(), level: r.level, message: r.message, data: r.data }));
  }

  async stats(ownerId?: string): Promise<Record<JobStatus, number>> {
    const { rows } = await this.pool.query<{ status: JobStatus; n: number }>(
      "SELECT status, count(*)::int AS n FROM generation_jobs WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR owner_id = $1) GROUP BY status",
      [ownerId ?? null],
    );
    const out: Record<JobStatus, number> = { queued: 0, starting: 0, processing: 0, encoding: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  async workers(): Promise<{ workerId: string; running: number; lastHeartbeat: string }[]> {
    const { rows } = await this.pool.query<{ worker_id: string; n: number; hb: Date }>(
      `SELECT worker_id, count(*)::int AS n, max(heartbeat_at) AS hb FROM generation_jobs
       WHERE status IN ${RUNNING} AND worker_id IS NOT NULL GROUP BY worker_id`,
    );
    return rows.map((r) => ({ workerId: r.worker_id, running: r.n, lastHeartbeat: r.hb.toISOString() }));
  }
}

class CancelledDuringCommit extends Error {}
