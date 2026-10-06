import path from "node:path";

export type ProcessRole = "all" | "api" | "worker";

/**
 * A machine (or serverless endpoint) speaking the NX GPU protocol — see docs/GPU_WORKERS.md.
 * The token is read from an environment variable named by `tokenEnv`, so secrets never enter the DB or the UI.
 */
export interface GpuEndpointConfig {
  id: string;
  url: string;
  tokenEnv?: string;
  /** Engines served there, e.g. ["wan", "flux"]. If omitted they are discovered from /v1/health. */
  engines?: string[];
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, def: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : def;
}

function parseEndpoints(raw: string | undefined): GpuEndpointConfig[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as GpuEndpointConfig[];
  if (!Array.isArray(parsed)) throw new Error("NX_GPU_ENDPOINTS must be a JSON array");
  for (const e of parsed) if (!e.id || !e.url) throw new Error("Each NX_GPU_ENDPOINTS entry needs an id and a url");
  return parsed;
}

export interface Config {
  env: string;
  role: ProcessRole;
  host: string;
  port: number;
  trustProxy: boolean;
  databaseUrl: string;
  dataDir: string;
  webDir: string;
  storage:
    | { driver: "local"; root: string }
    | {
        driver: "s3";
        bucket: string;
        region: string;
        endpoint?: string;
        accessKeyId: string;
        secretAccessKey: string;
        forcePathStyle: boolean;
        prefix: string;
      };
  session: { ttlDays: number; cookieSecure: boolean; cookieName: string };
  bootstrapAdmin: { email: string; password: string; name: string } | null;
  worker: { id: string; concurrency: number; leaseSeconds: number; pollMs: number };
  enableMock: boolean;
  mockMinSeconds: number;
  gpuEndpoints: GpuEndpointConfig[];
  rateLimit: { max: number; loginMax: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.NX_DATA_DIR ?? path.join(process.cwd(), "data"));
  const isProd = env.NODE_ENV === "production";
  const driver = (env.STORAGE_DRIVER ?? "local") as "local" | "s3";
  return {
    env: env.NODE_ENV ?? "development",
    role: (env.NX_ROLE as ProcessRole) ?? "all",
    host: env.HOST ?? "0.0.0.0",
    port: int(env.PORT, 8787),
    trustProxy: bool(env.TRUST_PROXY, isProd),
    databaseUrl: env.DATABASE_URL ?? "postgres://nx@127.0.0.1:5432/nxstudio",
    dataDir,
    webDir: path.resolve(env.NX_WEB_DIR ?? path.join(process.cwd(), "..", "web", "dist")),
    storage:
      driver === "s3"
        ? {
            driver: "s3",
            bucket: env.S3_BUCKET ?? "",
            region: env.S3_REGION ?? "auto",
            endpoint: env.S3_ENDPOINT || undefined,
            accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
            secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
            forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, true),
            prefix: env.S3_PREFIX ?? "",
          }
        : { driver: "local", root: path.resolve(env.NX_MEDIA_DIR ?? path.join(dataDir, "media")) },
    session: {
      ttlDays: int(env.SESSION_TTL_DAYS, 30),
      cookieSecure: bool(env.COOKIE_SECURE, isProd),
      cookieName: "nx_session",
    },
    bootstrapAdmin:
      env.ADMIN_EMAIL && env.ADMIN_PASSWORD
        ? { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, name: env.ADMIN_NAME ?? "Admin" }
        : null,
    worker: {
      id: env.NX_WORKER_ID ?? `worker-${process.pid}`,
      concurrency: int(env.NX_WORKER_CONCURRENCY, 2),
      leaseSeconds: int(env.NX_LEASE_SECONDS, 60),
      pollMs: int(env.NX_WORKER_POLL_MS, 1000),
    },
    enableMock: bool(env.NX_ENABLE_MOCK, true),
    mockMinSeconds: int(env.NX_MOCK_MIN_SECONDS, 4),
    gpuEndpoints: parseEndpoints(env.NX_GPU_ENDPOINTS),
    rateLimit: { max: int(env.RATE_LIMIT_MAX, 600), loginMax: int(env.RATE_LIMIT_LOGIN_MAX, 10) },
  };
}

/** Non-secret view of the configuration for the admin page. */
export function publicConfig(c: Config) {
  return {
    env: c.env,
    role: c.role,
    port: c.port,
    trustProxy: c.trustProxy,
    database: c.databaseUrl.replace(/\/\/([^:@/]+)(:[^@/]*)?@/, "//$1:••••@"),
    storage:
      c.storage.driver === "local"
        ? { driver: "local", root: c.storage.root }
        : { driver: "s3", bucket: c.storage.bucket, region: c.storage.region, endpoint: c.storage.endpoint ?? null, prefix: c.storage.prefix },
    session: c.session,
    worker: c.worker,
    enableMock: c.enableMock,
    gpuEndpoints: c.gpuEndpoints.map((e) => ({ id: e.id, url: e.url, engines: e.engines ?? null, token: e.tokenEnv ? `env:${e.tokenEnv}` : null })),
  };
}
