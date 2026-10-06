import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { imageParamsSchema, presetBodySchema, videoParamsSchema } from "@nx/shared";
import { HttpError } from "../../lib/errors.js";
import type { ApiContext } from "../app.js";

/** Presets store a partial set of parameters, validated against the module's schema. */
function cleanParams(module: "image" | "video", params: Record<string, unknown>) {
  const schema = module === "image" ? imageParamsSchema.partial() : videoParamsSchema.partial();
  const parsed = schema.parse(params) as Record<string, unknown>;
  // Never store references to private media inside a reusable preset.
  for (const k of ["sourceMediaId", "maskMediaId", "sourceImageId", "sourceVideoId", "extendMediaId", "referenceImageId", "references", "keyframes"]) delete parsed[k];
  return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined));
}

export async function presetRoutes(app: FastifyInstance, { s, requireUser }: ApiContext) {
  app.get("/api/presets", async (req) => {
    const u = requireUser(req);
    const q = z.object({ module: z.enum(["image", "video"]).optional() }).parse(req.query);
    return s.presets.list(u.id, q.module);
  });

  app.post("/api/presets", async (req) => {
    const u = requireUser(req);
    const b = presetBodySchema.parse(req.body);
    if (b.projectId && !(await s.projects.get(u.id, b.projectId))) throw new HttpError(400, "Projet introuvable");
    return s.presets.create(u.id, { ...b, params: cleanParams(b.module, b.params) });
  });

  app.patch("/api/presets/:id", async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().max(300).optional(), module: z.enum(["image", "video"]).optional(), params: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    const p = await s.presets.update(u.id, id, { ...b, params: b.params && b.module ? cleanParams(b.module, b.params) : undefined });
    if (!p) throw new HttpError(404, "Preset introuvable ou intégré");
    return p;
  });

  app.delete("/api/presets/:id", async (req, reply) => {
    const u = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await s.presets.delete(u.id, id))) throw new HttpError(404, "Preset introuvable ou intégré");
    return reply.code(204).send();
  });
}
