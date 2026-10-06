import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertSafeKey, type StorageProvider } from "./storage.js";

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
}

/**
 * S3-compatible storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2, Scaleway...).
 * Browsers get short-lived signed URLs; workers read through a local cache.
 */
export class S3Storage implements StorageProvider {
  readonly driver = "s3" as const;
  private readonly s3: S3Client;
  private readonly cacheDir = path.join(os.tmpdir(), "nx-s3-cache");

  constructor(private readonly c: S3Config) {
    this.s3 = new S3Client({
      region: c.region,
      endpoint: c.endpoint,
      forcePathStyle: c.forcePathStyle,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    });
  }

  private k(key: string) {
    assertSafeKey(key);
    return this.c.prefix ? `${this.c.prefix.replace(/\/+$/, "")}/${key}` : key;
  }

  async putFile(key: string, sourcePath: string, mime: string): Promise<number> {
    const size = (await fsp.stat(sourcePath)).size;
    await new Upload({
      client: this.s3,
      params: { Bucket: this.c.bucket, Key: this.k(key), Body: fs.createReadStream(sourcePath), ContentType: mime },
    }).done();
    // keep a local copy in the cache: workers often re-read fresh outputs (thumbnails, extend...)
    const cached = path.join(this.cacheDir, key);
    await fsp.mkdir(path.dirname(cached), { recursive: true });
    await fsp.rename(sourcePath, cached).catch(async () => {
      await fsp.copyFile(sourcePath, cached);
      await fsp.rm(sourcePath, { force: true });
    });
    return size;
  }

  async localPath(key: string): Promise<string> {
    const cached = path.join(this.cacheDir, key);
    if (await fsp.access(cached).then(() => true, () => false)) return cached;
    const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.c.bucket, Key: this.k(key) }));
    await fsp.mkdir(path.dirname(cached), { recursive: true });
    const tmp = `${cached}.${process.pid}.part`;
    await pipeline(obj.Body as Readable, fs.createWriteStream(tmp));
    await fsp.rename(tmp, cached);
    return cached;
  }

  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.c.bucket, Key: this.k(key) }));
    await fsp.rm(path.join(this.cacheDir, key), { force: true });
  }

  async exists(key: string) {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.c.bucket, Key: this.k(key) }));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSec: number, downloadName?: string) {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.c.bucket,
        Key: this.k(key),
        ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName}"` : undefined,
      }),
      { expiresIn: ttlSec },
    );
  }

  async healthCheck() {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.c.bucket }));
      return { ok: true, detail: `s3: ${this.c.bucket}${this.c.endpoint ? ` @ ${this.c.endpoint}` : ""}` };
    } catch (e) {
      return { ok: false, detail: `s3 bucket "${this.c.bucket}" unreachable: ${(e as Error).message}` };
    }
  }
}
