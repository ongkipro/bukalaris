import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";

// T-83 RL-LOGIN over HTTP. The suite already runs two independent production servers on one database: the main server
// (E2E_PORT) and the host-mode server (E2E_PORT + 3). On plain `localhost` both serve the same `local` auth surface, so a
// shared counter must give them ONE sign-in budget; per-process memory would give each its own. Named "host-mode-*" so it
// runs once (host-mode project), not per viewport. No cookies or tokens are involved: only wrong-password sign-ins.
test.use({ trace: "off" });
const MAIN = Number(process.env.E2E_PORT ?? 3100);
const HOST = MAIN + 3;
const SIGN_IN = { window: 10, max: 3 }; // Better Auth's own sign-in rule (unchanged by T-83)

async function server(port: number): Promise<APIRequestContext> {
  // Same loopback client address for both servers; Host and Origin name each server's own `local` surface.
  return request.newContext({ baseURL: `http://127.0.0.1:${port}`, extraHTTPHeaders: { host: `localhost:${port}` } });
}
const attempt = (ctx: APIRequestContext, port: number, email = "owner-a@bukalaris.local") =>
  ctx.post("/api/auth/sign-in/email", { headers: { origin: `http://localhost:${port}` }, data: { email, password: "wrong-password-t83" } });

/** Start right after a fixed-window boundary so the checked requests cannot straddle two windows. */
async function freshWindow() {
  const ms = SIGN_IN.window * 1000;
  await sleep(ms - (Date.now() % ms) + 300);
}

test("T83 two independent servers share one sign-in budget; the refusal is uniform and bounded", async () => {
  const main = await server(MAIN);
  const host = await server(HOST);
  try {
    await freshWindow();
    for (let i = 0; i < SIGN_IN.max; i++) expect((await attempt(main, MAIN)).status(), `main attempt ${i + 1} is allowed (wrong password)`).toBe(401);
    // The fourth request goes to the OTHER process: only a shared counter refuses it.
    const refused = await attempt(host, HOST);
    expect(refused.status(), "the other server sees the spent budget").toBe(429);
    const retry = Number(refused.headers()["x-retry-after"]);
    expect(retry >= 1 && retry <= SIGN_IN.window, "bounded, recoverable retry hint").toBe(true);
    // Non-enumeration: an unknown account gets the identical refusal.
    const unknown = await attempt(main, MAIN, `nobody-${Date.now()}@example.com`);
    expect(unknown.status()).toBe(429);
    expect(await unknown.text(), "identical refusal for unknown and known accounts").toBe(await refused.text());
    // Recovery: the next window allows sign-in attempts again on either server.
    await freshWindow();
    expect((await attempt(host, HOST)).status(), "next window is allowed again").toBe(401);
  } finally { await main.dispose(); await host.dispose(); }
});

test("T83 a failing counter store refuses sign-in with a bounded 429, never a bypass, and recovers", async () => {
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const main = await server(MAIN);
  try {
    await freshWindow();
    // Disposable E2E database only: the app role temporarily loses write access to the counter table.
    await sql`revoke insert, update on rate_limit from bukalaris_app`;
    try {
      const res = await attempt(main, MAIN);
      expect(res.status(), "counter failure refuses instead of allowing").toBe(429);
      expect(Number(res.headers()["x-retry-after"]), "retry hint is one window").toBe(SIGN_IN.window);
    } finally {
      await sql`grant insert, update on rate_limit to bukalaris_app`;
    }
    expect((await attempt(main, MAIN)).status(), "the restored store allows again").toBe(401);
  } finally { await main.dispose(); await sql.end(); }
});
