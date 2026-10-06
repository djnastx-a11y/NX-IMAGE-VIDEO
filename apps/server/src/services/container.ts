import { EventEmitter } from "node:events";
import type pg from "pg";
import type { Config } from "../config.js";
import { createPool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { logger, type Logger } from "../lib/logger.js";
import { JobsRepo } from "../repos/jobs.js";
import { MediaRepo } from "../repos/media.js";
import { PresetsRepo, ProviderSettingsRepo } from "../repos/presets.js";
import { ProjectsRepo } from "../repos/projects.js";
import { AuditRepo, SettingsRepo } from "../repos/settings.js";
import { SessionsRepo, UsersRepo } from "../repos/users.js";
import { LocalStorage, type StorageProvider } from "../storage/storage.js";
import { S3Storage } from "../storage/s3.js";
import { ProviderRegistry } from "../providers/registry.js";
import { MockImageProvider } from "../providers/mock/image.js";
import { MockVideoProvider } from "../providers/mock/video.js";
import { discoverRemoteProviders } from "../providers/remote/remote-provider.js";
import { hashPassword } from "../auth/password.js";
import { BUILTIN_PRESETS } from "./presets.js";

/** Emits ("job", jobId, ownerId) for every job change, fed by Postgres LISTEN/NOTIFY (works across processes). */
export class JobEvents extends EventEmitter {
  private client: pg.PoolClient | null = null;
  constructor(private readonly pool: pg.Pool) {
    super();
    this.setMaxListeners(1000);
  }
  async start() {
    this.client = await this.pool.connect();
    this.client.on("notification", (n) => {
      const [id, owner] = (n.payload ?? "").split(":");
      if (id && owner) this.emit("job", id, owner);
    });
    await this.client.query("LISTEN nx_job_events");
  }
  async stop() {
    if (!this.client) return;
    await this.client.query("UNLISTEN *").catch(() => {});
    this.client.release();
    this.client = null;
  }
}

export interface Services {
  config: Config;
  pool: pg.Pool;
  logger: Logger;
  users: UsersRepo;
  sessions: SessionsRepo;
  projects: ProjectsRepo;
  media: MediaRepo;
  jobs: JobsRepo;
  presets: PresetsRepo;
  providerSettings: ProviderSettingsRepo;
  settings: SettingsRepo;
  audit: AuditRepo;
  storage: StorageProvider;
  registry: ProviderRegistry;
  events: JobEvents;
  /** Set by the in-process worker so new jobs start without waiting for the next poll */
  pokeWorker?: () => void;
  close(): Promise<void>;
}

export function createStorage(config: Config): StorageProvider {
  if (config.storage.driver === "s3") return new S3Storage(config.storage);
  return new LocalStorage(config.storage.root);
}

export async function createServices(config: Config, opts: { listen?: boolean } = {}): Promise<Services> {
  const pool = createPool(config.databaseUrl);
  await migrate(pool, (m) => logger.info(m));
  const media = new MediaRepo(pool);
  const settings = new SettingsRepo(pool);
  const providerSettings = new ProviderSettingsRepo(pool);
  const registry = new ProviderRegistry(providerSettings, settings);
  if (config.enableMock) {
    await registry.register(new MockImageProvider(config.mockMinSeconds));
    await registry.register(new MockVideoProvider(config.mockMinSeconds));
  }
  for (const p of await discoverRemoteProviders(config.gpuEndpoints)) await registry.register(p);

  const users = new UsersRepo(pool);
  if (config.bootstrapAdmin && (await users.count()) === 0) {
    await users.create({
      email: config.bootstrapAdmin.email,
      name: config.bootstrapAdmin.name,
      passwordHash: await hashPassword(config.bootstrapAdmin.password),
      role: "admin",
    });
    logger.info({ email: config.bootstrapAdmin.email }, "bootstrap admin created");
  }
  const presets = new PresetsRepo(pool);
  await presets.seedBuiltins(BUILTIN_PRESETS);

  const events = new JobEvents(pool);
  if (opts.listen) await events.start();

  return {
    config,
    pool,
    logger,
    users,
    sessions: new SessionsRepo(pool),
    projects: new ProjectsRepo(pool),
    media,
    jobs: new JobsRepo(pool, media),
    presets,
    providerSettings,
    settings,
    audit: new AuditRepo(pool),
    storage: createStorage(config),
    registry,
    events,
    async close() {
      await events.stop();
      await pool.end();
    },
  };
}
