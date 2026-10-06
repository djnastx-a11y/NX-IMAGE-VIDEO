import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * StorageProvider abstraction. The app only handles storage keys ("uploads/<id>.png",
 * "outputs/<job>/<n>.mp4"); drivers decide where bytes live.
 *  - LocalStorage: a directory / mounted volume (development, single server)
 *  - S3Storage: AWS S3, Cloudflare R2, MinIO, Backblaze B2... (production)
 * Media are private: browsers never get a raw storage URL, they go through the
 * authenticated /api/media/:id/file route (which may redirect to a short-lived signed URL).
 */
export interface StorageProvider {
  readonly driver: "local" | "s3";
  putFile(key: string, sourcePath: string, mime: string): Promise<number>;
  /** A local path to read the object from (downloaded to a cache for remote drivers). */
  localPath(key: string): Promise<string>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Remote drivers return a short-lived signed URL; local returns null (file is streamed by the API). */
  signedUrl(key: string, ttlSec: number, downloadName?: string): Promise<string | null>;
  /** Absolute path for local files (used to stream with Range support). */
  absolutePath?(key: string): string;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}

export function assertSafeKey(key: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key) || key.includes("..")) throw new Error(`Invalid storage key: ${key}`);
}

export class LocalStorage implements StorageProvider {
  readonly driver = "local" as const;
  constructor(readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  absolutePath(key: string): string {
    assertSafeKey(key);
    return path.join(this.root, key);
  }

  async putFile(key: string, sourcePath: string): Promise<number> {
    const dest = this.absolutePath(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.rename(sourcePath, dest);
    } catch {
      await fsp.copyFile(sourcePath, dest);
      await fsp.rm(sourcePath, { force: true });
    }
    return (await fsp.stat(dest)).size;
  }

  async localPath(key: string) {
    return this.absolutePath(key);
  }

  async delete(key: string) {
    await fsp.rm(this.absolutePath(key), { force: true });
  }

  async exists(key: string) {
    return fsp
      .access(this.absolutePath(key))
      .then(() => true)
      .catch(() => false);
  }

  async signedUrl() {
    return null;
  }

  async healthCheck() {
    const probe = path.join(this.root, `.health-${process.pid}`);
    try {
      await fsp.writeFile(probe, "ok");
      await fsp.rm(probe);
      return { ok: true, detail: `local: ${this.root}` };
    } catch (e) {
      return { ok: false, detail: `local storage not writable: ${(e as Error).message}` };
    }
  }
}
