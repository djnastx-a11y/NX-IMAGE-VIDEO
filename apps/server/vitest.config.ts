import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration tests share one Postgres database: run files sequentially.
    fileParallelism: false,
    env: { NODE_ENV: "test" },
  },
});
