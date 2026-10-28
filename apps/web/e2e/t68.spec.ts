import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { evidence, login } from "./helpers";

function runDb<T>(body: string): T {
  const stdout = execFileSync("node", ["--input-type=module", "-e", `
    import { createDb } from './src/client.ts';
    import { randomUUID } from 'node:crypto';
    import { hashPassword } from 'better-auth/crypto';
    import { user, account, platformOperator } from './src/schema.ts';
    import { grantAsSystem } from './src/ops/capabilities-grants.ts';
    const db = createDb(process.env.E2E_DATABASE_URL);
    const out = await (async () => { ${body} })();
    await db.$client.end(); console.log('@@'+JSON.stringify(out ?? null));
  `], { cwd: resolve(process.cwd(), "../../packages/db"), encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(stdout.slice(stdout.lastIndexOf("@@") + 2)) as T;
}
const query = <T,>(sql: string) => runDb<T>(`return await db.$client.unsafe(${JSON.stringify(sql)});`);
async function keyboardSubmit(page: Page, button: string) { await page.getByRole("button", { name: button, exact: true }).focus(); await page.keyboard.press("Enter"); }

test("T68 two-page reports: correct ARCH ids and correlation, inert text, assign, triage, duplicate note, safe exports and health at desktop/320px", async ({ page }, info) => {
  // One staff member per viewport project: RL-ISSUE allows 3 reports a minute per staff, and both projects file two.
  const email = `queue-${info.project.name}-t68@bukalaris.local`;
  runDb(`const id=randomUUID(); await db.insert(user).values({id,email:${JSON.stringify(email)},name:'T68 queue',emailVerified:true}); await db.insert(account).values({id:randomUUID(),accountId:id,providerId:'credential',userId:id,password:await hashPassword('bukalaris-dev-123')}); await db.insert(platformOperator).values({userId:id}); await grantAsSystem(db,{userId:id,capabilities:['ops.issues.report','ops.issues.manage','logs.read','tenants.read','ops.read'],source:'system_bootstrap',reason:'t68 fixture'});`);
  await login(page, email, "/admin");
  const tag = `t68-${info.project.name}-${Date.now().toString(36)}`;
  const seen: string[] = [];
  page.on("response", (r) => { const id = r.headers()["x-request-id"]; if (id && r.request().resourceType() === "fetch") seen.push(id); });
  const menu = page.getByRole("navigation", { name: "Owner console" });
  async function report(description: string) {
    const trigger = page.getByRole("button", { name: "Lapor masalah", exact: true });
    await trigger.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Lapor masalah" });
    await expect(dialog.getByRole("radio").first()).toBeFocused();
    await page.keyboard.press("Space"); await page.keyboard.press("Tab"); await page.keyboard.press("Space"); await page.keyboard.press("Tab");
    await expect(dialog.getByLabel("Deskripsi")).toBeFocused(); await page.keyboard.type(description);
    await dialog.getByRole("button", { name: "Kirim laporan" }).focus(); await page.keyboard.press("Enter");
    await expect(page.getByText(/Laporan #\d+ terkirim/)).toBeVisible(); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
  }
  await menu.getByRole("link", { name: "Toko", exact: true }).click(); await expect(page).toHaveURL(/\/admin\/stores$/);
  const known = seen.at(-1)!; expect(known).toBeTruthy();
  query(`insert into system_log (level,module,message,environment,request_id) values ('error','admin.stores','t68 correlation','e2e','${known}')`);
  await report(`=cmd ${tag}`);
  await menu.getByRole("link", { name: "Operasional", exact: true }).click(); await expect(page).toHaveURL(/\/admin\/logs$/);
  await report(`<script>window.t68Canary=true</script> ${tag}`);
  const rows = query<{ id: string; page_id: string; context: { recentRequests: { requestId: string }[] }; linked_log_event_ids: string[] }[]>(`select id,page_id,context,linked_log_event_ids from issue_report where description like '%${tag}%' order by id`);
  expect(rows.map((r) => r.page_id)).toEqual(["SA-02", "SA-05"]);
  expect(rows[0]!.context.recentRequests.map((r) => r.requestId)).toContain(known); expect(rows[0]!.linked_log_event_ids.length).toBeGreaterThan(0);
  const a = Number(rows[0]!.id), b = Number(rows[1]!.id);
  await page.goto(`/admin/issues?q=${tag}`); await expect(page.getByTestId("issue-row")).toHaveCount(2);
  await page.getByLabel("ARCH-5 halaman", { exact: true }).fill("SA-02"); await keyboardSubmit(page, "Terapkan filter");
  await expect(page.getByTestId("issue-row")).toHaveCount(1); await expect(page.getByTestId("issue-row")).toContainText("SA-02");
  await page.goto(`/admin/issues/${b}`); await expect(page.getByTestId("description")).toHaveText(`<script>window.t68Canary=true</script> ${tag}`);
  expect(await page.evaluate(() => (window as Window & { t68Canary?: boolean }).t68Canary)).toBeUndefined();
  await page.goto(`/admin/issues/${a}`);
  await expect(page.getByText("Daftar toko · T-62", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /^Event #/ }).first().click(); await expect(page).toHaveURL(/\/admin\/logs\/\d+/);
  await page.goto(`/admin/issues/${a}`);
  const [actor] = query<{ id: string }[]>(`select id from "user" where email='${email}'`);
  await page.getByLabel("ID penanggung jawab", { exact: true }).fill(actor!.id); await keyboardSubmit(page, "Simpan penugasan");
  await expect(page.getByLabel("ID penanggung jawab", { exact: true })).toHaveValue(actor!.id);
  await page.getByLabel("Status berikut").selectOption("triaged"); await keyboardSubmit(page, "Simpan status");
  await expect(page.getByText("triaged", { exact: true }).first()).toBeVisible();
  await page.goto("/admin/ops"); const before = Number((await page.getByTestId("health-SA-02").getByRole("cell").nth(1).textContent())!);
  await page.goto(`/admin/issues/${a}`); await page.getByLabel("Status berikut").selectOption("duplicate");
  await page.getByLabel("Catatan penyelesaian", { exact: true }).fill("Masalah yang sama, lihat laporan tujuan"); await page.getByLabel("Nomor target duplikat").fill(String(b)); await keyboardSubmit(page, "Simpan status");
  await expect(page.getByText("duplicate", { exact: true }).first()).toBeVisible(); await expect(page.getByText("Masalah yang sama, lihat laporan tujuan", { exact: true }).first()).toBeVisible();
  await page.goto("/admin/ops"); await expect(page.getByTestId("health-SA-02").getByRole("cell").nth(1)).toHaveText(String(before - 1));
  await page.goto(`/admin/issues?q=${tag}`);
  const json = await page.request.get(`/admin/issues/export?format=json&q=${tag}`); expect(json.status()).toBe(200); expect(json.headers()["cache-control"]).toContain("no-store"); const exported = await json.json(); expect(exported).toHaveLength(2); expect(exported.map((r: { pageId: string }) => r.pageId).sort()).toEqual(["SA-02", "SA-05"]);
  const csv = await page.request.get(`/admin/issues/export?format=csv&q=${tag}`); expect(csv.headers()["content-type"]).toContain("text/csv"); expect(await csv.text()).toContain(`"'=cmd ${tag}"`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await evidence(page, info, "t68-queue");
});

test("T68 report-only staff see Lapor masalah but no queue, direct queue/detail/export refused", async ({ page }, info) => {
  const email = `reporter-${info.project.name}-t68@bukalaris.local`;
  runDb(`const id=randomUUID(); await db.insert(user).values({id,email:${JSON.stringify(email)},name:'T68 reporter',emailVerified:true}); await db.insert(account).values({id:randomUUID(),accountId:id,providerId:'credential',userId:id,password:await hashPassword('bukalaris-dev-123')}); await db.insert(platformOperator).values({userId:id}); await grantAsSystem(db,{userId:id,capabilities:['ops.issues.report','tenants.read'],source:'system_bootstrap',reason:'t68 fixture'});`);
  await login(page, email, "/admin"); await page.goto("/admin/stores");
  await expect(page.getByRole("button", { name: "Lapor masalah", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Owner console" }).getByRole("link", { name: "Laporan masalah", exact: true })).toHaveCount(0);
  for (const route of ["/admin/issues", "/admin/issues/1"]) { await page.goto(route); await expect(page.getByRole("heading", { name: "Akses ditolak." })).toBeVisible(); }
  const response = await page.request.get("/admin/issues/export?format=json"); expect(response.status()).toBe(403); expect(response.headers()["cache-control"]).toContain("no-store");
});
