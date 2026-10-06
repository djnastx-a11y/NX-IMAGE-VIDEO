import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../../lib/errors.js";
import type { ApiContext } from "../app.js";

const idParam = z.object({ id: z.string().uuid() });

export async function jobRoutes(app: FastifyInstance, { s, requireUser, jobService }: ApiContext) {
  const one = async (userId: string, id: string) => {
    const row = await s.jobs.get(id, userId);
    if (!row) throw new HttpError(404, "Génération introuvable");
    return row;
  };

  /** Generate (image: one job with N outputs; video: N variant jobs). */
  app.post("/api/jobs", async (req) => {
    const u = requireUser(req);
    return s.jobs.dtos(await jobService.create(u.id, req.body as never));
  });

  /** History (common to NX IMAGE and NX VIDEO) */
  app.get("/api/jobs", async (req) => {
    const u = requireUser(req);
    const q = z
      .object({
        module: z.enum(["image", "video"]).optional(),
        status: z.enum(["active", "completed", "failed", "all"]).optional(),
        projectId: z.string().uuid().optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const { rows, total } = await s.jobs.list(u.id, q);
    return { items: await s.jobs.dtos(rows), total };
  });

  app.get("/api/jobs/stats", async (req) => s.jobs.stats(requireUser(req).id));

  app.get("/api/jobs/:id", async (req) => {
    const u = requireUser(req);
    return s.jobs.dto(await one(u.id, idParam.parse(req.params).id));
  });

  app.get("/api/jobs/:id/logs", async (req) => {
    const u = requireUser(req);
    const row = await one(u.id, idParam.parse(req.params).id);
    return s.jobs.logs(row.id);
  });

  app.post("/api/jobs/:id/cancel", async (req) => {
    const u = requireUser(req);
    const row = await one(u.id, idParam.parse(req.params).id);
    const r = await s.jobs.cancel(row.id, u.id);
    if (!r) throw new HttpError(409, `Impossible d'annuler une génération « ${row.status} »`, "bad_state");
    await s.jobs.log(row.id, "warn", "Cancellation requested by user");
    return s.jobs.dto(r);
  });

  app.post("/api/jobs/:id/retry", async (req) => {
    const u = requireUser(req);
    const row = await one(u.id, idParam.parse(req.params).id);
    if (!["failed", "cancelled"].includes(row.status)) throw new HttpError(409, `Impossible de relancer une génération « ${row.status} »`, "bad_state");
    await s.registry.resolve(row.module, row.params as never);
    const r = await s.jobs.retry(row.id, u.id);
    if (!r) throw new HttpError(409, "La génération a changé d'état, réessaie", "bad_state");
    await s.jobs.log(row.id, "info", "Manual retry requested");
    s.pokeWorker?.();
    return s.jobs.dto(r);
  });

  app.post("/api/jobs/:id/regenerate", async (req) => s.jobs.dtos(await jobService.regenerate(requireUser(req).id, idParam.parse(req.params).id)));
  app.post("/api/jobs/:id/variation", async (req) => s.jobs.dtos(await jobService.variation(requireUser(req).id, idParam.parse(req.params).id, req.body)));
  app.post("/api/jobs/:id/duplicate", async (req) => {
    const body = z.object({ overrides: z.record(z.string(), z.unknown()).default({}) }).parse(req.body ?? {});
    return s.jobs.dtos(await jobService.duplicate(requireUser(req).id, idParam.parse(req.params).id, body.overrides));
  });
  app.post("/api/jobs/:id/extend", async (req) => s.jobs.dtos(await jobService.extend(requireUser(req).id, idParam.parse(req.params).id, req.body)));

  app.patch("/api/jobs/:id", async (req) => {
    const u = requireUser(req);
    const row = await one(u.id, idParam.parse(req.params).id);
    const body = z.object({ priority: z.number().int().min(-10).max(10).optional(), projectId: z.string().uuid().nullable().optional() }).parse(req.body);
    if (body.projectId && !(await s.projects.get(u.id, body.projectId))) throw new HttpError(400, "Projet introuvable");
    if (body.priority !== undefined) await s.jobs.setPriority(row.id, u.id, body.priority);
    if (body.projectId !== undefined) await s.jobs.setProject(row.id, u.id, body.projectId);
    return s.jobs.dto((await s.jobs.get(row.id, u.id))!);
  });

  app.delete("/api/jobs/:id", async (req, reply) => {
    const u = requireUser(req);
    const row = await one(u.id, idParam.parse(req.params).id);
    await s.jobs.softDelete(row.id, u.id);
    await s.audit.log({ userId: u.id, action: "job.delete", target: row.id, ip: req.ip });
    return reply.code(204).send();
  });
}
