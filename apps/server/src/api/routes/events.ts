import type { FastifyInstance } from "fastify";
import type { ServerEvent } from "@nx/shared";
import type { ApiContext } from "../app.js";

/** Server-Sent Events: pushes every change of the user's jobs (fed by Postgres LISTEN/NOTIFY). */
export async function eventRoutes(app: FastifyInstance, { s, requireUser }: ApiContext) {
  app.get("/api/events", async (req, reply) => {
    const u = requireUser(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (e: ServerEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: "ping", at: new Date().toISOString() });

    // Coalesce bursts of notifications for the same job (progress updates) into one push per 250ms.
    const pending = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    const flush = async () => {
      timer = null;
      const ids = [...pending];
      pending.clear();
      for (const id of ids) {
        const row = await s.jobs.getAny(id);
        if (!row || row.owner_id !== u.id) continue;
        if (row.deleted_at) send({ type: "job_deleted", id });
        else send({ type: "job", job: await s.jobs.dto(row) });
      }
    };
    const onJob = (id: string, owner: string) => {
      if (owner !== u.id) return;
      pending.add(id);
      timer ??= setTimeout(() => void flush().catch((e) => req.log.error(e)), 250);
    };
    s.events.on("job", onJob);
    const ping = setInterval(() => send({ type: "ping", at: new Date().toISOString() }), 20_000);
    req.raw.on("close", () => {
      s.events.off("job", onJob);
      clearInterval(ping);
      if (timer) clearTimeout(timer);
    });
  });
}
