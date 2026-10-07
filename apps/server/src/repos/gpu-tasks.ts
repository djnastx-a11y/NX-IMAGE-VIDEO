import type { Pool } from "../db/pool.js";

export type GpuTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface GpuTaskOutput {
  index: number;
  key: string;
  mime: string;
  seed: number | null;
}

export interface GpuTaskRow {
  id: string;
  agent_id: string;
  job_id: string | null;
  engine: string;
  operation: string;
  params: unknown;
  files: Record<string, string>;
  status: GpuTaskStatus;
  stage: string | null;
  progress: number;
  error: string | null;
  retryable: boolean;
  outputs: GpuTaskOutput[];
  cancel_requested: boolean;
  heartbeat_at: Date | null;
  created_at: Date;
}

export interface GpuAgentRow {
  id: string;
  last_seen_at: Date;
  info: {
    gpu?: string;
    version?: string;
    engines?: {
      id: string;
      capabilities?: string[];
      limits?: Record<string, unknown>;
    }[];
    failed_engines?: { id: string; error?: string }[];
  };
}

/** Work handed to GPU agents (pull mode). See providers/remote/agent-transport.ts. */
export class GpuTasksRepo {
  constructor(private readonly pool: Pool) {}

  async create(t: {
    id: string;
    agentId: string;
    jobId: string;
    engine: string;
    operation: string;
    params: unknown;
    files: Record<string, string>;
  }): Promise<void> {
    await this.pool.query(
      "INSERT INTO gpu_tasks (id, agent_id, job_id, engine, operation, params, files) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        t.id,
        t.agentId,
        t.jobId,
        t.engine,
        t.operation,
        JSON.stringify(t.params),
        JSON.stringify(t.files),
      ],
    );
  }

  async get(id: string): Promise<GpuTaskRow | undefined> {
    const { rows } = await this.pool.query<GpuTaskRow>(
      "SELECT * FROM gpu_tasks WHERE id = $1",
      [id],
    );
    return rows[0];
  }

  async forAgent(id: string, agentId: string): Promise<GpuTaskRow | undefined> {
    const { rows } = await this.pool.query<GpuTaskRow>(
      "SELECT * FROM gpu_tasks WHERE id = $1 AND agent_id = $2",
      [id, agentId],
    );
    return rows[0];
  }

  /** The oldest queued task for this agent, marked running (safe with several agents sharing an id). */
  async claim(agentId: string): Promise<GpuTaskRow | undefined> {
    const { rows } = await this.pool.query<GpuTaskRow>(
      `UPDATE gpu_tasks SET status = 'running', heartbeat_at = now(), updated_at = now()
       WHERE id = (SELECT id FROM gpu_tasks WHERE agent_id = $1 AND status = 'queued' AND NOT cancel_requested
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [agentId],
    );
    return rows[0];
  }

  /** Agent progress report; returns whether the task should stop. */
  async progress(
    id: string,
    progress: number,
    stage: string | null,
  ): Promise<boolean> {
    const { rows } = await this.pool.query<{ cancel_requested: boolean }>(
      `UPDATE gpu_tasks SET progress = $2, stage = COALESCE($3, stage), heartbeat_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'running' RETURNING cancel_requested`,
      [id, progress, stage],
    );
    return rows[0]?.cancel_requested ?? true;
  }

  async addOutput(id: string, output: GpuTaskOutput): Promise<void> {
    await this.pool.query(
      "UPDATE gpu_tasks SET outputs = outputs || $2::jsonb, heartbeat_at = now(), updated_at = now() WHERE id = $1",
      [id, JSON.stringify([output])],
    );
  }

  async finish(
    id: string,
    status: Exclude<GpuTaskStatus, "queued" | "running">,
    error: string | null = null,
    retryable = false,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE gpu_tasks SET status = $2, error = $3, retryable = $4, progress = CASE WHEN $2 = 'completed' THEN 1 ELSE progress END, updated_at = now() WHERE id = $1 AND status IN ('queued', 'running')",
      [id, status, error, retryable],
    );
  }

  async requestCancel(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE gpu_tasks SET cancel_requested = true, updated_at = now() WHERE id = $1",
      [id],
    );
    await this.pool.query(
      "UPDATE gpu_tasks SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'queued'",
      [id],
    );
  }

  async delete(id: string): Promise<void> {
    await this.pool.query("DELETE FROM gpu_tasks WHERE id = $1", [id]);
  }

  async heartbeat(agentId: string, info: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO gpu_agents (id, last_seen_at, info) VALUES ($1, now(), COALESCE($2::jsonb, '{}'::jsonb))
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), info = COALESCE($2::jsonb, gpu_agents.info)`,
      [agentId, info === undefined ? null : JSON.stringify(info)],
    );
  }

  async agent(agentId: string): Promise<GpuAgentRow | undefined> {
    const { rows } = await this.pool.query<GpuAgentRow>(
      "SELECT * FROM gpu_agents WHERE id = $1",
      [agentId],
    );
    return rows[0];
  }
}
