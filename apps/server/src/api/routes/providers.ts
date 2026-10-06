import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiContext } from "../app.js";

/** Models page + capability-driven UI: which engines exist, what they can do, whether they are up. */
export async function providerRoutes(app: FastifyInstance, { s, requireUser }: ApiContext) {
  app.get("/api/providers", async (req) => {
    requireUser(req);
    const q = z.object({ module: z.enum(["image", "video"]).optional() }).parse(req.query);
    return s.registry.infos(q.module);
  });
}
