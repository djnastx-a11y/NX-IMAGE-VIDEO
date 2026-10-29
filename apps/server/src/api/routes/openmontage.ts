import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiContext } from "../app.js";
import { OpenMontageService } from "../../services/openmontage.js";

const jobParam = z.object({ id: z.string().uuid() });

export async function openMontageRoutes(app: FastifyInstance, ctx: ApiContext) {
  const service = new OpenMontageService(ctx.s);
  app.get("/api/openmontage/status", async (req) => {
    ctx.requireUser(req);
    return service.status();
  });
  app.get("/api/openmontage/jobs", async (req) => service.list(ctx.requireUser(req).id));
  app.get("/api/openmontage/jobs/:id", async (req) =>
    service.get(ctx.requireUser(req).id, jobParam.parse(req.params).id));
  app.post("/api/openmontage/jobs", async (req, reply) => {
    const id = ctx.requireUser(req).id;
    const job = await service.submit(id, req.body);
    return reply.code(202).send(job);
  });
}
