import { expect, request, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { DEV_PASSWORD } from "./helpers";

// T-124: Better Auth 1.7.7 prefers `BETTER_AUTH_SECRETS` over the per-surface `secret` option, which would give every
// surface one shared secret. The app refuses the variable: no sign-in surface answers and no session cookie is issued.
// Own server on E2E_PORT + 5 (+1/+2: ops and security-headers specs, +3: host-mode server, +4: two-root spec).
test.use({ trace: "off" });
const PORT = Number(process.env.E2E_PORT ?? 3100) + 5;
const host = (label: string) => `${label}.localhost:${PORT}`;
let server: ChildProcess | undefined;

test.beforeAll(async () => {
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
      OWNER_ORIGIN: `http://${host("owner")}`,
      APP_ORIGIN: `http://${host("app")}`,
      CHECKOUT_ORIGIN: `http://${host("checkout")}`,
      AFFILIATE_ORIGIN: `http://${host("affiliate")}`,
      BUYER_ORIGIN: `http://${host("buyer")}`,
      // e2e-only placeholder, never a real secret
      BETTER_AUTH_SECRETS: "1:e2e-only-shared-secret-placeholder-0123456789abcdef",
    },
    stdio: "ignore",
  });
  const probe = await request.newContext();
  try {
    await expect.poll(async () => (await probe.get(`http://127.0.0.1:${PORT}/api/health`).catch(() => null))?.status(), { timeout: 60_000 }).toBe(200);
  } finally {
    await probe.dispose();
  }
});

test.afterAll(() => {
  server?.kill();
});

test("with BETTER_AUTH_SECRETS set no surface signs in or issues a session cookie", async () => {
  for (const label of ["owner", "app", "affiliate", "buyer"]) {
    const ctx = await request.newContext({ baseURL: `http://127.0.0.1:${PORT}`, extraHTTPHeaders: { host: host(label) } });
    try {
      const res = await ctx.post("/api/auth/sign-in/email", { headers: { origin: `http://${host(label)}` }, data: { email: "owner-a@bukalaris.local", password: DEV_PASSWORD }, maxRedirects: 0 });
      expect(res.status(), label).toBeGreaterThanOrEqual(500);
      const sessionCookie = res.headersArray().some((h) => h.name.toLowerCase() === "set-cookie" && /^(__Host-)?bl_(owner|seller|aff|buyer)=/.test(h.value));
      expect(sessionCookie, `${label}: no session cookie`).toBe(false);
    } finally {
      await ctx.dispose();
    }
  }
});
