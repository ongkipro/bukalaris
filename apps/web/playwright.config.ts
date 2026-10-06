import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Browser evidence for M1 against a production build (`pnpm build` first) and the
// disposable E2E_DATABASE_URL database, which global-setup wipes, migrates and seeds.
if (existsSync("../../.env")) process.loadEnvFile("../../.env");
// E2E_PORT lets parallel worktrees run their suites side by side.
const PORT = Number(process.env.E2E_PORT ?? 3100);
// Per-run throwaway key for the encrypted ad-platform tokens (T-38): e2e never depends on, or
// reuses, a developer's local secret. The disposable e2e database is wiped every run anyway.
// Set on process.env so the web server, the worker and any server a spec spawns share it.
process.env.INTEGRATION_TOKEN_KEY = randomBytes(32).toString("base64");
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "mobile-320", use: { ...devices["Desktop Chrome"], viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: [
    {
      // The same standalone server the Docker image runs (env comes from .env + below).
      command: `PORT=${PORT} NEXT_TELEMETRY_DISABLED=1 pnpm start:standalone`,
      // Better Auth's origin check compares against BETTER_AUTH_URL, so it must match this port.
      // Disposable upload directory next to the disposable database (wiped by global-setup).
      env: { DATABASE_URL: process.env.E2E_DATABASE_URL ?? "", BETTER_AUTH_URL: `http://localhost:${PORT}`, MEDIA_DIR: resolve("var/e2e-media") },
      url: `http://localhost:${PORT}/api/health`,
      // Never reuse a server that may point at the dev database.
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Outbox worker (T-32): transfer orders get their payment reference from it, as in production.
      command: "node ../../packages/db/src/worker.ts",
      // BETTER_AUTH_URL: the worker renders e-mail links against the public origin (T-36), i.e. this port.
      env: { DATABASE_URL: process.env.E2E_DATABASE_URL ?? "", WORKER_POLL_MS: "1000", BETTER_AUTH_URL: `http://localhost:${PORT}` },
      wait: { stdout: /"event":"started"/ },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
