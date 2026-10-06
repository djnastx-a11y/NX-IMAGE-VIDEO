import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { loginSchema } from "@nx/shared";
import { hashPassword, validatePasswordStrength, verifyPassword } from "../../auth/password.js";
import { HttpError } from "../../lib/errors.js";
import type { ApiContext } from "../app.js";

// Same work as a real verification so response time does not reveal whether an email exists.
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

export async function authRoutes(app: FastifyInstance, { s, requireUser, dto }: ApiContext) {
  const startSession = async (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    const { token, expiresAt } = await s.sessions.create(userId, s.config.session.ttlDays, { ip: req.ip, userAgent: req.headers["user-agent"] });
    reply.setCookie(s.config.session.cookieName, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: s.config.session.cookieSecure,
      expires: expiresAt,
    });
  };

  app.get("/api/auth/status", async (req) => ({
    setupRequired: (await s.users.count()) === 0,
    user: req.user ? dto(req.user) : null,
  }));

  /** First run only: creates the first (admin) account when no user exists yet. */
  app.post("/api/auth/setup", { config: { rateLimit: { max: s.config.rateLimit.loginMax, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string(), name: z.string().trim().max(80).default("") }).parse(req.body);
    if ((await s.users.count()) > 0) throw new HttpError(409, "L'application est déjà configurée", "already_setup");
    const weak = validatePasswordStrength(body.password);
    if (weak) throw new HttpError(400, weak, "weak_password");
    const u = await s.users.create({ email: body.email, name: body.name || body.email.split("@")[0]!, passwordHash: await hashPassword(body.password), role: "admin" });
    await s.audit.log({ userId: u.id, action: "auth.setup", ip: req.ip });
    await startSession(req, reply, u.id);
    return { user: dto(u) };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: s.config.rateLimit.loginMax, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const u = await s.users.byEmail(body.email);
    const ok = await verifyPassword(body.password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok || u.disabled) {
      await s.audit.log({ userId: u?.id ?? null, action: "auth.login_failed", target: body.email, ip: req.ip });
      throw new HttpError(401, "Email ou mot de passe incorrect", "bad_credentials");
    }
    await startSession(req, reply, u.id);
    await s.audit.log({ userId: u.id, action: "auth.login", ip: req.ip });
    return { user: dto(u) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[s.config.session.cookieName];
    if (token) await s.sessions.destroy(token);
    if (req.user) await s.audit.log({ userId: req.user.id, action: "auth.logout", ip: req.ip });
    reply.clearCookie(s.config.session.cookieName, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    const u = requireUser(req);
    return { user: dto(u), settings: await s.settings.user(u.id) };
  });

  app.post("/api/auth/password", async (req) => {
    const u = requireUser(req);
    const body = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    if (!(await verifyPassword(body.current, u.password_hash))) throw new HttpError(400, "Mot de passe actuel incorrect", "bad_credentials");
    const weak = validatePasswordStrength(body.next);
    if (weak) throw new HttpError(400, weak, "weak_password");
    await s.users.update(u.id, { passwordHash: await hashPassword(body.next) });
    await s.audit.log({ userId: u.id, action: "auth.password_changed", ip: req.ip });
    return { ok: true };
  });

  app.patch("/api/me/settings", async (req) => {
    const u = requireUser(req);
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    return s.settings.updateUser(u.id, body);
  });
}
