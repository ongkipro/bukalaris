import { expect, test, type APIRequestContext } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { evidence, login } from "./helpers";

const RID = /^[A-Za-z0-9_-]{8,64}$/;
const DB_CWD = resolve(process.cwd(), "../../packages/db");

/**
 * Controlled fixture (OBS-5 "synthetic canaries"): events go through the real
 * sink writer, so the UI shows exactly what production would have stored.
 * Each project gets its own correlation id so the two runs never collide.
 */
function seedEvents(rid: string) {
  const script = `
    import { createDb } from "./src/client.ts";
    import { recordLogEvent } from "./src/ops.ts";
    const db = createDb(process.env.E2E_DATABASE_URL);
    await recordLogEvent(db, { level: "error", module: "checkout", environment: "e2e", release: "e2e-rev",
      message: "Checkout gagal: pembayaran ditolak untuk 081234567890 (budi@contoh.id)",
      fields: { request_id: ${JSON.stringify(rid)}, operation: "action", route: "/checkout", code: "PAYMENT_DECLINED", store_id: 1, password: "hunter2", cookie: "session=abc" } });
    await recordLogEvent(db, { level: "warn", module: "storefront.cart", environment: "e2e",
      message: "Stok berubah saat checkout", fields: { request_id: ${JSON.stringify(rid)}, route: "/s/[store]/cart", store_id: 1 } });
    await recordLogEvent(db, { level: "error", module: "mystery", environment: "e2e",
      message: "Kejadian tanpa pemetaan", fields: { request_id: ${JSON.stringify(rid + "-x")} } });
    await db.$client.end();
  `;
  execFileSync("node", ["--input-type=module", "-e", script], { cwd: DB_CWD, env: process.env, stdio: "inherit" });
}

test.describe("Log System (PR-11)", () => {
  test("operator opens Log System from the button, filters, follows a correlation id", async ({ page }, info) => {
    const rid = `e2e-${info.project.name}-${Date.now().toString(36)}`;
    seedEvents(rid);
    await login(page, "admin@bukalaris.local", "/admin");
    await page.getByRole("link", { name: "Log System" }).click();
    await expect(page).toHaveURL(/\/admin\/logs$/);
    await expect(page.getByRole("heading", { name: "Log System" })).toBeVisible();
    await expect(page.getByTestId("freshness")).toContainText("Terakhir diamati");
    await evidence(page, info, "30-admin-logs");

    // Filter by level: the error row disappears, the warning stays.
    await page.getByLabel("Level").selectOption("warn");
    await page.getByLabel("Request ID").fill(rid);
    await page.getByRole("button", { name: "Terapkan" }).click();
    await expect(page).toHaveURL(/level=warn/);
    await expect(page.getByRole("link", { name: /Stok berubah/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Checkout gagal/ })).toHaveCount(0);

    // Correlation: same request id, all levels.
    await page.getByLabel("Level").selectOption("");
    await page.getByRole("button", { name: "Terapkan" }).click();
    await expect(page.getByRole("link", { name: /Checkout gagal/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Stok berubah/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /tanpa pemetaan/ })).toHaveCount(0);

    await page.getByRole("link", { name: /Checkout gagal/ }).click();
    await expect(page.getByRole("heading", { name: "Detail kejadian" })).toBeVisible();
    // Redaction: phone and password never reach the sink or the page; the safe code does.
    await expect(page.getByTestId("message")).toHaveText("Checkout gagal: pembayaran ditolak untuk [digits] ([email])");
    const html = await page.content();
    for (const canary of ["081234567890", "budi@contoh.id", "hunter2", "session=abc"]) expect(html).not.toContain(canary);
    await expect(page.getByText("PAYMENT_DECLINED").first()).toBeVisible();
    await expect(page.getByTestId("request-id")).toContainText(rid);
    await expect(page.getByText("SF-07")).toBeVisible();
    await expect(page.getByRole("link", { name: /Stok berubah/ })).toBeVisible();
    await evidence(page, info, "31-admin-log-detail");

    // Follow the correlation to the related event, then back restores the list filters.
    await page.getByRole("link", { name: /Stok berubah/ }).click();
    await expect(page.getByTestId("message")).toHaveText("Stok berubah saat checkout");
    await page.getByRole("link", { name: "Kembali ke daftar" }).click();
    await expect(page).toHaveURL(new RegExp(`requestId=${rid}`));
    await expect(page.getByRole("link", { name: /Checkout gagal/ })).toBeVisible();

    // Unknown mapping is stated, not invented.
    await page.getByLabel("Request ID").fill(`${rid}-x`);
    await page.getByRole("button", { name: "Terapkan" }).click();
    await page.getByRole("link", { name: /tanpa pemetaan/ }).click();
    await expect(page.getByText("Pemetaan tidak tersedia")).toBeVisible();
    await expect(page.getByText("Tidak ada kejadian lain dengan request ID ini.")).toBeVisible();

    // Empty-with-filter is distinct from unavailable.
    await page.goto("/admin/logs?requestId=tidak-ada-00000000");
    await expect(page.getByTestId("empty")).toContainText("cocok dengan filter");
    await expect(page.getByText("Sumber log tidak tersedia")).toHaveCount(0);
    // Invalid filters are rejected with a message, not a crash.
    await page.goto("/admin/logs?from=2026-10-03T00:00:00Z&to=2026-10-01T00:00:00Z");
    await expect(page.getByText("Rentang waktu tidak valid")).toBeVisible();
  });

  test("a seller cannot open Log System", async ({ page }) => {
    await login(page, "owner-a@bukalaris.local");
    await page.goto("/admin/logs");
    await expect(page.getByText("Akses ditolak.")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await page.goto("/admin/logs/1");
    await expect(page.getByText("Akses ditolak.")).toBeVisible();
    await expect(page.getByTestId("message")).toHaveCount(0);
  });
});

test.describe("correlation id and error pages", () => {
  test("every response carries a request id; unmatched URLs get the Indonesian 404 with the id", async ({ page, request }, info) => {
    const minted = await request.get("/api/health");
    expect(minted.headers()["x-request-id"]).toMatch(RID);
    const echoed = await request.get("/api/health", { headers: { "x-request-id": "abc-12345678" } });
    expect(echoed.headers()["x-request-id"]).toBe("abc-12345678");
    const rejected = await request.get("/api/health", { headers: { "x-request-id": "bad id!<script>" } });
    expect(rejected.headers()["x-request-id"]).toMatch(RID);
    expect(rejected.headers()["x-request-id"]).not.toBe("bad id!<script>");

    const res = await page.goto("/halaman-yang-tidak-ada");
    expect(res!.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Halaman tidak ditemukan" })).toBeVisible();
    await expect(page.getByTestId("request-id")).toHaveText(res!.headers()["x-request-id"]);
    await evidence(page, info, "32-not-found");

    expect((await request.get("/api/ready")).status()).toBe(200);
  });

  test("with the database unreachable, storefront shows the friendly error page and readiness fails", async ({ page, request }, info) => {
    test.skip(info.project.name !== "desktop", "server-level check; viewport-independent");
    const port = Number(process.env.E2E_PORT ?? 3100) + 1;
    const server = await startStandalone(port, "postgres://bukalaris:bukalaris@127.0.0.1:1/unreachable", request);
    try {
      // Next answers 500 with an HTML shell whose body is the root error boundary (client-rendered), not a raw error dump.
      const res = (await page.goto(`http://127.0.0.1:${port}/s/toko-a`))!;
      const rid = res.headers()["x-request-id"];
      expect(rid).toMatch(RID);
      expect(res.status()).toBe(500);
      await expect(page.getByRole("heading", { name: "Terjadi gangguan" })).toBeVisible();
      await expect(page.getByTestId("request-id")).toHaveText(rid);
      await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
      const body = (await res.text()) + (await page.content());
      for (const leak of ["ECONNREFUSED", "postgres://", "at async", "node_modules", "127.0.0.1:1"]) expect(body).not.toContain(leak);
      await evidence(page, info, "33-db-unreachable");

      const ready = await request.get(`http://127.0.0.1:${port}/api/ready`);
      expect(ready.status()).toBe(503);
      expect(await ready.json()).toEqual({ ok: false });
      expect((await request.get(`http://127.0.0.1:${port}/api/health`)).status()).toBe(200);

      // onRequestError emitted one sanitized JSON line correlated with the failing request.
      await expect
        .poll(() => server.lines().filter((l) => l.level === "error" && l.request_id === rid).length, { timeout: 20_000, message: `no error line for ${rid}; lines: ${JSON.stringify(server.lines())}` })
        .toBeGreaterThan(0);
      const line = server.lines().find((l) => l.level === "error" && l.request_id === rid)!;
      expect(line).toMatchObject({ module: "storefront.catalog", operation: "render", route: expect.stringContaining("/s/[store]") });
      expect(JSON.stringify(line)).not.toContain("postgres://");
    } finally {
      server.kill();
    }
  });
});

/** A second standalone server (same build) pointed at an unreachable database. */
async function startStandalone(port: number, databaseUrl: string, request: APIRequestContext) {
  const out: string[] = [];
  let partial = "";
  const child: ChildProcess = spawn("node", [".next/standalone/apps/web/server.js"], {
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Line-buffer stdout: a chunk boundary can fall inside one JSON line.
  child.stdout!.on("data", (d: Buffer) => {
    const parts = (partial + d.toString()).split("\n");
    partial = parts.pop() ?? "";
    out.push(...parts);
  });
  child.stderr!.on("data", (d: Buffer) => out.push(...d.toString().split("\n")));
  await expect.poll(async () => (await request.get(`http://127.0.0.1:${port}/api/health`).catch(() => null))?.status(), { timeout: 30_000 }).toBe(200);
  return {
    lines: () =>
      out.flatMap((l) => {
        try {
          return l.startsWith("{") ? [JSON.parse(l) as Record<string, unknown>] : [];
        } catch {
          return [];
        }
      }),
    kill: () => child.kill("SIGTERM"),
  };
}
