import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createProjectSchema, updateProjectSchema } from "@nx/shared";
import { HttpError } from "../../lib/errors.js";
import type { ApiContext } from "../app.js";

const idParam = z.object({ id: z.string().uuid() });

export async function projectRoutes(app: FastifyInstance, { s, requireUser }: ApiContext) {
  app.get("/api/projects", async (req) => {
    const u = requireUser(req);
    const q = z.object({ archived: z.enum(["true", "false"]).optional() }).parse(req.query);
    return s.projects.list(u.id, q.archived === "true");
  });

  app.post("/api/projects", async (req) => {
    const u = requireUser(req);
    const p = await s.projects.create(u.id, createProjectSchema.parse(req.body));
    await s.audit.log({ userId: u.id, action: "project.create", target: p.id, data: { name: p.name }, ip: req.ip });
    return p;
  });

  app.get("/api/projects/:id", async (req) => {
    const u = requireUser(req);
    const { id } = idParam.parse(req.params);
    const p = await s.projects.get(u.id, id);
    if (!p) throw new HttpError(404, "Projet introuvable");
    return p;
  });

  app.patch("/api/projects/:id", async (req) => {
    const u = requireUser(req);
    const { id } = idParam.parse(req.params);
    const p = await s.projects.update(u.id, id, updateProjectSchema.parse(req.body));
    if (!p) throw new HttpError(404, "Projet introuvable");
    return p;
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    const u = requireUser(req);
    const { id } = idParam.parse(req.params);
    if (!(await s.projects.delete(u.id, id))) throw new HttpError(404, "Projet introuvable");
    await s.audit.log({ userId: u.id, action: "project.delete", target: id, ip: req.ip });
    return reply.code(204).send();
  });
}
