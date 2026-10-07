import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { GpuAgentConfig } from "../../config.js";
import { AbortedError, ProviderError } from "../../lib/errors.js";
import type { GpuTasksRepo } from "../../repos/gpu-tasks.js";
import type { StorageProvider } from "../../storage/storage.js";
import type { ProviderContext, ProviderOutput } from "../types.js";
import type { GpuTransport, RemoteHealth } from "./gpu-client.js";

/** An agent not seen for this long is offline (it heartbeats every few seconds while it runs). */
export const AGENT_OFFLINE_MS = 45_000;
/** A running task whose agent stopped reporting for this long is lost (Kaggle session ended, PC asleep...). */
const TASK_LOST_MS = 90_000;
/** A queued task gives up when its agent stays offline this long; the job is then retried or fails. */
const QUEUED_OFFLINE_MS = 120_000;

/**
 * Pull mode: the GPU machine (an "agent") connects out to NX STUDIO and asks for work, so it needs no
 * public address. Here a job becomes a row in gpu_tasks plus its input files in the storage; the agent
 * claims it through /api/gpu-agent, uploads the outputs, and this transport collects them.
 */
export class AgentTransport implements GpuTransport {
  private healthCache: { at: number; value: RemoteHealth } | null = null;

  constructor(
    readonly agent: GpuAgentConfig,
    private readonly tasks: GpuTasksRepo,
    private readonly storage: StorageProvider,
    private readonly pollMs = 1000,
  ) {}

  get id() {
    return this.agent.id;
  }
  get label() {
    return `${this.agent.id} (agent)`;
  }

  async health(): Promise<RemoteHealth> {
    if (this.healthCache && Date.now() - this.healthCache.at < 3000)
      return this.healthCache.value;
    const row = await this.tasks.agent(this.agent.id);
    if (!row)
      throw new Error(`GPU agent "${this.agent.id}" has never connected`);
    const age = Date.now() - row.last_seen_at.getTime();
    if (age > AGENT_OFFLINE_MS)
      throw new Error(
        `GPU agent "${this.agent.id}" offline (last seen ${Math.round(age / 60000)} min ago)`,
      );
    const value: RemoteHealth = {
      ok: true,
      gpu: row.info.gpu,
      engines: row.info.engines ?? [],
    };
    this.healthCache = { at: Date.now(), value };
    return value;
  }

  async run(
    engine: string,
    operation: string,
    params: unknown,
    files: Record<string, string | undefined>,
    ctx: ProviderContext,
  ): Promise<ProviderOutput[]> {
    const id = randomUUID();
    const prefix = `gpu-tasks/${id}`;
    const keys: Record<string, string> = {};
    ctx.report("starting", 0.1, `Sending inputs to ${this.agent.id}`);
    try {
      for (const [field, file] of Object.entries(files)) {
        if (!file) continue;
        // putFile may move its source: hand it a copy, the worker still owns the original
        const copy = path.join(
          ctx.workDir,
          `agent_in_${field}${path.extname(file)}`,
        );
        await fsp.copyFile(file, copy);
        keys[field] =
          `${prefix}/in_${field}${path.extname(file).toLowerCase()}`;
        await this.storage.putFile(
          keys[field]!,
          copy,
          "application/octet-stream",
        );
      }
      await this.tasks.create({
        id,
        agentId: this.agent.id,
        jobId: ctx.jobId,
        engine,
        operation,
        params,
        files: keys,
      });
      ctx.log("agent task queued", { agent: this.agent.id, task: id, engine });

      let task = await this.tasks.get(id);
      let offlineSince: number | null = null;
      for (;;) {
        await new Promise((r) => setTimeout(r, this.pollMs));
        if (ctx.signal.aborted) {
          await this.tasks.requestCancel(id);
          throw new AbortedError();
        }
        task = await this.tasks.get(id);
        if (!task)
          throw new ProviderError("GPU task vanished", "gpu_task_lost", true);
        if (task.status === "queued") {
          ctx.report("starting", 0.4, `Waiting for ${this.agent.id}`);
          const agent = await this.tasks.agent(this.agent.id);
          const offline =
            !agent ||
            Date.now() - agent.last_seen_at.getTime() > AGENT_OFFLINE_MS;
          offlineSince = offline ? (offlineSince ?? Date.now()) : null;
          if (offlineSince && Date.now() - offlineSince > QUEUED_OFFLINE_MS) {
            await this.tasks.requestCancel(id);
            throw new ProviderError(
              `GPU agent "${this.agent.id}" is offline`,
              "gpu_agent_offline",
              true,
            );
          }
        } else if (task.status === "running") {
          if (
            task.heartbeat_at &&
            Date.now() - task.heartbeat_at.getTime() > TASK_LOST_MS
          ) {
            await this.tasks.finish(
              id,
              "failed",
              "agent stopped reporting",
              true,
            );
            throw new ProviderError(
              `Lost contact with GPU agent "${this.agent.id}"`,
              "gpu_lost",
              true,
            );
          }
          ctx.report("processing", task.progress, task.stage ?? undefined);
        } else if (task.status === "failed") {
          throw new ProviderError(
            task.error ?? "Remote generation failed",
            "gpu_job_failed",
            task.retryable,
          );
        } else if (task.status === "cancelled") {
          throw new AbortedError();
        } else {
          break;
        }
      }
      if (!task.outputs.length)
        throw new ProviderError(
          "GPU agent returned no output",
          "gpu_no_output",
          true,
        );
      const outputs: ProviderOutput[] = [];
      for (const o of [...task.outputs].sort((a, b) => a.index - b.index)) {
        const out = path.join(
          ctx.workDir,
          `remote_${o.index}.${o.mime.includes("video") ? "mp4" : "png"}`,
        );
        await fsp.copyFile(await this.storage.localPath(o.key), out);
        keys[`out_${o.index}`] = o.key;
        outputs.push({ path: out, seed: o.seed });
      }
      ctx.report("processing", 1);
      return outputs;
    } finally {
      const latest = await this.tasks.get(id).catch(() => undefined);
      for (const o of latest?.outputs ?? []) keys[`out_${o.index}`] = o.key;
      await Promise.all(
        Object.values(keys).map((k) => this.storage.delete(k).catch(() => {})),
      );
      await this.tasks.delete(id).catch(() => {});
    }
  }
}
