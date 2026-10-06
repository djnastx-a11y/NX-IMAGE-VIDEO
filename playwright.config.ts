import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests in a real browser against a running NX STUDIO (built web + server, mock engines).
 * Start one with `npm run e2e:server` (fresh database), then `npm run e2e`.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "e2e/.results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8787",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, dependencies: ["desktop"] },
  ],
});
