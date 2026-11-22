import { expect, request, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

// T-126 (SEC-22): ORDER_LINK_SECRET no longer falls back to BETTER_AUTH_SECRET. A production server started without it
// refuses to serve (instrumentation `register` throws), so a deployment that forgot the variable fails its health check.
// Own server on E2E_PORT + 6 (+1/+2: ops and security-headers specs, +3: host-mode server, +4: two-root spec, +5: T-124 spec).
test.use({ trace: "off" });
const PORT = Number(process.env.E2E_PORT ?? 3100) + 6;
let server: ChildProcess | undefined;

test.beforeAll(() => {
  server = spawn("node", [".next/standalone/apps/web/server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOSTNAME: "localhost",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --dns-result-order=ipv4first`.trim(),
      NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: process.env.E2E_APP_DATABASE_URL,
      PLATFORM_DATABASE_URL: process.env.E2E_PLATFORM_DATABASE_URL,
      MEDIA_DIR: resolve("var/e2e-media"),
      STORE_ROOT_DOMAIN: "localhost",
      BETTER_AUTH_URL: `http://localhost:${PORT}`,
      ORDER_LINK_SECRET: "",
    },
    stdio: "ignore",
  });
});

test.afterAll(() => {
  server?.kill();
});

test("without ORDER_LINK_SECRET a production server answers no request, even with BETTER_AUTH_SECRET set", async () => {
  expect(process.env.BETTER_AUTH_SECRET, "the fallback candidate is present").toBeTruthy();
  const probe = await request.newContext();
  try {
    await expect.poll(async () => (await probe.get(`http://127.0.0.1:${PORT}/api/health`).catch(() => null))?.status(), { timeout: 60_000 }).toBe(500);
    expect((await probe.get(`http://127.0.0.1:${PORT}/login`)).status()).toBe(500);
  } finally {
    await probe.dispose();
  }
});
