import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Browser evidence for M1 against a production build (`pnpm build` first) and the
// disposable E2E_DATABASE_URL database, which global-setup wipes, migrates and seeds.
if (existsSync("../../.env")) process.loadEnvFile("../../.env");
// E2E_PORT lets parallel worktrees run their suites side by side.
const PORT = Number(process.env.E2E_PORT ?? 3100);
// ops.spec and security-headers.spec start their own servers on PORT + 1 and PORT + 2; the host-mode server takes PORT + 3.
const HOST_PORT = PORT + 3;
// Match Next\'s normalized loopback origin without opening a non-loopback listener.
// Keep other caller Node options; the final DNS option pins localhost to IPv4 first.
const LOCAL_SERVER_ENV = { HOSTNAME: "localhost", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --dns-result-order=ipv4first`.trim() };
// Per-run throwaway key for the encrypted ad-platform tokens (T-38): e2e never depends on, or
// reuses, a developer's local secret. The disposable e2e database is wiped every run anyway.
// Set on process.env so the web server, the worker and any server a spec spawns share it.
process.env.INTEGRATION_TOKEN_KEY = randomBytes(32).toString("base64");
// Callback HMAC of the AutoLaris contract (T-49). Fixed (not random) because specs sign callbacks with it too; the e2e database is
// disposable and the value is a placeholder, never a real secret.
process.env.AUTOLARIS_CALLBACK_SECRET = "e2e-only-autolaris-callback-secret-0123456789abcdef";
// Buyer contact fingerprint ring (T-57): a fixed e2e-only placeholder so checkout never depends on a developer's local secret.
process.env.KEYRING_BUYER_FINGERPRINT = "e2e1:ZTJlLW9ubHktYnV5ZXItZmluZ2VycHJpbnQta2V5ISE=";
process.env.KEYRING_SHIPPING_CREDENTIALS = "e2eship:ZTJlLW9ubHktc2hpcHBpbmcta2V5LXNlcGFyYXRlISE=";
// Signed checkout resume links (T-45): a fixed e2e-only placeholder ring; specs sign and tamper with links using the same key.
process.env.KEYRING_CHECKOUT_RESUME = "e2er1:ZTJlLW9ubHktY2hlY2tvdXQtcmVzdW1lLWtleS0wMSE=";
// T-73: the production build the suite runs against has no mail provider; local mode is allowed only on a loopback origin.
// Set on process.env so every server a spec spawns inherits it.
process.env.MAIL_MODE = "local";
// Three database roles as in production (ADR-0005): the web app runs as bukalaris_app with
// RLS applied, operators and the worker as bukalaris_platform, the global setup migrates as
// bukalaris_owner; the superuser URL only creates roles/database. Same local placeholder
// convention as packages/db/src/local-roles.ts (password = role name, docker/05-roles.sql);
// duplicated here because Playwright's config loader cannot import that ESM file.
const asRole = (url: string, role: string) => {
  const u = new URL(url);
  u.username = role;
  u.password = role;
  return u.toString();
};
const E2E_DB = process.env.E2E_DATABASE_URL ?? "";
const APP_DB = E2E_DB && asRole(E2E_DB, "bukalaris_app");
const PLATFORM_DB = E2E_DB && asRole(E2E_DB, "bukalaris_platform");
// Shared with e2e/global-setup.ts through the environment (like INTEGRATION_TOKEN_KEY).
process.env.E2E_OWNER_DATABASE_URL = E2E_DB && asRole(E2E_DB, "bukalaris_owner");
process.env.E2E_APP_DATABASE_URL = APP_DB;
process.env.E2E_PLATFORM_DATABASE_URL = PLATFORM_DB;
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "mobile-320", testIgnore: /host-mode/, use: { ...devices["Desktop Chrome"], viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true } },
    { name: "desktop", testIgnore: /host-mode/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    // T-70: exact-host dispatch and per-surface sessions, against a second server whose per-surface origins are
    // `<surface>.localhost:<HOST_PORT>` (Chrome resolves *.localhost to loopback). One viewport is enough: no layout is asserted.
    { name: "host-mode", testMatch: /host-mode/, use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${HOST_PORT}` } },
  ],
  webServer: [
    {
      // The same standalone server the Docker image runs (env comes from .env + below).
      command: `PORT=${PORT} NEXT_TELEMETRY_DISABLED=1 pnpm start:standalone`,
      // Better Auth's origin check compares against BETTER_AUTH_URL, so it must match this port.
      // Disposable upload directory next to the disposable database (wiped by global-setup).
      env: { ...LOCAL_SERVER_ENV, DATABASE_URL: APP_DB, PLATFORM_DATABASE_URL: PLATFORM_DB, BETTER_AUTH_URL: `http://localhost:${PORT}`, MEDIA_DIR: resolve("var/e2e-media") },
      url: `http://localhost:${PORT}/api/health`,
      // Never reuse a server that may point at the dev database.
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Same build, own port and per-surface origins (DOM-5 link origins). `start:standalone` copies the static assets
      // once for the first server; this one only runs the already prepared standalone server.
      command: `PORT=${HOST_PORT} NEXT_TELEMETRY_DISABLED=1 node .next/standalone/apps/web/server.js`,
      env: {
        ...LOCAL_SERVER_ENV,
        DATABASE_URL: APP_DB,
        PLATFORM_DATABASE_URL: PLATFORM_DB,
        BETTER_AUTH_URL: `http://localhost:${HOST_PORT}`,
        STORE_ROOT_DOMAIN: "localhost",
        OWNER_ORIGIN: `http://owner.localhost:${HOST_PORT}`,
        APP_ORIGIN: `http://app.localhost:${HOST_PORT}`,
        CHECKOUT_ORIGIN: `http://checkout.localhost:${HOST_PORT}`,
        AFFILIATE_ORIGIN: `http://affiliate.localhost:${HOST_PORT}`,
        BUYER_ORIGIN: `http://buyer.localhost:${HOST_PORT}`,
        MEDIA_DIR: resolve("var/e2e-media"),
      },
      url: `http://localhost:${HOST_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Outbox worker (T-32): transfer orders get their payment reference from it, as in production.
      command: "node ../../packages/db/src/worker.ts",
      // BETTER_AUTH_URL: the worker renders e-mail links against the public origin (T-36), i.e. this port.
      env: { PLATFORM_DATABASE_URL: PLATFORM_DB, WORKER_POLL_MS: "1000", BETTER_AUTH_URL: `http://localhost:${PORT}` },
      wait: { stdout: /"event":"started"/ },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
