// Demo seed (M2 wave 4, track `demo`): a platform operator, four merchants with owner + staff,
// catalog with generated images, collections, CMS pages, ad destinations and a month of orders
// in every status. Local development and presentations only; `seed.ts` (the e2e fixture) is
// untouched and both can live in one database.
//
// Everything that has a service goes through it (same validation, audit rows, outbox jobs and
// RLS context as the UI). Raw SQL is limited to what no service does: creating credential users
// (Better Auth owns sign-up), the staff membership row (as `seed.ts`), back-dating timestamps
// so the orders spread over the last 30 days, and the `--reset` deletion. Runs on the platform
// pool (ADR-0005: seeding is a platform-role job).
//
//   pnpm db:seed:demo            # no-op when demo stores already exist
//   pnpm db:seed:demo --reset    # delete every demo row (marker: store slug `demo-*`, e-mail
//                                # `@demo.bukalaris.local`, log message `demo: …`) and seed again
import { hashPassword } from "better-auth/crypto";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asc, eq, like, sql } from "drizzle-orm";
import { addVariant, createProduct, getProduct } from "../catalog.ts";
import { placeOrder } from "../checkout.ts";
import { platformDb, type Db } from "../client.ts";
import { addProductMedia, createCollection, createPage, updateStoreSettings } from "../content.ts";
import { runOnce } from "../jobs.ts";
import "../notify.ts"; // registers the order e-mail handler
import { transitionOrder, type OrderAction } from "../orders.ts";
import { recordLogEvent } from "../ops.ts";
import { createStore } from "../platform.ts";
import { FAKE_AREAS, fakeProviders } from "../providers.ts";
import { account, cart, membership, operatorGrant, order, orderStatusHistory, platformOperator, stockAdjustment, store, systemLog, user, type OrderStatus } from "../schema.ts";
import { operatorScope, sellerContext, storefrontScope, type SellerScope } from "../scoped.ts";
import { setPickupAddress, setPickupArea } from "../shipping.ts";
import { saveDestination } from "../signals.ts"; // also registers the signal.deliver handler
import { setCartLine } from "../storefront.ts";
import { DEMO_ADMIN, DEMO_BUYERS, DEMO_EMAIL_DOMAIN, DEMO_PASSWORD, DEMO_SLUG_PREFIX, DEMO_STORES, demoPages, INCOMPLETE_ADDRESS_BUYER, NO_COD_AREA_INDEX, type DemoStore } from "./data.ts";
import { initialsOf, placeholderPng } from "./png.ts";

export type SeedDemoOptions = {
  /** Delete existing demo rows first instead of skipping. */
  reset?: boolean;
  /** Where generated images go; defaults to the web app's `MEDIA_DIR` resolution (relative to apps/web). */
  mediaDir?: string;
  /** Pixel size of the generated images (640 for dev, smaller in tests). */
  imageSize?: number;
  /** Subset of `DEMO_STORES` to seed (tests use one to stay fast). */
  stores?: DemoStore[];
  log?: (line: string) => void;
};
export type SeedDemoCounts = {
  stores: number;
  users: number;
  products: number;
  variants: number;
  media: number;
  collections: number;
  pages: number;
  orders: number;
  statuses: OrderStatus[];
  jobsDone: number;
  jobsFailed: number;
  signalEvents: number;
  mails: number;
  logs: number;
};
export type SeedDemoResult = { skipped: boolean; counts: SeedDemoCounts; mediaDir: string };

type Rows<T> = T[];
const rows = <T>(r: unknown) => r as Rows<T>;

/** Deterministic PRNG (mulberry32) so a re-seed produces the same shape of data. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, xs: readonly T[]) => xs[Math.floor(rng() * xs.length)]!;
const between = (rng: () => number, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));

const WIB_MS = 7 * 3_600_000;
/** `daysAgo` days before today at `hour:minute` Asia/Jakarta, never later than two minutes ago. */
function wib(daysAgo: number, hour: number, minute: number, now = Date.now()): Date {
  const local = new Date(now + WIB_MS); // UTC fields now read as WIB wall-clock
  const t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysAgo, hour, minute) - WIB_MS;
  return new Date(Math.min(t, now - 120_000));
}
const plusHours = (d: Date, h: number, now = Date.now()) => new Date(Math.min(d.getTime() + h * 3_600_000, now - 60_000));

// ── Order plan: what each store ends up with (16 orders, every status at least once) ───
type Target = OrderStatus | "rejected";
const ORDER_PLAN: { target: Target; pay: "cod" | "transfer" | "mix"; days: [number, number] }[] = [
  { target: "completed", pay: "mix", days: [8, 29] },
  { target: "completed", pay: "cod", days: [8, 29] },
  { target: "completed", pay: "transfer", days: [8, 29] },
  { target: "completed", pay: "mix", days: [6, 20] },
  { target: "completed", pay: "cod", days: [6, 14] },
  { target: "shipped", pay: "cod", days: [2, 6] },
  { target: "shipped", pay: "transfer", days: [2, 5] },
  { target: "processing", pay: "mix", days: [1, 3] },
  { target: "placed", pay: "cod", days: [0, 2] },
  { target: "placed", pay: "transfer", days: [0, 2] },
  { target: "awaiting_confirmation", pay: "cod", days: [0, 1] },
  { target: "awaiting_confirmation", pay: "cod", days: [0, 0] },
  { target: "on_hold", pay: "cod", days: [0, 2] },
  { target: "rejected", pay: "cod", days: [3, 20] },
  { target: "cancelled", pay: "transfer", days: [3, 20] },
  { target: "awaiting_payment", pay: "transfer", days: [0, 1] },
];
const COD_STEPS: Record<Target, OrderAction[]> = {
  awaiting_confirmation: [],
  on_hold: ["hold"],
  placed: ["confirm"],
  processing: ["confirm", "process"],
  shipped: ["confirm", "process", "ship"],
  completed: ["confirm", "process", "ship", "complete"],
  rejected: ["hold", "reject"],
  cancelled: ["confirm", "cancel"],
  awaiting_payment: [],
};
const TRANSFER_STEPS: Record<Target, OrderAction[]> = {
  awaiting_payment: [],
  placed: ["pay"],
  processing: ["pay", "process"],
  shipped: ["pay", "process", "ship"],
  completed: ["pay", "process", "ship", "complete"],
  cancelled: ["cancel"],
  rejected: ["cancel"],
  awaiting_confirmation: [],
  on_hold: [],
};
const COD_ONLY = new Set<Target>(["awaiting_confirmation", "on_hold", "rejected"]);
const REASONS: Record<string, string[]> = {
  hold: ["Nomor HP belum bisa dihubungi, dicoba lagi besok pagi.", "Pembeli minta dikirim minggu depan, ditahan dulu."],
  reject: ["Pembeli membatalkan lewat WhatsApp sebelum dikirim.", "Nomor tidak aktif setelah tiga kali dihubungi."],
  cancel: ["Pembayaran tidak masuk setelah 2 hari.", "Pembeli ganti pesanan, dibuat ulang dengan varian lain."],
};

// ── Reset ──────────────────────────────────────────────────────────────────────────────
const isFkViolation = (err: unknown) => (err as { cause?: { code?: string } })?.cause?.code === "23503";

/** Delete demo rows: every table with `store_id` for the demo stores (FK-ordered by retrying), then stores, users, mails, logs and image files. */
async function resetDemo(db: Db, storeIds: number[], mediaRoot: string, log: (s: string) => void) {
  const ids = sql.join(storeIds.map((id) => sql`${id}`), sql`, `);
  const demoUsers = sql`select id from "user" where email like ${`%@${DEMO_EMAIL_DOMAIN}`}`;
  let pending = rows<{ table_name: string }>(
    await db.execute(sql`select distinct table_name from information_schema.columns where table_schema = 'public' and column_name = 'store_id'`),
  ).map((r) => r.table_name);
  // Per-cart checkout counters (T-30) are keyed by cart id, not store: clear them while the carts still exist.
  await db.execute(sql`delete from rate_limit where key in (select 'order:cart:' || id from cart where store_id in (${ids}))`);
  // No ownership-free order is known up front (tracks add tables): delete what the FKs allow, retry the rest.
  for (let pass = 0; pending.length > 0 && pass < 12; pass++) {
    const blocked: string[] = [];
    for (const t of pending) {
      try {
        await db.execute(sql`delete from ${sql.identifier(t)} where store_id in (${ids})`);
      } catch (err) {
        if (!isFkViolation(err)) throw err;
        blocked.push(t);
      }
    }
    pending = blocked;
  }
  if (pending.length > 0) throw new Error(`seed-demo: reset could not clear ${pending.join(", ")}`);
  await db.execute(sql`delete from audit_log where actor_user_id in (${demoUsers})`);
  await db.execute(sql`delete from store where id in (${ids})`);
  await db.execute(sql`delete from "user" where email like ${`%@${DEMO_EMAIL_DOMAIN}`}`); // account/session/operator rows cascade
  await db.execute(sql`delete from mail_outbox where to_email like ${`%@${DEMO_EMAIL_DOMAIN}`}`);
  await db.execute(sql`delete from system_log where message like ${"demo: %"}`);
  for (const id of storeIds) await rm(join(mediaRoot, String(id)), { recursive: true, force: true });
  log(`reset: removed demo stores ${storeIds.join(", ")} and their rows`);
}

// ── Seed ───────────────────────────────────────────────────────────────────────────────
const APPS_WEB = fileURLToPath(new URL("../../../../apps/web/", import.meta.url));

export async function seedDemo(db: Db, opts: SeedDemoOptions = {}): Promise<SeedDemoResult> {
  const log = opts.log ?? (() => {});
  if (process.env.NODE_ENV === "production") throw new Error("seed-demo: refused, NODE_ENV=production");
  // Local only: every configured host must be loopback or a Unix socket (a production database is
  // never reached that way), the database a bukalaris* one, and never the disposable e2e database.
  const hosts: (string | undefined)[] = [db.$client.options.host].flat();
  const remote = hosts.filter((h) => h && !h.startsWith("/") && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(h));
  if (remote.length > 0) throw new Error(`seed-demo: refused, database host ${remote.join(", ")} is not local`);
  const [{ name }] = rows<{ name: string }>(await db.execute(sql`select current_database() as name`));
  if (!name.startsWith("bukalaris")) throw new Error(`seed-demo: refused, database "${name}" is not a local bukalaris* database`);
  if (name.endsWith("_e2e")) throw new Error(`seed-demo: refused, "${name}" is the e2e database (its fixtures must stay exactly seed.ts)`);
  // Same resolution as apps/web/src/lib/media.ts, anchored at apps/web (the dev server's cwd).
  const mediaRoot = opts.mediaDir ?? resolve(APPS_WEB, process.env.MEDIA_DIR ?? "var/media");
  const imageSize = opts.imageSize ?? 640;
  const stores = opts.stores ?? DEMO_STORES;

  const existing = await db.select({ id: store.id }).from(store).where(like(store.slug, `${DEMO_SLUG_PREFIX}%`));
  // The demo log events are written last: without them (or with fewer stores) an earlier run
  // stopped half-way, so the partial rows are rebuilt instead of being reported as "done".
  const complete =
    existing.length === stores.length && (await db.select({ id: systemLog.id }).from(systemLog).where(like(systemLog.message, "demo: %")).limit(1)).length > 0;
  if (existing.length > 0) {
    if (complete && !opts.reset) {
      log(`seed-demo: ${existing.length} demo stores already exist, nothing to do (use --reset to rebuild)`);
      return { skipped: true, counts: await counts(db), mediaDir: mediaRoot };
    }
    await resetDemo(db, existing.map((s) => s.id), mediaRoot, log);
  }
  // Checkout counts orders per buyer phone (T-30); the demo phones are a fixed test range, so a
  // re-seed inside the 10-minute window would otherwise be refused. Dev-only counters, no service.
  await db.execute(sql`delete from rate_limit where key like ${"order:phone:08120000%"}`);
  const tokens = !!process.env.INTEGRATION_TOKEN_KEY;
  if (!tokens) log("seed-demo: INTEGRATION_TOKEN_KEY is not set; ad destinations get no server token (browser pixel only, no simulated delivery)");

  // Users: Better Auth owns sign-up; a credential user is a `user` + `account` row (as in seed.ts).
  const hash = await hashPassword(DEMO_PASSWORD);
  async function makeUser(email: string, name: string) {
    const id = randomUUID();
    await db.insert(user).values({ id, email, name, emailVerified: true });
    await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash });
    return id;
  }
  const scopeOf = async (userId: string, storeId: number): Promise<SellerScope> => {
    const ctx = await sellerContext(db, userId, storeId);
    if (!ctx.ok) throw new Error(`seed-demo: no seller scope (${ctx.reason})`);
    return ctx.scope;
  };
  const persist = async (key: string, bytes: Uint8Array) => {
    const p = join(mediaRoot, key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes); // overwrite: a dropped database may leave files of the same ids behind
  };

  const adminId = await makeUser(DEMO_ADMIN.email, DEMO_ADMIN.name);
  await db.insert(platformOperator).values({ userId: adminId });
  await db.insert(operatorGrant).values({ userId: adminId, capability: "logs.read" });
  const op = (await operatorScope(db, adminId))!;

  const phoneUse = new Map<string, number>(); // checkout rate limit: 10 orders per phone per 10 minutes
  let storeIndex = 0;
  for (const s of stores) {
    const rng = prng(1000 + storeIndex++);
    const ownerId = await makeUser(s.owner.email, s.owner.name);
    const staffId = await makeUser(s.staff.email, s.staff.name);
    const storeId = await createStore(op, { slug: s.slug, name: s.name, ownerUserId: ownerId });
    await db.insert(membership).values({ storeId, userId: staffId, role: "staff" }); // invitations are an e-mail flow; seed.ts does the same
    const owner = await scopeOf(ownerId, storeId);
    const staff = await scopeOf(staffId, storeId);
    await updateStoreSettings(owner, { name: s.name, description: s.description, whatsapp: s.whatsapp, theme: s.theme });
    await setPickupArea(owner, { areaId: s.pickup.areaId, areaLabel: s.pickup.areaLabel });
    await setPickupAddress(owner, { addressText: s.pickup.addressText });

    // Catalog with images (none for drafts; two angles for the first three products).
    const catalog: { productId: number; variantIds: number[]; prices: number[]; stocks: number[]; active: boolean; tags: string[] }[] = [];
    for (const [i, p] of s.products.entries()) {
      const [first, ...rest] = p.variants;
      const productId = await createProduct(owner, { title: p.title, slug: p.slug, description: p.description, status: p.draft ? "draft" : "active", variant: first! });
      for (const v of rest) await addVariant(owner, productId, v);
      const variants = (await getProduct(owner, productId))!.variants;
      catalog.push({ productId, variantIds: variants.map((v) => v.id), prices: variants.map((v) => v.price), stocks: variants.map((v) => v.stock), active: !p.draft, tags: p.tags });
      if (p.draft) continue;
      for (let k = 0; k < (i < 3 ? 2 : 1); k++) {
        const bytes = placeholderPng({ hue: s.hue + i * 9, initials: initialsOf(p.title), size: imageSize, flip: k === 1 });
        await addProductMedia(owner, productId, bytes, k === 0 ? p.title : `${p.title} (tampak lain)`, (key) => persist(key, bytes));
      }
    }
    for (const c of s.collections) {
      const productIds = catalog.filter((p) => p.active && p.tags.includes(c.key)).map((p) => p.productId);
      await createCollection(owner, { title: c.title, slug: c.slug, description: c.description, status: c.status ?? "published", productIds });
    }
    for (const pg of demoPages(s)) await createPage(owner, { ...pg, status: "published" });
    if (s.signals) {
      const token = (provider: string) => (tokens ? `demo-${provider}-token-not-real` : undefined);
      if (s.signals.meta) await saveDestination(owner, "meta", { pixelId: s.signals.meta, token: token("meta"), testEventCode: "TEST_DEMO", enabled: true });
      if (s.signals.tiktok) await saveDestination(owner, "tiktok", { pixelId: s.signals.tiktok, token: token("tiktok"), testEventCode: "TEST_DEMO", enabled: true });
      if (s.signals.google) await saveDestination(owner, "google", { pixelId: s.signals.google.tagId, conversionLabel: s.signals.google.label, enabled: true });
    }

    // Orders through the storefront cart + hosted checkout, then seller transitions, then back-dating.
    const sf = (await storefrontScope(db, s.slug))!;
    const sellable = catalog.filter((p) => p.active);
    // Placed oldest first, so order numbers (the list's newest-first sort) follow the back-dated times.
    const planned = ORDER_PLAN.map((plan, n) => ({ plan, n, createdAt: wib(between(rng, plan.days[0], plan.days[1]), between(rng, 8, 20), between(rng, 0, 59)) }));
    planned.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const { plan, n, createdAt } of planned) {
      // Buyer: the repeat buyer (index 0) on the first pending COD order and the rejected one (risk
      // signal "repeat cancelled"), the incomplete address on the second pending one; others random.
      let buyer = plan.target === "rejected" || (plan.target === "awaiting_confirmation" && n === 10) ? DEMO_BUYERS[0]! : plan.target === "awaiting_confirmation" ? DEMO_BUYERS[INCOMPLETE_ADDRESS_BUYER]! : pick(rng, DEMO_BUYERS.slice(1, INCOMPLETE_ADDRESS_BUYER));
      while ((phoneUse.get(buyer.phone) ?? 0) >= 9) buyer = pick(rng, DEMO_BUYERS.slice(1, INCOMPLETE_ADDRESS_BUYER));
      let isCod = plan.pay === "cod" || (plan.pay === "mix" && rng() < 0.6);
      if (buyer.areaIndex === NO_COD_AREA_INDEX) {
        // No courier offers COD there: pay by transfer, or swap the buyer when the target state is COD-only.
        if (COD_ONLY.has(plan.target)) buyer = DEMO_BUYERS[1]!;
        else isCod = false;
      }
      phoneUse.set(buyer.phone, (phoneUse.get(buyer.phone) ?? 0) + 1);

      // 1–3 lines from variants that still have stock (checkout decrements; cancellations restock later).
      let lines = between(rng, 1, 3);
      let cartId: string | undefined;
      for (const p of [...sellable].sort(() => rng() - 0.5)) {
        const vi = between(rng, 0, p.variantIds.length - 1);
        const qty = Math.min(p.stocks[vi]!, p.prices[vi]! < 60_000 ? between(rng, 1, 3) : between(rng, 1, 2));
        if (qty < 1) continue;
        p.stocks[vi]! -= qty;
        cartId = await setCartLine(sf, cartId, { variantId: p.variantIds[vi], quantity: qty }, "add");
        if (--lines === 0) break;
      }
      const area = FAKE_AREAS[buyer.areaIndex]!;
      const courier = isCod || rng() < 0.5 ? "JNE" : "SiCepat";
      const { orderId } = await placeOrder(
        db,
        cartId,
        {
          idempotencyKey: randomUUID(),
          buyerName: buyer.name,
          buyerPhone: buyer.phone,
          buyerEmail: buyer.email,
          shippingAddress: buyer.address,
          destinationAreaId: area.id,
          destinationAreaLabel: area.label,
          courier,
          paymentMethod: isCod ? "cod" : "manual_transfer",
        },
        fakeProviders,
      );

      const steps = (isCod ? COD_STEPS : TRANSFER_STEPS)[plan.target];
      let at = createdAt;
      const stepTimes: { action: OrderAction; at: Date }[] = [];
      for (const action of steps) {
        const actor = action === "confirm" || action === "pay" || action === "reject" || action === "cancel" ? owner : rng() < 0.5 ? owner : staff;
        const input =
          action === "ship"
            ? { trackingNumber: `DEMO-${courier.toUpperCase()}-${String(between(rng, 10_000_000, 99_999_999))}` }
            : REASONS[action]
              ? { reason: pick(rng, REASONS[action]!) }
              : {};
        await transitionOrder(actor, orderId, action, input);
        at = plusHours(at, between(rng, 1, 18) + rng());
        stepTimes.push({ action, at });
      }
      await backdate(db, orderId, cartId!, createdAt, stepTimes);
    }
    log(`seed-demo: ${s.name} (${s.slug}) ready — ${catalog.length} products, ${ORDER_PLAN.length} orders`);
  }

  // Settle the outbox like the worker would: payment references, e-mails (dev outbox), simulated ad signals.
  let jobsDone = 0;
  let jobsFailed = 0;
  for (;;) {
    const out = await runOnce(db, { workerId: "seed-demo", batch: 100, providers: fakeProviders });
    if (out.length === 0) break;
    for (const o of out) {
      if (o.status === "done") jobsDone++;
      else {
        jobsFailed++;
        log(`seed-demo: job ${o.id} (${o.kind}) ${o.status}: ${o.error ?? ""}`);
      }
    }
  }
  await demoLogs(db);
  const c = await counts(db);
  log(`seed-demo: done — ${c.stores} stores, ${c.users} users, ${c.products} products, ${c.media} images, ${c.orders} orders (${c.statuses.length} statuses), ${jobsDone} jobs settled${jobsFailed ? `, ${jobsFailed} failed` : ""}`);
  return { skipped: false, counts: { ...c, jobsDone, jobsFailed }, mediaDir: mediaRoot };
}

/** Spread one order over time: created_at, each history row, confirmed/paid markers, restock rows and the cart. No service owns timestamps. */
async function backdate(db: Db, orderId: number, cartId: string, createdAt: Date, steps: { action: OrderAction; at: Date }[]) {
  const last = steps.at(-1)?.at ?? createdAt;
  const confirmedAt = steps.find((s) => s.action === "confirm")?.at ?? null;
  const paidAt = steps.find((s) => s.action === "pay")?.at ?? null;
  await db.update(order).set({ createdAt, updatedAt: last, ...(confirmedAt ? { confirmedAt } : {}), ...(paidAt ? { paidAt } : {}) }).where(eq(order.id, orderId));
  await db.update(cart).set({ createdAt: new Date(createdAt.getTime() - 7 * 60_000) }).where(eq(cart.id, cartId));
  const history = await db.select({ id: orderStatusHistory.id }).from(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId)).orderBy(asc(orderStatusHistory.id));
  for (const [i, h] of history.entries()) {
    const at = steps[i]?.at ?? last;
    await db.update(orderStatusHistory).set({ createdAt: at }).where(eq(orderStatusHistory.id, h.id));
  }
  const restock = steps.find((s) => s.action === "reject" || s.action === "cancel");
  if (restock) await db.update(stockAdjustment).set({ createdAt: restock.at }).where(eq(stockAdjustment.orderId, orderId));
}

/** A handful of warn/error events in the last hour so the Log System has something to show. Messages start with `demo: ` (reset marker). */
async function demoLogs(db: Db) {
  const demoStores = await db.select({ id: store.id }).from(store).where(like(store.slug, `${DEMO_SLUG_PREFIX}%`)).orderBy(asc(store.id));
  const sid = (i: number) => demoStores[i % demoStores.length]?.id;
  const now = Date.now();
  const events: Parameters<typeof recordLogEvent>[1][] = [
    { level: "warn", message: "demo: ongkir provider lambat, memakai percobaan ulang", module: "checkout", time: new Date(now - 52 * 60_000), fields: { operation: "shippingOptions", provider: "mengantar", duration_ms: 4120, store_id: sid(0), route: "/checkout" } },
    { level: "error", message: "demo: stok tidak cukup saat checkout", module: "checkout", time: new Date(now - 47 * 60_000), fields: { operation: "placeOrder", code: "out_of_stock", store_id: sid(1), route: "/checkout" } },
    { level: "warn", message: "demo: percobaan masuk melebihi batas", module: "auth", time: new Date(now - 41 * 60_000), fields: { operation: "signIn", code: "rate_limited", route: "/login", status: 429 } },
    { level: "error", message: "demo: halaman produk gagal dirender", module: "storefront.catalog", time: new Date(now - 33 * 60_000), fields: { operation: "render", error_name: "TypeError", digest: "demo-1a2b3c", store_id: sid(2), route: "/s/[store]/products/[slug]", status: 500 } },
    { level: "warn", message: "demo: job outbox dicoba ulang", module: "worker", time: new Date(now - 26 * 60_000), fields: { operation: "signal.deliver", outcome: "retry", store_id: sid(0) } },
    { level: "warn", message: "demo: handoff checkout kedaluwarsa", module: "checkout", time: new Date(now - 18 * 60_000), fields: { operation: "consumeHandoff", code: "expired", store_id: sid(3), route: "/checkout/h/[token]" } },
    { level: "error", message: "demo: gambar produk tidak ditemukan di MEDIA_DIR", module: "storefront.catalog", time: new Date(now - 11 * 60_000), fields: { operation: "readMedia", code: "ENOENT", store_id: sid(1), route: "/s/[store]/media/[id]", status: 404 } },
    { level: "warn", message: "demo: permintaan API etalase tanpa token channel", module: "api.storefront", time: new Date(now - 4 * 60_000), fields: { operation: "authenticate", code: "unauthorized", status: 401, route: "/api/storefront/v1/products" } },
  ];
  for (const e of events) await recordLogEvent(db, e);
}

async function counts(db: Db): Promise<SeedDemoCounts> {
  const [c] = rows<Record<string, string | null>>(
    await db.execute(sql`
      with s as (select id from store where slug like ${`${DEMO_SLUG_PREFIX}%`})
      select
        (select count(*) from s) as stores,
        (select count(*) from "user" where email like ${`%@${DEMO_EMAIL_DOMAIN}`}) as users,
        (select count(*) from product where store_id in (select id from s)) as products,
        (select count(*) from variant where store_id in (select id from s)) as variants,
        (select count(*) from media where store_id in (select id from s)) as media,
        (select count(*) from collection where store_id in (select id from s)) as collections,
        (select count(*) from page where store_id in (select id from s)) as pages,
        (select count(*) from "order" where store_id in (select id from s)) as orders,
        (select string_agg(distinct status, ',') from "order" where store_id in (select id from s)) as statuses,
        (select count(*) from job where store_id in (select id from s) and status = 'done') as jobs_done,
        (select count(*) from job where store_id in (select id from s) and status <> 'done') as jobs_failed,
        (select count(*) from signal_event where store_id in (select id from s)) as signal_events,
        (select count(*) from mail_outbox where to_email like ${`%@${DEMO_EMAIL_DOMAIN}`}) as mails,
        (select count(*) from system_log where message like ${"demo: %"}) as logs
    `),
  );
  const n = (k: string) => Number(c![k] ?? 0);
  return {
    stores: n("stores"),
    users: n("users"),
    products: n("products"),
    variants: n("variants"),
    media: n("media"),
    collections: n("collections"),
    pages: n("pages"),
    orders: n("orders"),
    statuses: (c!.statuses ? c!.statuses.split(",") : []) as OrderStatus[],
    jobsDone: n("jobs_done"),
    jobsFailed: n("jobs_failed"),
    signalEvents: n("signal_events"),
    mails: n("mails"),
    logs: n("logs"),
  };
}

// ── CLI: `node src/demo/seed-demo.ts [--reset]` (package script `seed:demo`) ──────────
if (process.argv[1] && /seed-demo\.ts$/.test(process.argv[1])) {
  const db = platformDb();
  try {
    const r = await seedDemo(db, { reset: process.argv.includes("--reset"), log: console.log });
    const { statuses, ...c } = r.counts;
    console.log(`seed-demo: rows ${JSON.stringify(c)} statuses=${statuses.length}`);
    if (!r.skipped) {
      console.log(`seed-demo: images in ${r.mediaDir}`);
      console.log(`seed-demo: logins (password "${DEMO_PASSWORD}"): ${DEMO_ADMIN.email}, ${DEMO_STORES.map((s) => `${s.owner.email}, ${s.staff.email}`).join(", ")}`);
    }
  } finally {
    await db.$client.end();
  }
}
