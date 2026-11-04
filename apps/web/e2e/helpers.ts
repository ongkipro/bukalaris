import { expect, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Playwright runs from apps/web (pnpm e2e).
const dir = resolve(process.cwd(), "../../docs/evidence/m1") + "/";
mkdirSync(dir, { recursive: true });

export const DEV_PASSWORD = "bukalaris-dev-123";

/** Hosted checkout step 1 (T-34): search the destination area through the fake adapter and pick it (no JS needed). */
export async function chooseDestination(page: Page, keyword = "menteng", pick: RegExp = /^Pilih Menteng/) {
  await page.getByLabel(/Cari kelurahan/).fill(keyword);
  await page.getByRole("button", { name: "Cari area" }).click();
  await page.getByRole("link", { name: pick }).click();
  await expect(page.getByTestId("destination-area")).toBeVisible();
}

/** Full-page screenshot into docs/evidence/m1 plus a no-horizontal-scroll check (NFR-3 reflow). */
// CSP guard (T-29): every evidence step also asserts that the page raised no CSP
// violation, so a component that needs a blocked inline style/script fails loudly on
// whichever page uses it, not only on the pages the security-headers spec visits.
const cspWatched = new WeakSet<Page>();
const recordCsp = () => {
  const w = window as unknown as { __blCsp?: string[] };
  if (w.__blCsp) return;
  w.__blCsp = [];
  document.addEventListener("securitypolicyviolation", (e) => w.__blCsp!.push(`${e.violatedDirective} ${e.blockedURI}`));
};
async function watchCsp(page: Page) {
  if (cspWatched.has(page)) return;
  cspWatched.add(page);
  await page.addInitScript(recordCsp); // every later document
  await page.evaluate(recordCsp); // the current one
}

export async function evidence(page: Page, info: TestInfo, step: string) {
  await watchCsp(page);
  const violations = await page.evaluate(() => (window as unknown as { __blCsp?: string[] }).__blCsp ?? []);
  expect(violations, `${step}: CSP violations`).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${step}: horizontal overflow`).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${dir}${info.project.name}-${step}.png`, fullPage: true });
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 6 digits, 30 s) for the operator MFA flow — no dependency.
// ---------------------------------------------------------------------------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, "")) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error(`bad base32 char ${ch}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secretBase32: string, now = Date.now(), period = 30, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const h = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(code % 10 ** digits).padStart(digits, "0");
}

/** Secrets enrolled during this run, shared across spec files and projects (test-results is wiped per run). */
const secretsFile = resolve(process.cwd(), "test-results/totp-secrets.json");
export function totpSecrets(): Record<string, string> {
  return existsSync(secretsFile) ? (JSON.parse(readFileSync(secretsFile, "utf8")) as Record<string, string>) : {};
}
export function saveTotpSecret(email: string, secret: string) {
  mkdirSync(resolve(secretsFile, ".."), { recursive: true });
  writeFileSync(secretsFile, JSON.stringify({ ...totpSecrets(), [email]: secret }));
}

/** Resolve the current surface binding without logging the token or caching across session replacement. */
export async function authHeaders(page: Page): Promise<Record<string, string>> {
  const origin = new URL(page.url()).origin;
  const issued = await page.request.get(`${origin}/api/auth/csrf-token`);
  expect(issued.status(), "CSRF issuance status").toBe(200);
  const body = await issued.json() as { token?: unknown };
  if (typeof body.token !== "string") throw new Error("Expected a current CSRF binding");
  return { origin, "x-bl-csrf": body.token };
}

/** Enrol TOTP through the HTTP routes for an already signed-in page (fallback when a spec needs an enrolled operator). */
export async function enrolTotpViaApi(page: Page, email: string, password = DEV_PASSWORD) {
  // page.request has its own baseURL; use the actual page surface, including host-mode.
  const origin = new URL(page.url()).origin;
  const enable = await page.request.post(`${origin}/api/auth/two-factor/enable`, { headers: await authHeaders(page), data: { password, method: "totp" } });
  expect(enable.ok(), `two-factor/enable ${enable.status()}`).toBeTruthy();
  const { totpURI } = (await enable.json()) as { totpURI: string };
  const secret = new URL(totpURI).searchParams.get("secret")!;
  const verify = await page.request.post(`${origin}/api/auth/two-factor/verify-totp`, { headers: await authHeaders(page), data: { code: totp(secret) } });
  expect(verify.ok(), `two-factor/verify-totp ${verify.status()}`).toBeTruthy();
  saveTotpSecret(email, secret);
  return secret;
}

/**
 * Sign in through the real form. Handles Better Auth's production rate limit
 * (3 sign-ins / 10 s per IP) by waiting out a 429, the two-factor step for users
 * enrolled during this run, and the operator MFA gate (enrols via API if needed).
 */
export async function login(page: Page, email: string, next: "/seller" | "/admin" = "/seller", password = DEV_PASSWORD) {
  const landing = next === "/seller" ? "/seller/products" : "/admin";
  for (let attempt = 0; attempt < 4; attempt++) {
    // T-41: /seller is the dashboard now, so seller specs land on the products page explicitly.
    await page.goto(`/login?next=${landing}`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Kata sandi").fill(password);
    await page.getByRole("button", { name: "Masuk" }).click();
    const outcome = await Promise.race([
      page.waitForURL((u) => u.pathname === landing).then(() => "ok" as const),
      page.waitForURL((u) => u.pathname === "/account/security").then(() => "enrol" as const),
      page.getByText("Terlalu banyak percobaan").waitFor().then(() => "429" as const),
      page.getByLabel("Kode autentikator").waitFor().then(() => "totp" as const),
    ]);
    if (outcome === "ok") return;
    if (outcome === "enrol") {
      await enrolTotpViaApi(page, email, password);
      await page.goto(landing);
      await page.waitForURL((u) => u.pathname === landing);
      return;
    }
    if (outcome === "totp") {
      const secret = totpSecrets()[email];
      if (!secret) throw new Error(`${email} has TOTP enabled but no secret was recorded in this run`);
      await submitTotp(page, secret);
      await page.waitForURL((u) => u.pathname === landing);
      return;
    }
    await page.waitForTimeout(11_000);
  }
  throw new Error("login kept being rate limited");
}

/** Fill the TOTP step; /two-factor/* is limited to 3 requests / 10 s, so a 429 is waited out once. */
export async function submitTotp(page: Page, secret: string) {
  // Role textbox: the backup-code list shown after success is also labelled "Kode …".
  const code = page.getByRole("textbox", { name: /Kode/ });
  for (let attempt = 0; attempt < 3; attempt++) {
    await code.fill(totp(secret));
    await page.getByRole("button", { name: /Verifikasi/ }).click();
    const outcome = await Promise.race([
      page.getByText("Terlalu banyak percobaan").waitFor().then(() => "429" as const),
      code.waitFor({ state: "detached" }).then(() => "ok" as const),
    ]);
    if (outcome === "ok") return;
    await page.waitForTimeout(11_000);
  }
  throw new Error("TOTP verification kept being rate limited");
}

/**
 * A fresh Indonesian mobile number per call. Checkout rate-limits orders per phone
 * (T-30: 10 per 10 minutes), so specs must not share one buyer number; reuse a value
 * explicitly only when a test is about repeat-phone behaviour.
 */
let phoneSeq = 0;
export function testPhone(): string {
  const n = (Date.now() % 1e6) * 100 + (phoneSeq++ % 100) + process.pid % 7;
  return `0812${String(n).padStart(8, "0").slice(-8)}`;
}

// ---------------------------------------------------------------------------
// Disposable fixture owners (T-82). Specs that change persistent auth state (TOTP enrolment, memberships)
// must not reuse the shared seed users: a later project in the same run would inherit that state.
// Same pattern as t37.spec: the platform pool through a child process, never the application under test.
// ---------------------------------------------------------------------------
const FIXTURE_DB_CWD = resolve(process.cwd(), "../../packages/db");
function fixtureDb<T>(body: string): T {
  const script = `
    import { createDb } from "./src/client.ts";
    import { randomUUID } from "node:crypto";
    import { hashPassword } from "better-auth/crypto";
    import { account, user } from "./src/schema.ts";
    import { createStore } from "./src/platform/platform.ts";
    import { operatorScope } from "./src/platform/scoped.ts";
    const db = createDb(process.env.E2E_PLATFORM_DATABASE_URL);
    const admin = createDb(process.env.E2E_DATABASE_URL);
    const out = await (async () => { ${body} })();
    await db.$client.end();
    await admin.$client.end();
    console.log("@@" + JSON.stringify(out ?? null));
  `;
  const stdout = execFileSync("node", ["--input-type=module", "-e", script], { cwd: FIXTURE_DB_CWD, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(stdout.slice(stdout.lastIndexOf("@@") + 2)) as T;
}

const fixtureTag = () => `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

/** A user with the dev password and no membership. */
export function seedFixtureUser(prefix: string): string {
  const email = `${prefix}-${fixtureTag()}@bukalaris.local`;
  fixtureDb(`
    const id = randomUUID();
    await db.insert(user).values({ id, email: ${JSON.stringify(email)}, name: ${JSON.stringify(prefix)}, emailVerified: true });
    await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword(${JSON.stringify(DEV_PASSWORD)}) });
  `);
  return email;
}

/** A fresh store (trial, writable) with its own owner, created through createStore like an operator would. */
export function seedFixtureStore(prefix: string): { email: string; slug: string; name: string } {
  const slug = `${prefix}-${fixtureTag()}`;
  const email = `${slug}@bukalaris.local`;
  fixtureDb(`
    const adminUser = (await admin.$client.unsafe("select id from \\"user\\" where email = 'admin@bukalaris.local'"))[0].id;
    const op = await operatorScope(db, adminUser);
    const id = randomUUID();
    await db.insert(user).values({ id, email: ${JSON.stringify(email)}, name: ${JSON.stringify(`Pemilik ${slug}`)}, emailVerified: true });
    await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword(${JSON.stringify(DEV_PASSWORD)}) });
    return await createStore(op, { slug: ${JSON.stringify(slug)}, name: ${JSON.stringify(`Toko ${slug}`)}, ownerUserId: id });
  `);
  return { email, slug, name: `Toko ${slug}` };
}
