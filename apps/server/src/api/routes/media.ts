import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { HttpError } from "../../lib/errors.js";
import { mediaDto, type MediaRow } from "../../repos/media.js";
import { encodeImage, IMAGE_FORMAT_MIME, makeThumbnail, probe } from "../../media/ffmpeg.js";
import type { ApiContext } from "../app.js";

/** Accepted uploads: MIME type ↔ allowed extensions ↔ magic-byte family. */
const ACCEPTED: Record<string, { kind: "image" | "video"; exts: string[]; magic: string }> = {
  "image/png": { kind: "image", exts: ["png"], magic: "png" },
  "image/jpeg": { kind: "image", exts: ["jpg", "jpeg"], magic: "jpeg" },
  "image/webp": { kind: "image", exts: ["webp"], magic: "webp" },
  "video/mp4": { kind: "video", exts: ["mp4", "m4v"], magic: "isobmff" },
  "video/quicktime": { kind: "video", exts: ["mov"], magic: "isobmff" },
  "video/webm": { kind: "video", exts: ["webm"], magic: "ebml" },
};

async function sniff(file: string): Promise<string | null> {
  const fh = await fsp.open(file, "r");
  try {
    const b = Buffer.alloc(16);
    await fh.read(b, 0, 16, 0);
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
    if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "webp";
    if (b.toString("ascii", 4, 8) === "ftyp") return "isobmff";
    if (b.readUInt32BE(0) === 0x1a45dfa3) return "ebml";
    return null;
  } finally {
    await fh.close();
  }
}

/** Keeps a readable, harmless display name (the stored key never uses it). */
export function safeName(name: string | undefined): string | null {
  if (!name) return null;
  const base = path.basename(name).normalize("NFKC").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/\s+/g, " ").trim();
  return base.slice(0, 120) || null;
}

const idParam = z.object({ id: z.string().uuid() });

export async function mediaRoutes(app: FastifyInstance, { s, requireUser }: ApiContext) {
  app.post("/api/media", async (req) => {
    const u = requireUser(req);
    const limits = (await s.settings.system()).uploads;
    const q = z.object({ projectId: z.string().uuid().optional(), purpose: z.enum(["media", "mask"]).default("media") }).parse(req.query);
    if (q.projectId && !(await s.projects.get(u.id, q.projectId))) throw new HttpError(400, "Projet introuvable");

    const file = await req.file({ limits: { fileSize: Math.max(limits.maxImageMb, limits.maxVideoMb) * 1024 * 1024 } });
    if (!file) throw new HttpError(400, "Aucun fichier reçu");
    const spec = ACCEPTED[file.mimetype];
    const ext = path.extname(file.filename ?? "").slice(1).toLowerCase();
    if (!spec) {
      file.file.resume();
      throw new HttpError(415, `Type de fichier non supporté (${file.mimetype}). Formats acceptés : PNG, JPEG, WebP, MP4, MOV, WebM`, "bad_type");
    }
    if (!spec.exts.includes(ext)) {
      file.file.resume();
      throw new HttpError(415, `Extension .${ext || "?"} incohérente avec le type ${file.mimetype}`, "bad_extension");
    }
    if (q.purpose === "mask" && spec.kind !== "image") throw new HttpError(415, "Un masque doit être une image", "bad_type");

    const id = randomUUID();
    const tmp = path.join(os.tmpdir(), `nx-up-${id}`);
    try {
      await pipeline(file.file, fs.createWriteStream(tmp));
      if (file.file.truncated) throw new HttpError(413, "Fichier trop volumineux", "too_large");
      const size = (await fsp.stat(tmp)).size;
      const maxMb = spec.kind === "image" ? limits.maxImageMb : limits.maxVideoMb;
      if (size > maxMb * 1024 * 1024) throw new HttpError(413, `Fichier trop volumineux (max ${maxMb} Mo pour ${spec.kind === "image" ? "une image" : "une vidéo"})`, "too_large");
      if ((await sniff(tmp)) !== spec.magic) throw new HttpError(415, "Le contenu du fichier ne correspond pas à son type", "bad_content");
      let info;
      try {
        info = await probe(tmp);
      } catch {
        throw new HttpError(422, "Fichier illisible ou corrompu", "unreadable");
      }
      if (!info.hasVideo || !info.width || !info.height) throw new HttpError(422, "Aucune image exploitable dans ce fichier", "unreadable");
      if (info.width * info.height > 80_000_000) throw new HttpError(413, "Dimensions trop grandes", "too_large");

      const kind = q.purpose === "mask" ? "mask" : spec.kind;
      const key = `uploads/${u.id}/${id}.${spec.exts[0]}`;
      let thumbKey: string | null = null;
      if (kind === "video") {
        const thumb = `${tmp}.jpg`;
        await makeThumbnail(tmp, thumb, info.durationSec);
        thumbKey = `${key}.thumb.jpg`;
        await s.storage.putFile(thumbKey, thumb, "image/jpeg");
      }
      const stored = await s.storage.putFile(key, tmp, file.mimetype);
      const row = await s.media.insert({
        id,
        ownerId: u.id,
        projectId: q.projectId ?? null,
        kind,
        source: "upload",
        storageKey: key,
        thumbKey,
        mime: file.mimetype,
        width: info.width,
        height: info.height,
        durationSec: kind === "video" ? info.durationSec : null,
        sizeBytes: stored,
        originalName: safeName(file.filename),
      });
      await s.projects.touch(q.projectId ?? null);
      return mediaDto(row);
    } finally {
      await fsp.rm(tmp, { force: true });
      await fsp.rm(`${tmp}.jpg`, { force: true });
    }
  });

  app.get("/api/media", async (req) => {
    const u = requireUser(req);
    const q = z
      .object({
        section: z.enum(["all", "images", "videos", "uploads", "generated", "favorites"]).default("all"),
        projectId: z.union([z.string().uuid(), z.literal("none")]).optional(),
        q: z.string().max(200).optional(),
        sort: z.enum(["newest", "oldest", "largest", "name"]).default("newest"),
        limit: z.coerce.number().int().min(1).max(200).default(60),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const { rows, total } = await s.media.list(u.id, q);
    return { items: rows.map(mediaDto), total };
  });

  const own = async (userId: string, id: string): Promise<MediaRow> => {
    const m = await s.media.get(id, userId);
    if (!m) throw new HttpError(404, "Média introuvable");
    return m;
  };

  app.get("/api/media/:id", async (req) => mediaDto(await own(requireUser(req).id, idParam.parse(req.params).id)));

  app.patch("/api/media/:id", async (req) => {
    const u = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ favorite: z.boolean().optional(), projectId: z.string().uuid().nullable().optional() }).parse(req.body);
    if (body.projectId && !(await s.projects.get(u.id, body.projectId))) throw new HttpError(400, "Projet introuvable");
    const m = await s.media.update(u.id, id, body);
    if (!m) throw new HttpError(404, "Média introuvable");
    return mediaDto(m);
  });

  app.delete("/api/media/:id", async (req, reply) => {
    const u = requireUser(req);
    const { id } = idParam.parse(req.params);
    if (!(await s.media.softDelete(u.id, id))) throw new HttpError(404, "Média introuvable");
    await s.audit.log({ userId: u.id, action: "media.delete", target: id, ip: req.ip });
    return reply.code(204).send();
  });

  /** Streams a stored object (Range requests supported for video seeking), or redirects to a signed URL. */
  const send = async (reply: FastifyReply, key: string, mime: string, downloadName?: string) => {
    const signed = await s.storage.signedUrl(key, 600, downloadName);
    if (signed) return reply.redirect(signed);
    const abs = s.storage.absolutePath!(key);
    reply.header("cache-control", "private, max-age=3600");
    if (downloadName) reply.header("content-disposition", `attachment; filename="${downloadName}"`);
    return reply.type(mime).sendFile(path.basename(abs), path.dirname(abs));
  };

  app.get("/api/media/:id/file", async (req, reply) => {
    const u = requireUser(req);
    const m = await own(u.id, idParam.parse(req.params).id);
    const q = z.object({ download: z.enum(["1", "0"]).optional(), format: z.enum(["png", "jpeg", "webp"]).optional() }).parse(req.query);
    const base = `nx-${m.kind}-${m.id.slice(0, 8)}`;
    const ext = m.storage_key.split(".").pop();
    if (q.format && m.kind !== "video") {
      // Export an image in another format (PNG / JPEG / WebP), converted on the fly.
      const tmp = path.join(os.tmpdir(), `nx-exp-${randomUUID()}.${q.format === "jpeg" ? "jpg" : q.format}`);
      await encodeImage(await s.storage.localPath(m.storage_key), tmp, q.format);
      const buf = await fsp.readFile(tmp);
      await fsp.rm(tmp, { force: true });
      reply.header("content-disposition", `attachment; filename="${base}.${q.format === "jpeg" ? "jpg" : q.format}"`);
      return reply.type(IMAGE_FORMAT_MIME[q.format]).send(buf);
    }
    return send(reply, m.storage_key, m.mime, q.download === "1" ? `${base}.${ext}` : undefined);
  });

  app.get("/api/media/:id/thumb", async (req, reply) => {
    const u = requireUser(req);
    const m = await own(u.id, idParam.parse(req.params).id);
    if (m.thumb_key) return send(reply, m.thumb_key, "image/jpeg");
    return send(reply, m.storage_key, m.mime);
  });
}
