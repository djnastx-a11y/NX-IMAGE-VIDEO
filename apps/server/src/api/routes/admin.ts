import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publicConfig } from "../../config.js";
import { hashPassword, validatePasswordStrength } from "../../auth/password.js";
import { HttpError } from "../../lib/errors.js";
import type { ApiContext } from "../app.js";

const settingsPatch = z
  .object({
    queue: z
      .object({
        concurrency: z.number().int().min(1).max(32),
        maxAttempts: z.number().int().min(1).max(10),
        retryBackoffSec: z.number().int().min(0).max(3600),
      })
      .partial(),
    uploads: z.object({ maxImageMb: z.number().int().min(1).max(200), maxVideoMb: z.number().int().min(1).max(4000) }).partial(),
    defaults: z
      .object({
        imageProvider: z.string().min(1),
        videoProvider: z.string().min(1),
        image: z.record(z.string(), z.unknown()),
        video: z.record(z.string(), z.unknown()),
      })
      .partial(),
  })
  .partial()
  .strict();

export async function adminRoutes(app: FastifyInstance, { s, requireAdmin, dto }: ApiContext) {
  // ---- system overview
  app.get("/api/admin/overview", async (req) => {
    requireAdmin(req);
    const [stats, workers, storage, db] = await Promise.all([
      s.jobs.stats(),
      s.jobs.workers(),
      s.storage.healthCheck(),
      s.pool.query("SELECT version()").then((r) => ({ ok: true, version: String(r.rows[0]?.version ?? "") }), (e) => ({ ok: false, version: (e as Error).message })),
    ]);
    return { stats, workers, storage, db, config: publicConfig(s.config), settings: await s.settings.system() };
  });

  // ---- settings
  app.get("/api/admin/settings", async (req) => {
    requireAdmin(req);
    return s.settings.system();
  });
  app.patch("/api/admin/settings", async (req) => {
    const u = requireAdmin(req);
    const patch = settingsPatch.parse(req.body);
    for (const [k, v] of [["imageProvider", patch.defaults?.imageProvider], ["videoProvider", patch.defaults?.videoProvider]] as const) {
      if (v && v !== "auto" && !s.registry.list().some((p) => p.id === v || p.engine === v)) throw new HttpError(400, `${k} : moteur inconnu (${v})`);
    }
    const next = await s.settings.updateSystem(patch);
    s.registry.invalidate();
    await s.audit.log({ userId: u.id, action: "admin.settings", data: patch as Record<string, unknown>, ip: req.ip });
    return next;
  });

  // ---- providers
  app.get("/api/admin/providers", async (req) => {
    requireAdmin(req);
    return s.registry.infos();
  });
  app.patch("/api/admin/providers/:id", async (req) => {
    const u = requireAdmin(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ enabled: z.boolean().optional(), isDefault: z.boolean().optional() }).parse(req.body);
    const p = s.registry.get(id);
    if (!p) throw new HttpError(404, "Provider introuvable");
    if (body.enabled !== undefined) await s.providerSettings.setEnabled(id, body.enabled);
    if (body.isDefault === true) await s.providerSettings.setDefault(id, p.module);
    if (body.isDefault === false) await s.providerSettings.clearDefault(p.module);
    s.registry.invalidate();
    await s.audit.log({ userId: u.id, action: "admin.provider", target: id, data: body, ip: req.ip });
    return (await s.registry.infos()).find((x) => x.id === id);
  });
  app.post("/api/admin/providers/:id/test", async (req) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return s.registry.test(id);
  });

  // ---- users
  app.get("/api/admin/users", async (req) => {
    requireAdmin(req);
    return (await s.users.list()).map((u) => ({ ...dto(u), disabled: u.disabled }));
  });
  app.post("/api/admin/users", async (req) => {
    const me = requireAdmin(req);
    const b = z.object({ email: z.string().email(), name: z.string().trim().max(80).default(""), password: z.string(), role: z.enum(["admin", "user"]).default("user") }).parse(req.body);
    const weak = validatePasswordStrength(b.password);
    if (weak) throw new HttpError(400, weak);
    if (await s.users.byEmail(b.email)) throw new HttpError(409, "Cet email existe déjà");
    const u = await s.users.create({ email: b.email, name: b.name || b.email.split("@")[0]!, passwordHash: await hashPassword(b.password), role: b.role });
    await s.audit.log({ userId: me.id, action: "admin.user_create", target: u.id, data: { email: u.email, role: u.role }, ip: req.ip });
    return dto(u);
  });
  app.patch("/api/admin/users/:id", async (req) => {
    const me = requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ role: z.enum(["admin", "user"]).optional(), disabled: z.boolean().optional(), name: z.string().max(80).optional() }).parse(req.body);
    if (id === me.id && (b.role === "user" || b.disabled)) throw new HttpError(400, "Tu ne peux pas retirer tes propres droits d'administration");
    const u = await s.users.update(id, b);
    if (!u) throw new HttpError(404, "Utilisateur introuvable");
    if (b.disabled) await s.sessions.destroyAllForUser(id);
    await s.audit.log({ userId: me.id, action: "admin.user_update", target: id, data: b, ip: req.ip });
    return { ...dto(u), disabled: u.disabled };
  });

  // ---- logs
  app.get("/api/admin/audit", async (req) => {
    requireAdmin(req);
    return s.audit.list(300);
  });
  app.get("/api/admin/failures", async (req) => {
    requireAdmin(req);
    const { rows } = await s.pool.query(
      `SELECT j.id, j.module, j.operation, j.provider_id, j.model, j.error, j.error_code, j.attempts, j.finished_at, j.worker_id, u.email
       FROM generation_jobs j JOIN users u ON u.id = j.owner_id WHERE j.status = 'failed' ORDER BY j.finished_at DESC NULLS LAST LIMIT 100`,
    );
    return rows;
  });
}
