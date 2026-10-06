import type { Module, Preset } from "@nx/shared";
import type { Pool } from "../db/pool.js";

interface PresetRow {
  id: string;
  owner_id: string | null;
  project_id: string | null;
  module: Module;
  slug: string | null;
  name: string;
  description: string;
  builtin: boolean;
  params: Record<string, unknown>;
  created_at: Date;
}

const dto = (r: PresetRow): Preset => ({
  id: r.id,
  module: r.module,
  name: r.name,
  description: r.description,
  builtin: r.builtin,
  projectId: r.project_id,
  params: r.params,
  createdAt: r.created_at.toISOString(),
});

export class PresetsRepo {
  constructor(private readonly pool: Pool) {}

  async list(ownerId: string, module?: Module): Promise<Preset[]> {
    const { rows } = await this.pool.query<PresetRow>(
      `SELECT * FROM presets WHERE (owner_id = $1 OR builtin) AND ($2::text IS NULL OR module = $2)
       ORDER BY builtin DESC, module, created_at`,
      [ownerId, module ?? null],
    );
    return rows.map(dto);
  }

  async create(ownerId: string, p: { module: Module; name: string; description: string; projectId: string | null; params: Record<string, unknown> }) {
    const { rows } = await this.pool.query<PresetRow>(
      "INSERT INTO presets (owner_id, module, name, description, project_id, params) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [ownerId, p.module, p.name, p.description, p.projectId, JSON.stringify(p.params)],
    );
    return dto(rows[0]!);
  }

  async update(ownerId: string, id: string, p: { name?: string; description?: string; params?: Record<string, unknown> }) {
    const { rows } = await this.pool.query<PresetRow>(
      `UPDATE presets SET name = COALESCE($3, name), description = COALESCE($4, description), params = COALESCE($5, params)
       WHERE id = $1 AND owner_id = $2 AND NOT builtin RETURNING *`,
      [id, ownerId, p.name ?? null, p.description ?? null, p.params ? JSON.stringify(p.params) : null],
    );
    return rows[0] ? dto(rows[0]) : undefined;
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM presets WHERE id = $1 AND owner_id = $2 AND NOT builtin", [id, ownerId]);
    return r.rowCount === 1;
  }

  /** Upserts built-in presets by slug (idempotent at every boot). */
  async seedBuiltins(items: { slug: string; module: Module; name: string; description: string; params: Record<string, unknown> }[]) {
    for (const p of items) {
      await this.pool.query(
        `INSERT INTO presets (slug, module, name, description, builtin, params) VALUES ($1, $2, $3, $4, true, $5)
         ON CONFLICT (slug) DO UPDATE SET module = excluded.module, name = excluded.name, description = excluded.description, params = excluded.params`,
        [p.slug, p.module, p.name, p.description, JSON.stringify(p.params)],
      );
    }
  }
}

export interface ProviderSettingsRow {
  id: string;
  module: Module;
  enabled: boolean;
  is_default: boolean;
  config: Record<string, unknown>;
}

/** Admin-controlled overlay (enabled / default) on top of the providers registered in code + env. */
export class ProviderSettingsRepo {
  constructor(private readonly pool: Pool) {}

  async all(): Promise<Map<string, ProviderSettingsRow>> {
    const { rows } = await this.pool.query<ProviderSettingsRow>("SELECT * FROM providers");
    return new Map(rows.map((r) => [r.id, r]));
  }

  async ensure(id: string, module: Module) {
    await this.pool.query("INSERT INTO providers (id, module) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [id, module]);
  }

  async setEnabled(id: string, enabled: boolean) {
    await this.pool.query("UPDATE providers SET enabled = $2, updated_at = now() WHERE id = $1", [id, enabled]);
  }

  async setDefault(id: string, module: Module) {
    await this.pool.query("UPDATE providers SET is_default = (id = $1), updated_at = now() WHERE module = $2", [id, module]);
  }

  async clearDefault(module: Module) {
    await this.pool.query("UPDATE providers SET is_default = false, updated_at = now() WHERE module = $1", [module]);
  }
}
