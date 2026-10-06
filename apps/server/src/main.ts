import { loadConfig } from "./config.js";
import { logger } from "./lib/logger.js";
import { createServices } from "./services/container.js";
import { buildApp } from "./api/app.js";
import { JobRunner } from "./worker/runner.js";

/**
 * Single entrypoint; NX_ROLE selects what this process runs:
 *  - "all"    (default) API + web app + worker — simplest deployment
 *  - "api"    HTTP API + web app only
 *  - "worker" generation worker only (scale horizontally: workers share Postgres + storage)
 */
async function main() {
  const config = loadConfig();
  const serveApi = config.role === "all" || config.role === "api";
  const runWorker = config.role === "all" || config.role === "worker";
  const s = await createServices(config, { listen: serveApi });

  let runner: JobRunner | null = null;
  if (runWorker) {
    runner = new JobRunner(
      { jobs: s.jobs, media: s.media, settings: s.settings, storage: s.storage, registry: s.registry, logger: s.logger.child({ component: "worker" }) },
      { workerId: config.worker.id, concurrency: config.worker.concurrency, leaseSeconds: config.worker.leaseSeconds, pollMs: config.worker.pollMs },
    );
    runner.start();
    s.pokeWorker = () => runner!.poke();
    logger.info({ worker: config.worker.id, providers: s.registry.list().map((p) => p.id) }, "worker started");
  }

  const app = serveApi ? await buildApp(s) : null;
  if (app) await app.listen({ host: config.host, port: config.port });

  const purge = setInterval(() => void s.sessions.purgeExpired().catch(() => {}), 3600_000);
  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    logger.info({ sig }, "shutting down");
    clearInterval(purge);
    await app?.close();
    await runner?.stop();
    await s.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  logger.fatal({ err: e }, "fatal startup error");
  process.exit(1);
});
