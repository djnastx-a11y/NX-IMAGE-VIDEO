import type { AuditLog, SystemSettings } from "@nx/shared";
import type { Pool, Queryable } from "../db/pool.js";

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  queue: { concurrency: 2, maxAttempts: 3, retryBackoffSec: 5 },
  uploads: { maxImageMb: 25, maxVideoMb: 300 },
  defaults: { imageProvider: "auto", videoProvider: "auto", image: {}, video: {} },
};

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return (over as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? merge(b, v) : v;
  }
  return out as T;
}

export class SettingsRepo {
  private cache: { at: number; value: SystemSettings } | null = null;
  constructor(private readonly pool: Pool) {}

  /** System settings (cached 3s so workers can read them on every poll cheaply). */
  async system(): Promise<SystemSettings> {
    if (this.cache && Date.now() - this.cache.at < 3000) return this.cache.value;
    const { rows } = await this.pool.query<{ value: unknown }>("SELECT value FROM system_settings WHERE key = 'system'");
    const value = merge(DEFAULT_SYSTEM_SETTINGS, rows[0]?.value ?? {});
    this.cache = { at: Date.now(), value };
    return value;
  }

  async updateSystem(patch: unknown): Promise<SystemSettings> {
    const next = merge(await this.system(), patch);
    await this.pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('system', $1)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [JSON.stringify(next)],
    );
    this.cache = null;
    return this.system();
  }

  async user(userId: string): Promise<Record<string, unknown>> {
    const { rows } = await this.pool.query<{ settings: Record<string, unknown> }>("SELECT settings FROM user_settings WHERE user_id = $1", [userId]);
    return rows[0]?.settings ?? {};
  }

  async updateUser(userId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const next = { ...(await this.user(userId)), ...patch };
    await this.pool.query(
      `INSERT INTO user_settings (user_id, settings) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET settings = excluded.settings, updated_at = now()`,
      [userId, JSON.stringify(next)],
    );
    return next;
  }
}

export class AuditRepo {
  constructor(private readonly pool: Queryable) {}

  async log(e: { userId?: string | null; action: string; target?: string | null; data?: Record<string, unknown> | null; ip?: string | null }) {
    await this.pool.query("INSERT INTO audit_logs (user_id, action, target, data, ip) VALUES ($1, $2, $3, $4, $5)", [
      e.userId ?? null,
      e.action,
      e.target ?? null,
      e.data ? JSON.stringify(e.data) : null,
      e.ip ?? null,
    ]);
  }

  async list(limit = 200): Promise<AuditLog[]> {
    const { rows } = await this.pool.query<{
      id: number;
      at: Date;
      user_id: string | null;
      email: string | null;
      action: string;
      target: string | null;
      data: Record<string, unknown> | null;
      ip: string | null;
    }>(
      `SELECT a.*, u.email FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: String(r.id),
      at: r.at.toISOString(),
      userId: r.user_id,
      userEmail: r.email,
      action: r.action,
      target: r.target,
      data: r.data,
      ip: r.ip,
    }));
  }
}
