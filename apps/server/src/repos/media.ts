import type { Media } from "@nx/shared";
import type { Pool, Queryable } from "../db/pool.js";

export interface MediaRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  job_id: string | null;
  kind: "image" | "video" | "mask";
  source: "upload" | "generated";
  storage_key: string;
  thumb_key: string | null;
  mime: string;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  size_bytes: number;
  original_name: string | null;
  favorite: boolean;
  created_at: Date;
  deleted_at: Date | null;
  prompt?: string | null;
}

export const mediaDto = (r: MediaRow): Media => ({
  id: r.id,
  kind: r.kind,
  source: r.source,
  mime: r.mime,
  url: `/api/media/${r.id}/file`,
  thumbUrl: r.thumb_key ? `/api/media/${r.id}/thumb` : r.kind === "image" || r.kind === "mask" ? `/api/media/${r.id}/file` : null,
  width: r.width,
  height: r.height,
  durationSec: r.duration_sec,
  sizeBytes: r.size_bytes,
  originalName: r.original_name,
  favorite: r.favorite,
  projectId: r.project_id,
  jobId: r.job_id,
  prompt: r.prompt ?? null,
  createdAt: r.created_at.toISOString(),
});

export interface NewMedia {
  id?: string;
  ownerId: string;
  projectId: string | null;
  jobId?: string | null;
  kind: MediaRow["kind"];
  source: MediaRow["source"];
  storageKey: string;
  thumbKey?: string | null;
  mime: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  sizeBytes: number;
  originalName?: string | null;
}

export interface MediaFilter {
  section?: "all" | "images" | "videos" | "uploads" | "generated" | "favorites";
  projectId?: string | "none";
  q?: string;
  sort?: "newest" | "oldest" | "largest" | "name";
  limit?: number;
  offset?: number;
}

const SELECT = `SELECT m.*, COALESCE(j.params->>'prompt', '') AS prompt FROM media m LEFT JOIN generation_jobs j ON j.id = m.job_id`;

export class MediaRepo {
  constructor(private readonly pool: Pool) {}

  async insert(m: NewMedia, db: Queryable = this.pool): Promise<MediaRow> {
    const { rows } = await db.query<MediaRow>(
      `INSERT INTO media (id, owner_id, project_id, job_id, kind, source, storage_key, thumb_key, mime, width, height, duration_sec, size_bytes, original_name)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        m.id ?? null,
        m.ownerId,
        m.projectId,
        m.jobId ?? null,
        m.kind,
        m.source,
        m.storageKey,
        m.thumbKey ?? null,
        m.mime,
        m.width,
        m.height,
        m.durationSec,
        m.sizeBytes,
        m.originalName ?? null,
      ],
    );
    return rows[0]!;
  }

  async get(id: string, ownerId?: string): Promise<MediaRow | undefined> {
    const { rows } = await this.pool.query<MediaRow>(
      `${SELECT} WHERE m.id = $1 AND ($2::uuid IS NULL OR m.owner_id = $2) AND m.deleted_at IS NULL`,
      [id, ownerId ?? null],
    );
    return rows[0];
  }

  async getMany(ids: string[]): Promise<MediaRow[]> {
    if (!ids.length) return [];
    return (await this.pool.query<MediaRow>(`${SELECT} WHERE m.id = ANY($1::uuid[])`, [ids])).rows;
  }

  async list(ownerId: string, f: MediaFilter): Promise<{ rows: MediaRow[]; total: number }> {
    const where = ["m.owner_id = $1", "m.deleted_at IS NULL", "m.kind <> 'mask'"];
    const args: unknown[] = [ownerId];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace("?", `$${args.length}`));
    };
    switch (f.section) {
      case "images":
        where.push("m.kind = 'image'");
        break;
      case "videos":
        where.push("m.kind = 'video'");
        break;
      case "uploads":
        where.push("m.source = 'upload'");
        break;
      case "generated":
        where.push("m.source = 'generated'");
        break;
      case "favorites":
        where.push("m.favorite");
        break;
    }
    if (f.projectId === "none") where.push("m.project_id IS NULL");
    else if (f.projectId) add("m.project_id = ?", f.projectId);
    if (f.q) add("(COALESCE(j.params->>'prompt','') || ' ' || COALESCE(m.original_name,'') || ' ' || COALESCE(j.params->>'instruction','')) ILIKE ?", `%${f.q}%`);
    const order = {
      newest: "m.created_at DESC",
      oldest: "m.created_at ASC",
      largest: "m.size_bytes DESC",
      name: "COALESCE(m.original_name, j.params->>'prompt') ASC NULLS LAST",
    }[f.sort ?? "newest"];
    const w = where.join(" AND ");
    const total = (await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM media m LEFT JOIN generation_jobs j ON j.id = m.job_id WHERE ${w}`, args)).rows[0]!.n;
    args.push(f.limit ?? 60, f.offset ?? 0);
    const rows = (await this.pool.query<MediaRow>(`${SELECT} WHERE ${w} ORDER BY ${order}, m.id LIMIT $${args.length - 1} OFFSET $${args.length}`, args)).rows;
    return { rows, total };
  }

  async update(ownerId: string, id: string, patch: { favorite?: boolean; projectId?: string | null }): Promise<MediaRow | undefined> {
    const { rows } = await this.pool.query<MediaRow>(
      `UPDATE media SET favorite = COALESCE($3, favorite),
         project_id = CASE WHEN $4 THEN $5::uuid ELSE project_id END
       WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING *`,
      [id, ownerId, patch.favorite ?? null, patch.projectId !== undefined, patch.projectId ?? null],
    );
    return rows[0] ? this.get(rows[0].id) : undefined;
  }

  async softDelete(ownerId: string, id: string): Promise<MediaRow | undefined> {
    const { rows } = await this.pool.query<MediaRow>(
      "UPDATE media SET deleted_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING *",
      [id, ownerId],
    );
    return rows[0];
  }
}
