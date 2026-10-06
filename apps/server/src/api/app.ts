import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type { User } from "@nx/shared";
import { HttpError } from "../lib/errors.js";
import { userDto, type UserRow } from "../repos/users.js";
import type { Services } from "../services/container.js";
import { JobService } from "../services/job-service.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { mediaRoutes } from "./routes/media.js";
import { jobRoutes } from "./routes/jobs.js";
import { presetRoutes } from "./routes/presets.js";
import { providerRoutes } from "./routes/providers.js";
import { adminRoutes } from "./routes/admin.js";
import { eventRoutes } from "./routes/events.js";

declare module "fastify" {
  interface FastifyRequest {
    user: UserRow | null;
  }
}

export interface ApiContext {
  s: Services;
  jobService: JobService;
  requireUser(req: FastifyRequest): UserRow;
  requireAdmin(req: FastifyRequest): UserRow;
  dto(u: UserRow): User;
}

export async function buildApp(s: Services): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: s.logger.child({ component: "api" }) as unknown as FastifyBaseLogger,
    disableRequestLogging: s.config.env === "test",
    trustProxy: s.config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(cors, { origin: s.config.env === "production" ? false : true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(rateLimit, {
    global: true,
    max: s.config.rateLimit.max,
    timeWindow: "1 minute",
    hook: "preHandler",
    keyGenerator: (req) => req.user?.id ?? req.ip,
    // SSE and media bytes (thumbnail grids, video seeking) are not counted.
    allowList: (req) => !req.url.startsWith("/api/") || req.url.startsWith("/api/events") || /^\/api\/media\/[^/]+\/(file|thumb)/.test(req.url),
  });

  app.decorateRequest("user", null);
  // Resolve the session cookie (or Bearer token, for scripts) on every request.
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[s.config.session.cookieName] ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token) req.user = (await s.sessions.resolve(token)) ?? null;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "Requête invalide", code: "validation", details: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    }
    if (err.code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "Fichier trop volumineux", code: "too_large" });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "Erreur interne", code: "internal" });
  });

  const ctx: ApiContext = {
    s,
    jobService: new JobService(s),
    requireUser(req) {
      if (!req.user) throw new HttpError(401, "Connexion requise", "unauthenticated");
      return req.user;
    },
    requireAdmin(req) {
      const u = ctx.requireUser(req);
      if (u.role !== "admin") throw new HttpError(403, "Réservé aux administrateurs", "forbidden");
      return u;
    },
    dto: userDto,
  };

  app.get("/api/health", async () => {
    const db = await s.pool.query("SELECT 1").then(() => true, () => false);
    return { ok: db, name: "NX STUDIO", version: "0.1.0", db };
  });

  await app.register(async (r) => authRoutes(r, ctx));
  await app.register(async (r) => projectRoutes(r, ctx));
  await app.register(async (r) => mediaRoutes(r, ctx));
  await app.register(async (r) => jobRoutes(r, ctx));
  await app.register(async (r) => presetRoutes(r, ctx));
  await app.register(async (r) => providerRoutes(r, ctx));
  await app.register(async (r) => adminRoutes(r, ctx));
  await app.register(async (r) => eventRoutes(r, ctx));

  // Single-page web app (built by apps/web) served by the same process.
  if (fs.existsSync(path.join(s.config.webDir, "index.html"))) {
    // wildcard: files are looked up per request, so a rebuilt web app is served without a restart
    await app.register(fastifyStatic, {
      root: s.config.webDir,
      prefix: "/",
      wildcard: true,
      setHeaders: (reply, file) => {
        // hashed bundles never change; index.html must always be revalidated
        reply.header("cache-control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      // client-side routes get the SPA shell; missing API routes and missing files get a real 404
      const isPage = req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/assets/") && !path.extname(req.url.split("?")[0]!);
      if (isPage) return reply.type("text/html").header("cache-control", "no-cache").sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  } else {
    // Still needed for reply.sendFile() (media streaming with Range support).
    await app.register(fastifyStatic, { root: s.config.dataDir, serve: false });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
  }
  return app;
}
