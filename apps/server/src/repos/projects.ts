import type { Project } from "@nx/shared";
import type { Pool } from "../db/pool.js";

interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  color: string;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
  media_count?: number;
  job_count?: number;
  cover_media_id?: string | null;
}

const dto = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  description: r.description,
  color: r.color,
  archived: r.archived,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  counts: r.media_count !== undefined ? { media: r.media_count, jobs: r.job_count ?? 0 } : undefined,
  coverUrl: r.cover_media_id ? `/api/media/${r.cover_media_id}/thumb` : null,
});

export class ProjectsRepo {
  constructor(private readonly pool: Pool) {}

  async list(ownerId: string, includeArchived = false): Promise<Project[]> {
    const { rows } = await this.pool.query<ProjectRow>(
      `SELECT p.*,
         (SELECT count(*)::int FROM media m WHERE m.project_id = p.id AND m.deleted_at IS NULL AND m.kind <> 'mask') AS media_count,
         (SELECT count(*)::int FROM generation_jobs j WHERE j.project_id = p.id AND j.deleted_at IS NULL) AS job_count,
         (SELECT m.id FROM media m WHERE m.project_id = p.id AND m.deleted_at IS NULL AND m.kind <> 'mask'
            ORDER BY m.created_at DESC LIMIT 1) AS cover_media_id
       FROM projects p WHERE p.owner_id = $1 AND ($2 OR NOT p.archived) ORDER BY p.archived, p.updated_at DESC`,
      [ownerId, includeArchived],
    );
    return rows.map(dto);
  }

  async get(ownerId: string, id: string): Promise<Project | undefined> {
    const { rows } = await this.pool.query<ProjectRow>("SELECT * FROM projects WHERE id = $1 AND owner_id = $2", [id, ownerId]);
    return rows[0] ? dto(rows[0]) : undefined;
  }

  async create(ownerId: string, p: { name: string; description: string; color: string }): Promise<Project> {
    const { rows } = await this.pool.query<ProjectRow>(
      "INSERT INTO projects (owner_id, name, description, color) VALUES ($1, $2, $3, $4) RETURNING *",
      [ownerId, p.name, p.description, p.color],
    );
    return dto(rows[0]!);
  }

  async update(ownerId: string, id: string, p: { name?: string; description?: string; color?: string; archived?: boolean }) {
    const { rows } = await this.pool.query<ProjectRow>(
      `UPDATE projects SET name = COALESCE($3, name), description = COALESCE($4, description), color = COALESCE($5, color),
         archived = COALESCE($6, archived), updated_at = now() WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [id, ownerId, p.name ?? null, p.description ?? null, p.color ?? null, p.archived ?? null],
    );
    return rows[0] ? dto(rows[0]) : undefined;
  }

  /** Deletes the project; its media and jobs are kept and become "unfiled". */
  async delete(ownerId: string, id: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM projects WHERE id = $1 AND owner_id = $2", [id, ownerId]);
    return r.rowCount === 1;
  }

  async touch(id: string | null) {
    if (id) await this.pool.query("UPDATE projects SET updated_at = now() WHERE id = $1", [id]);
  }
}
