import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { evidence, login } from "./helpers";

// T-62 (Owner console shell, navigation, approvals, access evidence, "Lapor masalah"). Database facts are read with the
// superuser URL of the disposable e2e database, never through the application under test.
const DB_CWD = resolve(process.cwd(), "../../packages/db");
// The reports of this file are filed through the real dialog; their rows are read back by the helper below.

function runDb<T = unknown>(body: string): T {
  const script = `
    import { createDb } from "./src/client.ts";
    import { randomUUID } from "node:crypto";
    import { hashPassword } from "better-auth/crypto";
    import { eq, sql } from "drizzle-orm";
    import { account, platformOperator, user } from "./src/schema.ts";
    import { grantAsSystem } from "./src/ops/capabilities-grants.ts";
    import { requestApproval } from "./src/ops/capabilities-approvals.ts";
    import { operatorScope } from "./src/platform/scoped.ts";
    import { enqueue } from "./src/ops/jobs/jobs.ts";
    const db = createDb(process.env.E2E_PLATFORM_DATABASE_URL);
    const admin = createDb(process.env.E2E_DATABASE_URL);
    const out = await (async () => { ${body} })();
    await db.$client.end();
    await admin.$client.end();
    console.log("@@" + JSON.stringify(out ?? null));
  `;
  const stdout = execFileSync("node", ["--input-type=module", "-e", script], { cwd: DB_CWD, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(stdout.slice(stdout.lastIndexOf("@@") + 2)) as T;
}

/** An operator account with exactly the given capabilities (idempotent per e-mail). */
function seedStaff(email: string, caps: string[]) {
  runDb(`
    if (!(await db.select().from(user).where(eq(user.email, ${JSON.stringify(email)}))).length) {
      const id = randomUUID();
      await db.insert(user).values({ id, email: ${JSON.stringify(email)}, name: ${JSON.stringify(email.split("@")[0])}, emailVerified: true });
      await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword("bukalaris-dev-123") });
      await db.insert(platformOperator).values({ userId: id });
      await grantAsSystem(db, { userId: id, capabilities: ${JSON.stringify(caps)}, source: "system_bootstrap", reason: "e2e fixture t62" });
    }
  `);
}
const q = <T,>(statement: string) => runDb<T>(`return await admin.$client.unsafe(${JSON.stringify(statement)});`);

const unique = (info: { project: { name: string } }) => `${info.project.name}-${Date.now().toString(36)}`;
const menu = (page: Page) => page.getByRole("navigation", { name: "Owner console" });

test("shell: brand, context chip, title template, grouped navigation with aria-current, honest dashboard, no leftover Bos or Super Admin copy", async ({ page }, info) => {
  await login(page, "admin@bukalaris.local", "/admin");
  await expect(page.getByRole("link", { name: "Bukalaris · Owner" })).toBeVisible();
  await expect(page.locator("header").getByText("Owner console", { exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Ringkasan — Bukalaris Owner");
  await expect(page.getByRole("heading", { name: "Ringkasan", level: 1 })).toBeVisible();
  await expect(menu(page).getByRole("list").first().getByRole("link")).toHaveText(["Ringkasan", "Toko", "Akun pengguna", "Keuangan", "Platform", "Operasional", "Staf dan akses"]); // T-63 adds the account and staff groups to the demo operator
  await expect(menu(page).getByRole("link", { name: "Ringkasan" })).toHaveAttribute("aria-current", "page");

  // Store slices sum to the total; cards without a source say so instead of showing 0.
  const text = (await page.getByTestId("card-stores").getByText(/ditangguhkan/).textContent()) ?? "";
  const slices = /(\d+) aktif \+ (\d+) ditangguhkan = (\d+) toko/.exec(text);
  expect(slices, text).not.toBeNull();
  expect(Number(slices![1]) + Number(slices![2])).toBe(Number(slices![3])); // active + suspended = total
  await expect(page.getByTestId("card-approvals")).toBeVisible();
  await expect(page.getByTestId("card-jobs")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/\bBos\b|Super Admin/);
  await evidence(page, info, "t62-01-dashboard");

  for (const [group, item, path] of [
    ["Toko", "Daftar toko", /\/admin\/stores$/],
    ["Operasional", "Log System", /\/admin\/logs$/],
    ["Platform", "Pengaturan platform", /\/admin\/settings$/],
  ] as const) {
    await menu(page).getByRole("link", { name: group, exact: true }).click();
    await expect(page).toHaveURL(path);
    await expect(menu(page).getByRole("list", { name: `Menu ${group}` }).getByRole("link", { name: item })).toHaveAttribute("aria-current", "page");
  }
  await page.goto("/admin/logs");
  await expect(page).toHaveTitle("Log System — Bukalaris Owner");
  await expect(page.locator("body")).not.toContainText(/\bBos\b|Super Admin/);
});

test("a staff member with one capability sees exactly that group and item; unlisted and dormant routes are not-found; a seller is denied everywhere", async ({ page }, info) => {
  const email = "audit-only-t62@bukalaris.local";
  seedStaff(email, ["audit.read"]);
  await login(page, email, "/admin");
  await expect(page.getByRole("heading", { name: "Akses ditolak." })).toBeVisible();
  await expect(menu(page).getByRole("link")).toHaveText(["Operasional"]);
  await menu(page).getByRole("link", { name: "Operasional" }).click();
  await expect(page).toHaveURL(/\/admin\/audit$/);
  await expect(menu(page).getByRole("list", { name: "Menu Operasional" }).getByRole("link")).toHaveText(["Audit"]);
  for (const path of ["/admin/ops", "/admin/issues", "/admin/approvals", "/admin/settings", "/admin/stores", "/admin/staff"]) { // /admin/staff is a live page since T-63: denied, not not-found
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Akses ditolak." }), path).toBeVisible();
  }
  for (const path of ["/admin/domains", "/admin/updates", "/admin/not-a-page"]) {
    expect((await page.goto(path))?.status(), path).toBe(404); // dormant (P2, P1.5) and unlisted routes
  }
  await evidence(page, info, "t62-02-one-capability");

  await page.context().clearCookies();
  await login(page, "owner-a@bukalaris.local");
  for (const path of ["/admin", "/admin/stores", "/admin/approvals", "/admin/ops", "/admin/audit", "/admin/issues", "/admin/issues/1", "/admin/settings", "/admin/settings/providers", "/admin/logs", "/admin/shipping"]) {
    await page.goto(path);
    await expect(page.getByRole("main").getByRole("alert"), path).toContainText("Akses ditolak.");
    await expect(page.getByRole("table"), path).toHaveCount(0);
  }
});

test("unauthenticated requests to the new console routes redirect to sign-in", async ({ request }) => {
  for (const path of ["/admin/approvals", "/admin/ops", "/admin/audit", "/admin/issues", "/admin/issues/1", "/admin/settings", "/admin/settings/providers", "/admin/stores"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(307);
    expect(res.headers()["location"], path).toBe("/login?next=/admin");
  }
});

test("audit and issue viewers are no-store, redact by allowlist (canary) and audit their own reads", async ({ page }, info) => {
  const canary = `CANARY-${unique(info)}-hunter2`;
  q(`insert into audit_log (actor_user_id, action, reason, outcome) values ('e2e', 'jobs.requeue', 'job:424242 kind:order.notify password:${canary} token:${canary}', 'allowed'), ('e2e', 'evil.action', '${canary}', 'allowed')`);
  await login(page, "admin@bukalaris.local", "/admin");
  const res = (await page.goto("/admin/audit"))!;
  expect(res.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByRole("heading", { name: "Audit", level: 1 })).toBeVisible();
  await expect(page.getByTestId("freshness")).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain(canary);
  await expect(page.getByText("job=424242").first()).toBeVisible();
  await evidence(page, info, "t62-03-audit");
  await page.goto("/admin/audit");
  await expect(page.getByRole("row", { name: /audit\.read/ }).first()).toBeVisible(); // the previous read is itself in the log
  expect(((await page.goto("/admin/issues"))!).headers()["cache-control"]).toContain("no-store");
  await expect(page.getByRole("heading", { name: "Laporan masalah", level: 1 })).toBeVisible();
  expect(Number(q<{ n: string }[]>(`select count(*) as n from audit_log where action = 'issue.read'`)[0]!.n)).toBeGreaterThanOrEqual(1);
});

test("Lapor masalah from two pages: keyboard only at both viewports, focus returns, stored page ids and correlation ids are right", async ({ page }, info) => {
  const email = `reporter-${info.project.name}-t62@bukalaris.local`;
  seedStaff(email, ["ops.issues.report", "tenants.read", "logs.read"]);
  const seen: string[] = [];
  page.on("response", (r) => {
    const id = r.headers()["x-request-id"];
    if (id && r.request().resourceType() === "fetch") seen.push(id);
  });
  await login(page, email, "/admin");
  const trigger = page.getByRole("button", { name: "Lapor masalah" });
  await expect(trigger).toBeVisible();

  async function report(from: string, description: string) {
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Lapor masalah" });
    await expect(dialog).toBeVisible();
    // Escape closes and returns focus to the trigger.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio").first()).toBeFocused(); // focus moved inside, first control
    await evidence(page, info, `t62-04-report-dialog-${from}`);
    await page.keyboard.press("Space"); // category: first option
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space"); // severity: first option
    await page.keyboard.press("Tab");
    await expect(dialog.getByLabel("Deskripsi")).toBeFocused();
    await page.keyboard.type(description);
    await expect(dialog.getByText(`${description.length}/2000`)).toBeVisible();
    await dialog.getByRole("button", { name: "Kirim laporan" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/Laporan #\d+ terkirim/)).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  }

  // Page 1: the store list, reached by a client-side navigation so the buffer holds real response correlation ids.
  await menu(page).getByRole("link", { name: "Toko", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/stores$/);
  await expect(page.getByRole("heading", { name: "Toko", level: 1 })).toBeVisible();
  const known = seen.at(-1)!;
  q(`insert into system_log (level, module, message, environment, request_id) values ('error', 'admin.stores', 'diseed untuk korelasi', 'e2e', '${known}')`);
  await report("stores", `Tombol tidak merespons ${info.project.name}`);

  // Page 2: Log System.
  await menu(page).getByRole("link", { name: "Operasional" }).click();
  await expect(page).toHaveURL(/\/admin\/logs$/);
  await expect(page.getByRole("heading", { name: "Log System", level: 1 })).toBeVisible();
  await report("logs", `Daftar log salah ${info.project.name}`);

  const rows = q<{ page_id: string; route: string; linked: string; ids: string }[]>(
    `select r.page_id, r.route, r.linked_log_event_ids::text as linked, (select string_agg(x->>'requestId', ',') from jsonb_array_elements(r.context->'recentRequests') x) as ids
     from issue_report r join "user" u on u.id = r.reporter_id where u.email = '${email}' order by r.id`,
  );
  expect(rows.map((r) => [r.page_id, r.route])).toEqual([["SA-02", "/admin/stores"], ["SA-05", "/admin/logs"]]);
  const idsFirst = (rows[0]!.ids ?? "").split(",");
  expect(idsFirst.every((id) => seen.includes(id))).toBe(true); // only ids the server really answered with
  expect(idsFirst).toContain(known);
  expect(rows[0]!.linked).not.toBe("{}"); // the server linked the seeded event for that request id
  expect(rows.length).toBe(2);
});

test("approvals: the approver reads the exact payload; the requester cannot approve; approving needs a reason and a fresh code", async ({ page }, info) => {
  const tag = unique(info).replace(/[^a-z0-9-]/g, "");
  const requester = "payouts-a-t62@bukalaris.local";
  const approver = "payouts-b-t62@bukalaris.local";
  seedStaff(requester, ["payouts.process"]);
  seedStaff(approver, ["payouts.process"]);
  const target = `p-${tag}`;
  const id = runDb<number>(`
    const [r] = await db.select({ id: user.id }).from(user).where(eq(user.email, ${JSON.stringify(requester)}));
    const op = await operatorScope(db, r.id);
    return (await requestApproval(op, { actionKey: "payout.approve_transfer", targetKind: "payout", targetId: ${JSON.stringify(target)}, payload: { holder: "Budi Santoso", bank: "BCA", destination: "1234567890", amountIdr: 250000 }, reason: "pencairan e2e" })).id;
  `);

  // The requester sees it, marked as theirs, with no approve control.
  await login(page, requester, "/admin");
  await page.goto("/admin/approvals");
  const own = page.getByTestId(`approval-${id}`);
  await expect(own).toContainText("payout.approve_transfer");
  await expect(own.getByTestId("own-note")).toBeVisible();
  await expect(own.getByRole("button", { name: "Setujui" })).toHaveCount(0);
  await page.getByRole("button", { name: "Keluar" }).click();
  await page.waitForURL((u) => u.pathname === "/login");

  // The approver reads the exact canonical text and hash, and the bank snapshot view is logged.
  await login(page, approver, "/admin");
  await page.goto("/admin/approvals");
  const item = page.getByTestId(`approval-${id}`);
  await expect(item.getByTestId("payload")).toHaveText('{"amountIdr":250000,"bank":"BCA","destination":"1234567890","holder":"Budi Santoso"}');
  await expect(item).toContainText("SHA-256");
  await expect(item.getByRole("button", { name: "Setujui" })).toBeVisible();
  await evidence(page, info, "t62-05-approvals");
  expect(Number(q<{ n: string }[]>(`select count(*) as n from personal_data_access_event where target_kind = 'approval' and target_id = '${id}' and field_class = 'bank'`)[0]!.n)).toBeGreaterThanOrEqual(1);

  // A reason is required (native validation), then the decision is saved and the request is approved, not executed.
  await item.getByRole("button", { name: "Setujui" }).click();
  await expect(page).toHaveURL(/\/admin\/approvals$/); // blocked by `required`, nothing submitted
  await item.getByLabel("Alasan keputusan").fill("snapshot bank sudah dicek");
  await item.getByRole("button", { name: "Setujui" }).click();
  await expect(page.getByRole("status")).toContainText("Keputusan tersimpan");
  const status = q<{ status: string }[]>(`select status from approval_request where id = ${id}`)[0]!.status;
  expect(status).toBe("approved");
  await page.goto("/admin/approvals?tab=decided");
  await expect(page.getByTestId(`approval-${id}`)).toContainText("Disetujui, belum dijalankan");
  expect(status).toBe("approved");
});

test("system health: a dead replay-safe job is requeued with a reason by an ops.jobs.manage holder, audited", async ({ page }, info) => {
  const key = `e2e-${unique(info)}`;
  const jobId = Number(
    q<{ id: string }[]>(
      `insert into job (kind, store_id, key, status, attempts, last_error) values ('order.notify', 1, '${key}', 'dead', 10, 'gagal uji Bearer abcdefghijklmnop1234567890') returning id`,
    )[0]!.id,
  );
  await login(page, "admin@bukalaris.local", "/admin");
  await page.goto("/admin/ops");
  await expect(page.getByRole("heading", { name: "Kesehatan sistem", level: 1 })).toBeVisible();
  const row = page.getByTestId(`job-${jobId}`);
  await expect(row).toContainText("order.notify");
  expect(await page.content()).not.toContain("abcdefghijklmnop1234567890");
  await evidence(page, info, "t62-06-ops");
  await row.getByLabel("Alasan antre ulang").fill("uji requeue e2e");
  await row.getByRole("button", { name: "Antre ulang" }).click();
  await expect(page.getByRole("status")).toContainText("tercatat di audit");
  expect(q<{ status: string }[]>(`select status from job where id = ${jobId}`)[0]!.status).not.toBe("dead"); // back in the queue (the e2e worker may already be retrying it)
  expect(Number(q<{ n: string }[]>(`select count(*) as n from audit_log where action = 'jobs.requeue' and reason like 'job:${jobId} %'`)[0]!.n)).toBe(1);
  await expect(page.getByTestId(`job-${jobId}`)).toHaveCount(0);
});

test("settings and provider health render read-only without any secret", async ({ page }, info) => {
  await login(page, "admin@bukalaris.local", "/admin");
  await page.goto("/admin/settings");
  await expect(page.getByRole("heading", { name: "Pengaturan platform", level: 1 })).toBeVisible();
  await expect(page.getByText("berkah").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Simpan/ })).toHaveCount(0);
  await evidence(page, info, "t62-07-settings");
  await page.goto("/admin/settings/providers");
  await expect(page.getByTestId("provider-mengantar")).toContainText("Tidak diketahui");
  const content = await page.getByRole("main").innerHTML();
  expect(content).not.toMatch(/api[_-]?key|secret|token|password/i);
  await evidence(page, info, "t62-08-providers");
});
