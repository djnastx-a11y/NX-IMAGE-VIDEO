import { createHash, randomBytes } from "node:crypto";
import type { Role, User } from "@nx/shared";
import type { Pool } from "../db/pool.js";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  disabled: boolean;
  created_at: Date;
}

export const userDto = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  createdAt: r.created_at.toISOString(),
});

export class UsersRepo {
  constructor(private readonly pool: Pool) {}

  async create(u: { email: string; name: string; passwordHash: string; role: Role }): Promise<UserRow> {
    const { rows } = await this.pool.query<UserRow>(
      "INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *",
      [u.email.trim(), u.name, u.passwordHash, u.role],
    );
    return rows[0]!;
  }

  async byEmail(email: string): Promise<UserRow | undefined> {
    const { rows } = await this.pool.query<UserRow>("SELECT * FROM users WHERE lower(email) = lower($1)", [email.trim()]);
    return rows[0];
  }

  async byId(id: string): Promise<UserRow | undefined> {
    const { rows } = await this.pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
    return rows[0];
  }

  async list(): Promise<UserRow[]> {
    return (await this.pool.query<UserRow>("SELECT * FROM users ORDER BY created_at")).rows;
  }

  async count(): Promise<number> {
    return (await this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM users")).rows[0]!.n;
  }

  async update(id: string, patch: { name?: string; role?: Role; disabled?: boolean; passwordHash?: string }): Promise<UserRow | undefined> {
    const { rows } = await this.pool.query<UserRow>(
      `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), disabled = COALESCE($4, disabled),
         password_hash = COALESCE($5, password_hash), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, patch.name ?? null, patch.role ?? null, patch.disabled ?? null, patch.passwordHash ?? null],
    );
    return rows[0];
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Opaque server-side sessions. The cookie holds a random token; only its hash is stored. */
export class SessionsRepo {
  constructor(private readonly pool: Pool) {}

  async create(userId: string, ttlDays: number, meta: { ip?: string; userAgent?: string }): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlDays * 86400_000);
    await this.pool.query("INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)", [
      sha256(token),
      userId,
      expiresAt,
      meta.ip ?? null,
      meta.userAgent?.slice(0, 300) ?? null,
    ]);
    return { token, expiresAt };
  }

  /** Returns the user for a valid session token and slides its last-seen time. */
  async resolve(token: string): Promise<UserRow | undefined> {
    const { rows } = await this.pool.query<UserRow>(
      `WITH s AS (
         UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND expires_at > now() RETURNING user_id
       ) SELECT u.* FROM users u JOIN s ON s.user_id = u.id WHERE NOT u.disabled`,
      [sha256(token)],
    );
    return rows[0];
  }

  async destroy(token: string) {
    await this.pool.query("DELETE FROM sessions WHERE id = $1", [sha256(token)]);
  }

  async destroyAllForUser(userId: string) {
    await this.pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  }

  async purgeExpired() {
    await this.pool.query("DELETE FROM sessions WHERE expires_at < now()");
  }
}
