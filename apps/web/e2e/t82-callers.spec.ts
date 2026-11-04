import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { enrolTotpViaApi, login, seedFixtureStore, seedFixtureUser, totp } from "./helpers";

// T-82 refusal proof for the nonstandard original callers (R4 gap 5). Each case sends the caller's real
// form/argument with a forged CSRF value, proves the persisted state is unchanged, then sends the same
// input with the current token as the positive control. Tokens and cookies stay in memory; no trace.
test.use({ trace: "off" });

const stage = (name: string) => console.info(JSON.stringify({ t82Stage: name }));
const FORGED = `v1.${"A".repeat(43)}`;
const sqlUrl = () => {
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !/_e2e\b/.test(url)) throw new Error("E2E_DATABASE_URL must point at a *_e2e database");
  return url;
};

/** Valid tiny PNG so the upload passes content sniffing when accepted. */
function png(): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => (~b.reduce((c, x) => table[(c ^ x) & 0xff]! ^ (c >>> 8), 0xffffffff) >>> 0);
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 4 }, () => [40, 90, 160]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 4 }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

/** Read a native form's current entries without exposing them. */
async function formEntries(page: Page, buttonName: string) {
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: buttonName, exact: true }) }).first();
  return { form, entries: await form.evaluate((el) => Array.from(new FormData(el as HTMLFormElement).entries()).map(([k, v]) => [k, typeof v === "string" ? v : ""] as [string, string])) };
}

/** Post a native multipart Server Action form (JS disabled transport) with an explicit CSRF value. */
async function postForm(ctx: BrowserContext, path: string, origin: string, entries: [string, string][], csrf: string, file?: { name: string; buffer: Buffer }) {
  const body = new FormData();
  for (const [k, v] of entries) if (k !== "_csrf" && k !== "file") body.append(k, v);
  body.append("_csrf", csrf);
  if (file) body.append("file", new Blob([new Uint8Array(file.buffer)], { type: "image/png" }), file.name);
  return ctx.request.post(path, { headers: { origin }, multipart: body, maxRedirects: 0 });
}

test("T82 upload, finance step-up and invitation callers refuse a forged token with no effect; the current token works", async ({ page, browser, baseURL }) => {
  const sql = postgres(sqlUrl(), { max: 1, onnotice: () => {} });
  const origin = new URL(baseURL!).origin;
  const native = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    // Fresh store + owner per project: TOTP enrolment and invitations are permanent state.
    const store = seedFixtureStore("t82call");
    await login(page, store.email);
    await native.addCookies(await page.context().cookies());
    const p = await native.newPage();

    stage("logged-in");
    // --- Multipart upload (uploadMediaAction).
    await page.goto("/seller/products/new");
    await page.getByLabel("Judul produk", { exact: true }).fill("T82 produk");
    await page.getByLabel("Nama varian").fill("M");
    await page.getByLabel("Harga (Rp)").fill("10000");
    await page.getByLabel("Stok").fill("5");
    await page.getByLabel("Berat (gram)").fill("500");
    await page.getByRole("button", { name: "Simpan produk", exact: true }).click();
    await page.waitForURL(/\/seller\/products\/\d+/);
    const productId = Number(/\/seller\/products\/(\d+)/.exec(page.url())![1]);
    const productPath = `/seller/products/${productId}`;
    const mediaCount = async () => Number((await sql`select count(*)::int as n from media where product_id = ${productId}`)[0]!.n);
    await p.goto(productPath);
    const upload = await formEntries(p, "Unggah gambar");
    expect(upload.entries.filter(([k]) => k === "_csrf").length, "upload form carries one token").toBe(1);
    const current = upload.entries.find(([k]) => k === "_csrf")![1];
    const before = await mediaCount();
    await postForm(native, productPath, origin, upload.entries, FORGED, { name: "t82.png", buffer: png() });
    expect(await mediaCount(), "forged upload stores no media").toBe(before);
    await postForm(native, productPath, origin, upload.entries, current, { name: "t82.png", buffer: png() });
    expect(await mediaCount(), "current-token upload stores exactly one media row").toBe(before + 1);

    stage("upload-done");
    // --- Finance step-up (setDestinationAction): forged CSRF must refuse before the code is consumed.
    const secret = await enrolTotpViaApi(page, store.email);
    await native.addCookies(await page.context().cookies());
    const destCount = async () => Number((await sql`select count(*)::int as n from payout_destination d join store s on s.id = d.store_id where s.slug = ${store.slug}`)[0]!.n);
    const proofCount = async () => Number((await sql`select count(*)::int as n from store_step_up_proof p join store s on s.id = p.store_id where s.slug = ${store.slug}`)[0]!.n);
    await p.goto("/seller/finance");
    const finance = await formEntries(p, "Simpan rekening");
    const fin = finance.entries.map(([k, v]) => [k, k === "accountNumber" ? "1234567890" : k === "accountHolderName" ? "Pemilik T82" : k === "code" ? totp(secret, Date.now() + 30_000) : v] as [string, string]);
    for (const [k, v] of [["accountNumber", "1234567890"], ["accountHolderName", "Pemilik T82"], ["code", totp(secret, Date.now() + 30_000)]] as const) if (!fin.some(([n]) => n === k)) fin.push([k, v]);
    const finToken = finance.entries.find(([k]) => k === "_csrf")![1];
    const [d0, p0] = [await destCount(), await proofCount()];
    await postForm(native, "/seller/finance", origin, fin, FORGED);
    expect([await destCount(), await proofCount()], "forged step-up stores no destination and consumes no proof").toEqual([d0, p0]);
    await postForm(native, "/seller/finance", origin, fin, finToken);
    expect(await destCount(), "current-token step-up stores one held destination").toBe(d0 + 1);

    stage("finance-done");
    // --- Invitation accepted by the signed-in invitee (acceptAsCurrentUser).
    // /seller/members has loading.tsx: without JS its streamed content never replaces the fallback
    // (bfbd36f4e: 0 invite buttons). Read the rendered form on the JS-enabled page of the same session;
    // the mutation itself is still posted as the native multipart form below.
    await page.goto("/seller/members");
    await expect(page.getByRole("button", { name: "Kirim undangan", exact: true }), "members page offers invitations").toBeVisible({ timeout: 10_000 });
    const invitee = seedFixtureUser("t82inv");
    const invite = await formEntries(page, "Kirim undangan");
    const inv = invite.entries.map(([k, v]) => [k, k === "email" ? invitee : k === "role" ? "staff" : v] as [string, string]);
    await postForm(native, "/seller/members", origin, inv, invite.entries.find(([k]) => k === "_csrf")![1]);
    const [mail] = await sql<{ text_body: string }[]>`select text_body from mail_outbox where to_email = ${invitee} order by id desc limit 1`;
    expect(Boolean(mail), "invitation mail queued").toBe(true);
    const link = new URL(/https?:\/\/\S+/.exec(mail!.text_body)![0]);
    const memberOfA = async () => Number((await sql`select count(*)::int as n from membership m join store s on s.id = m.store_id join "user" u on u.id = m.user_id where s.slug = ${store.slug} and u.email = ${invitee}`)[0]!.n);
    const b = await browser.newContext({ baseURL });
    const bNative = await browser.newContext({ baseURL, javaScriptEnabled: false });
    try {
      const bp = await b.newPage();
      stage("invitee-login-start");
      await login(bp, invitee);
      stage("invitee-logged-in");
      await bNative.addCookies(await b.cookies());
      const np = await bNative.newPage();
      await np.goto(link.pathname);
      const accept = await formEntries(np, `Gabung ke ${store.name}`);
      const m0 = await memberOfA();
      await postForm(bNative, link.pathname, origin, accept.entries, FORGED);
      expect(await memberOfA(), "forged invitation acceptance adds no membership").toBe(m0);
      await postForm(bNative, link.pathname, origin, accept.entries, accept.entries.find(([k]) => k === "_csrf")![1]);
      expect(await memberOfA(), "current-token acceptance adds exactly one membership").toBe(m0 + 1);
      stage("invite-done");
    } finally { await bNative.close(); await b.close(); }
  } finally { await native.close(); await sql.end(); }
});

// Console fixtures reuse the T-62 pattern: platform pool via a child process, never the app under test.
const DB_CWD = resolve(process.cwd(), "../../packages/db");
function runDb<T = unknown>(body: string): T {
  const script = `
    import { createDb } from "./src/client.ts";
    import { randomUUID } from "node:crypto";
    import { hashPassword } from "better-auth/crypto";
    import { eq } from "drizzle-orm";
    import { account, platformOperator, user } from "./src/schema.ts";
    import { grantAsSystem } from "./src/ops/capabilities-grants.ts";
    import { requestApproval } from "./src/ops/capabilities-approvals.ts";
    import { operatorScope } from "./src/platform/scoped.ts";
    const db = createDb(process.env.E2E_PLATFORM_DATABASE_URL);
    const out = await (async () => { ${body} })();
    await db.$client.end();
    console.log("@@" + JSON.stringify(out ?? null));
  `;
  const stdout = execFileSync("node", ["--input-type=module", "-e", script], { cwd: DB_CWD, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(stdout.slice(stdout.lastIndexOf("@@") + 2)) as T;
}
function seedStaff(email: string, caps: string[]) {
  runDb(`
    if (!(await db.select().from(user).where(eq(user.email, ${JSON.stringify(email)}))).length) {
      const id = randomUUID();
      await db.insert(user).values({ id, email: ${JSON.stringify(email)}, name: ${JSON.stringify(email.split("@")[0])}, emailVerified: true });
      await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword("bukalaris-dev-123") });
      await db.insert(platformOperator).values({ userId: id });
      await grantAsSystem(db, { userId: id, capabilities: ${JSON.stringify(caps)}, source: "system_bootstrap", reason: "e2e fixture t82" });
    }
  `);
}

test("T82 console formAction approval and argument-only issue report refuse a forged token with no effect; the current token works", async ({ page, browser, baseURL }, info) => {
  const sql = postgres(sqlUrl(), { max: 1, onnotice: () => {} });
  const origin = new URL(baseURL!).origin;
  const tag = `${info.project.name}-${Date.now().toString(36)}`.replace(/[^a-z0-9-]/g, "");
  const requester = `t82-req-${tag}@bukalaris.local`;
  const approver = `t82-appr-${tag}@bukalaris.local`;
  seedStaff(requester, ["payouts.process"]);
  seedStaff(approver, ["payouts.process", "ops.issues.report"]);
  const approvalId = runDb<number>(`
    const [r] = await db.select({ id: user.id }).from(user).where(eq(user.email, ${JSON.stringify(requester)}));
    const op = await operatorScope(db, r.id);
    return (await requestApproval(op, { actionKey: "payout.approve_transfer", targetKind: "payout", targetId: ${JSON.stringify(`t82-${tag}`)}, payload: { holder: "Budi", bank: "BCA", destination: "1234567890", amountIdr: 250000 }, reason: "t82 csrf" })).id;
  `);
  const status = async () => String((await sql`select status from approval_request where id = ${approvalId}`)[0]!.status);
  const reports = async () => Number((await sql`select count(*)::int as n from issue_report r join "user" u on u.id = r.reporter_id where u.email = ${approver}`)[0]!.n);
  try {
    await login(page, approver, "/admin");
    stage("console-logged-in");

    // --- formAction per button: capture the hydrated "Setujui" submission, abort it, then replay forged/current.
    await page.goto("/admin/approvals");
    const item = page.getByTestId(`approval-${approvalId}`);
    await item.getByLabel(/Alasan keputusan/).fill("t82 snapshot dicek");
    await page.route((u) => u.pathname === "/admin/approvals", (route) => route.request().method() === "POST" ? route.abort() : route.continue());
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/admin/approvals"),
      item.getByRole("button", { name: "Setujui", exact: true }).click(),
    ]);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect(await status(), "aborted capture decided nothing").toBe("pending");
    const headers = await request.allHeaders();
    const original = (request.postDataBuffer() ?? Buffer.alloc(0)).toString("latin1");
    const current = /name="[^"]*_csrf"\r\n\r\n([^\r]+)\r\n/.exec(original)?.[1];
    expect(typeof current === "string" && current.length > 0, "captured approval body carries the token field").toBe(true);
    const forged = original.replace(current!, FORGED);
    expect(forged !== original, "forged body differs only by its token").toBe(true);
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const replay = (body: string) => page.request.post("/admin/approvals", {
      headers: { origin, cookie, "content-type": headers["content-type"]!, "next-action": headers["next-action"]!, accept: headers.accept ?? "text/x-component" },
      data: Buffer.from(body, "latin1"), maxRedirects: 0,
    });
    await replay(forged);
    expect(await status(), "forged formAction approval leaves the request pending").toBe("pending");
    await replay(original);
    expect(await status(), "identical approval with the current token is decided").toBe("approved");
    stage("approval-done");

    // --- Argument-only issue report. The token is a bound argument that Next encrypts, so tampering the
    // blob would only test Next's decryption. Instead the real component submits a token whose session was
    // replaced after render (stale binding); a reload with the current session is the positive control.
    await page.goto("/admin");
    const r0 = await reports();
    const other = await browser.newContext({ baseURL, storageState: await page.context().storageState() });
    try {
      const tab = await other.newPage();
      await tab.goto("/admin");
      const out = await tab.evaluate(async () => {
        const t = await (await fetch("/api/auth/csrf-token", { cache: "no-store" })).json();
        return (await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json", "x-bl-csrf": t.token }, body: "{}" })).status;
      });
      expect(out, "the rendered page's session was revoked elsewhere").toBe(200);
    } finally { await other.close(); }
    await login(await page.context().newPage(), approver, "/admin"); // a new session in the same browser
    const fileReport = async (description: string) => {
      await page.getByRole("button", { name: "Lapor masalah", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Lapor masalah" });
      await dialog.getByRole("radio").first().check();
      await dialog.getByRole("radio").nth(5).check();
      await dialog.getByLabel("Deskripsi").fill(description);
      await dialog.getByRole("button", { name: "Kirim laporan", exact: true }).click();
      return dialog;
    };
    const stale = await fileReport(`T82 stale ${tag}`);
    await expect(stale.getByRole("alert"), "stale argument-only token is refused with a recoverable message").toBeVisible();
    expect(await reports(), "stale argument-only report files nothing").toBe(r0);
    await page.reload();
    await fileReport(`T82 current ${tag}`);
    await expect(page.getByText(/Laporan #\d+ terkirim/)).toBeVisible();
    expect(await reports(), "current-token report files exactly one").toBe(r0 + 1);
    stage("report-done");
  } finally { await sql.end(); }
});
