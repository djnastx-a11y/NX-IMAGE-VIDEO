import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { GpuAgentConfig } from "../../config.js";
import { HttpError } from "../../lib/errors.js";
import type { ApiContext } from "../app.js";

const OUTPUT_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
};
const MAX_WAIT_SEC = 25;

/**
 * API for GPU agents (pull mode, see providers/remote/agent-transport.ts and gpu-worker/nx_gpu/agent.py).
 * An agent authenticates with `Authorization: Bearer <token>`, the token being the value of the variable
 * its NX_GPU_AGENTS entry names. It only ever sees its own tasks.
 */
export async function gpuAgentRoutes(app: FastifyInstance, { s }: ApiContext) {
  const agents = s.config.gpuAgents;

  function agentOf(req: FastifyRequest): GpuAgentConfig {
    const given = Buffer.from(
      req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "",
    );
    for (const a of agents) {
      const token = process.env[a.tokenEnv];
      if (!token) continue;
      const expected = Buffer.from(token);
      if (given.length === expected.length && timingSafeEqual(given, expected))
        return a;
    }
    throw new HttpError(401, "Unknown GPU agent token", "unauthenticated");
  }

  async function taskOf(req: FastifyRequest) {
    const agent = agentOf(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const task = await s.gpuTasks.forAgent(id, agent.id);
    if (!task) throw new HttpError(404, "Unknown task", "not_found");
    return task;
  }

  const engineInfo = z
    .object({
      id: z.string(),
      capabilities: z.array(z.string()).optional(),
      limits: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough();

  app.post("/api/gpu-agent/heartbeat", async (req) => {
    const agent = agentOf(req);
    const b = z
      .object({
        gpu: z.string().max(200).optional(),
        version: z.string().max(50).optional(),
        engines: z.array(engineInfo).max(50).default([]),
        failed_engines: z
          .array(
            z
              .object({ id: z.string(), error: z.string().optional() })
              .passthrough(),
          )
          .max(50)
          .default([]),
      })
      .parse(req.body ?? {});
    await s.gpuTasks.heartbeat(agent.id, b);
    return { ok: true, agent: agent.id, expected_engines: agent.engines };
  });

  /** Long poll: returns the next task as soon as there is one, or { task: null } after `wait` seconds. */
  app.post("/api/gpu-agent/claim", async (req) => {
    const agent = agentOf(req);
    const { wait } = z
      .object({ wait: z.number().min(0).max(MAX_WAIT_SEC).default(20) })
      .parse(req.body ?? {});
    const end = Date.now() + wait * 1000;
    // the request stream is already finished here (req.raw.destroyed is true once the body is read):
    // only the socket says whether the agent hung up
    const socket = req.raw.socket;
    for (;;) {
      await s.gpuTasks.heartbeat(agent.id, undefined);
      const task = await s.gpuTasks.claim(agent.id);
      if (task) {
        req.log.info(
          {
            agent: agent.id,
            task: task.id,
            engine: task.engine,
            job: task.job_id,
          },
          "gpu task claimed",
        );
        return {
          task: {
            id: task.id,
            job_id: task.job_id,
            engine: task.engine,
            operation: task.operation,
            params: task.params,
            files: Object.keys(task.files),
          },
        };
      }
      if (Date.now() >= end || socket.destroyed) return { task: null };
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  app.get("/api/gpu-agent/tasks/:id/files/:field", async (req, reply) => {
    const task = await taskOf(req);
    const { field } = z.object({ field: z.string() }).parse(req.params);
    const key = task.files[field];
    if (!key) throw new HttpError(404, "Unknown file", "not_found");
    const file = await s.storage.localPath(key);
    return reply
      .type("application/octet-stream")
      .send(fs.createReadStream(file));
  });

  app.post("/api/gpu-agent/tasks/:id/progress", async (req) => {
    const task = await taskOf(req);
    const b = z
      .object({
        progress: z.number().min(0).max(1),
        stage: z.string().max(200).nullable().optional(),
      })
      .parse(req.body ?? {});
    const cancel =
      task.status !== "running" ||
      (await s.gpuTasks.progress(task.id, b.progress, b.stage ?? null));
    return { cancel };
  });

  app.post("/api/gpu-agent/tasks/:id/outputs", async (req) => {
    const task = await taskOf(req);
    if (task.status !== "running")
      throw new HttpError(409, "Task is not running", "not_running");
    const q = z
      .object({
        index: z.coerce.number().int().min(0).max(15),
        mime: z.enum(Object.keys(OUTPUT_EXT) as [string, ...string[]]),
        seed: z.coerce.number().int().nullable().optional(),
      })
      .parse(req.query);
    const file = await req.file();
    if (!file) throw new HttpError(400, "No file", "no_file");
    const tmp = path.join(os.tmpdir(), `nx-agent-${randomUUID()}`);
    await pipeline(file.file, fs.createWriteStream(tmp));
    if (file.file.truncated) {
      fs.rmSync(tmp, { force: true });
      throw new HttpError(413, "Output too large", "too_large");
    }
    const key = `gpu-tasks/${task.id}/out_${q.index}.${OUTPUT_EXT[q.mime]}`;
    await s.storage.putFile(key, tmp, q.mime);
    await s.gpuTasks.addOutput(task.id, {
      index: q.index,
      key,
      mime: q.mime,
      seed: q.seed ?? null,
    });
    return { ok: true };
  });

  app.post("/api/gpu-agent/tasks/:id/complete", async (req) => {
    const task = await taskOf(req);
    if (!task.outputs.length)
      throw new HttpError(409, "Upload the outputs first", "no_output");
    await s.gpuTasks.finish(task.id, "completed");
    return { ok: true };
  });

  app.post("/api/gpu-agent/tasks/:id/fail", async (req) => {
    const task = await taskOf(req);
    const b = z
      .object({
        error: z.string().max(4000).default("GPU agent error"),
        retryable: z.boolean().default(false),
        cancelled: z.boolean().default(false),
      })
      .parse(req.body ?? {});
    await s.gpuTasks.finish(
      task.id,
      b.cancelled ? "cancelled" : "failed",
      b.cancelled ? null : b.error,
      b.retryable,
    );
    return { ok: true };
  });
}
