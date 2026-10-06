import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { cartStore, openCartStore } from "./checkout.ts";
import { platformDb, type Executor } from "./client.ts";
import { auditLog, cart, cartLine, checkoutHandoff, store, storefrontChannel } from "./schema.ts";
import { DomainError, requireCap, storefrontScope, type SellerScope, type StorefrontScope } from "./scoped.ts";
import { inStore, withStore } from "./tenant.ts";

// Headless storefront channels (SC-21, PR-16, IAM-11) and the one-use checkout
// handoff (ARCH-7, API-8). The private token is shown once at creation; only its
// SHA-256 hash is stored and verification compares hashes in constant time.
// Rotation = create a replacement channel, deploy, revoke the old one (IAM-11).

export const HANDOFF_TTL_MS = 10 * 60 * 1000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// blsk_<8 char prefix>_<43 char secret> (6 + 32 random bytes, base64url).
const TOKEN_RE = /^blsk_([A-Za-z0-9_-]{8})_[A-Za-z0-9_-]{43}$/;

function issueToken() {
  const prefix = randomBytes(6).toString("base64url");
  const token = `blsk_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { token, prefix, hash: sha256(token) };
}

const localhost = (h: string) => h === "localhost" || h === "127.0.0.1" || h.endsWith(".localhost");

export const channelInput = z.strictObject({
  name: z.string().trim().min(1, "Nama wajib diisi.").max(100),
  origin: z
    .string()
    .trim()
    .transform((raw, ctx) => {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        ctx.addIssue({ code: "custom", message: "Origin harus URL lengkap, mis. https://toko.example." });
        return z.NEVER;
      }
      const devHttp = u.protocol === "http:" && localhost(u.hostname);
      if (u.protocol !== "https:" && !devHttp) ctx.addIssue({ code: "custom", message: "Origin harus https:// (http hanya untuk localhost)." });
      if (u.username || u.password || u.pathname !== "/" || u.search || u.hash)
        ctx.addIssue({ code: "custom", message: "Origin hanya skema dan host, tanpa path." });
      return u.origin;
    }),
  // Local path only: a leading "//" or a scheme would make it an absolute URL.
  returnPath: z
    .string()
    .optional()
    .transform((v) => v?.trim() || "/")
    .pipe(z.string().max(500).regex(/^\/(?!\/)[^\s\\]*$/, "Path kembali harus diawali satu '/'.")),
  expiresAt: z
    .union([z.literal(""), z.null(), z.coerce.date()])
    .optional()
    .transform((v) => (v instanceof Date ? v : null))
    .refine((d) => !d || d.getTime() > Date.now(), "Kedaluwarsa harus di masa depan."),
});
export type ChannelInput = z.input<typeof channelInput>;

const channelColumns = {
  id: storefrontChannel.id,
  name: storefrontChannel.name,
  origin: storefrontChannel.origin,
  returnPath: storefrontChannel.returnPath,
  tokenPrefix: storefrontChannel.tokenPrefix,
  status: storefrontChannel.status,
  expiresAt: storefrontChannel.expiresAt,
  revokedAt: storefrontChannel.revokedAt,
  createdAt: storefrontChannel.createdAt,
};

const isLive = (c: { status: string; expiresAt: Date | null }) =>
  c.status === "active" && (!c.expiresAt || c.expiresAt.getTime() > Date.now());

export async function listChannels(scope: SellerScope) {
  requireCap(scope, "integrations.manage");
  return inStore(scope, async (scope) => {
    const rows = await scope.exec
      .select(channelColumns)
      .from(storefrontChannel)
      .where(eq(storefrontChannel.storeId, scope.storeId))
      .orderBy(desc(storefrontChannel.id));
    return rows.map((c) => ({ ...c, state: c.status === "revoked" ? "revoked" : isLive(c) ? "active" : "expired" }) as const);
  });
}

/** Create a channel and return its private token exactly once (never stored, never logged). */
export async function createChannel(scope: SellerScope, raw: unknown) {
  requireCap(scope, "integrations.manage");
  const input = channelInput.parse(raw);
  const { token, prefix, hash } = issueToken();
  return inStore(scope, async ({ exec: tx }) => {
    const [c] = await tx
      .insert(storefrontChannel)
      .values({ ...input, storeId: scope.storeId, tokenPrefix: prefix, tokenHash: hash, createdBy: scope.userId })
      .returning({ id: storefrontChannel.id });
    await tx.insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: `channel.create:${c!.id}` });
    return { id: c!.id, token, prefix };
  });
}

/** Revoke a channel: new API calls and unused handoffs are denied immediately. */
export async function revokeChannel(scope: SellerScope, channelId: number): Promise<void> {
  requireCap(scope, "integrations.manage");
  await inStore(scope, async ({ exec: tx }) => {
    const [c] = await tx
      .update(storefrontChannel)
      .set({ status: "revoked", revokedAt: sql`now()` })
      .where(and(eq(storefrontChannel.storeId, scope.storeId), eq(storefrontChannel.id, channelId), eq(storefrontChannel.status, "active")))
      .returning({ id: storefrontChannel.id });
    if (!c) throw new DomainError("not_found", "Channel tidak ditemukan atau sudah dicabut.");
    await tx.insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: `channel.revoke:${channelId}` });
  });
}

export type ChannelAuth =
  | { ok: true; scope: StorefrontScope; channel: { id: number; origin: string; returnPath: string } }
  | { ok: false; reason: "unauthorized" | "store_unavailable" };

/**
 * Resolve the store from an `Authorization: Bearer <token>` header. The channel
 * alone determines the store; a client-supplied store id or host is never used.
 */
export async function authenticateChannel(exec: Executor, authorization: string | null | undefined): Promise<ChannelAuth> {
  const deny: ChannelAuth = { ok: false, reason: "unauthorized" };
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const prefix = token?.match(TOKEN_RE)?.[1];
  if (!token || !prefix) return deny;
  const given = Buffer.from(sha256(token));
  // Cross-store resolver (ADR-0005 §4): token prefix → candidate hashes and their store, through the
  // platform pool; the channel row itself is then read in that store's context.
  const candidates = await platformDb()
    .select({ storeId: storefrontChannel.storeId, tokenHash: storefrontChannel.tokenHash })
    .from(storefrontChannel)
    .where(eq(storefrontChannel.tokenPrefix, prefix));
  const hit = candidates.find((row) => timingSafeEqual(given, Buffer.from(row.tokenHash)));
  if (!hit) return deny;
  const [c] = await withStore(exec, hit.storeId, (tx) =>
    tx
      .select({ ...channelColumns, storeSlug: store.slug })
      .from(storefrontChannel)
      .innerJoin(store, eq(store.id, storefrontChannel.storeId))
      .where(and(eq(storefrontChannel.storeId, hit.storeId), eq(storefrontChannel.tokenHash, hit.tokenHash))),
  );
  if (!c || !isLive(c)) return deny;
  const scope = await storefrontScope(exec, c.storeSlug);
  if (!scope) return { ok: false, reason: "store_unavailable" };
  return { ok: true, scope, channel: { id: c.id, origin: c.origin, returnPath: c.returnPath } };
}

/** An empty cart for this store (an external backend usually creates the cart before the first item). */
export async function createEmptyCart(scope: StorefrontScope): Promise<string> {
  return inStore(scope, async (scope) => {
    const [c] = await scope.exec.insert(cart).values({ storeId: scope.storeId }).returning({ id: cart.id });
    return c!.id;
  });
}

/** True only for an open (not checked out) cart that belongs to this store. */
export async function ownsOpenCart(scope: StorefrontScope, cartId: string | undefined): Promise<boolean> {
  return inStore(scope, async (scope) => {
    return (await openCartStore(scope.exec, cartId)) === scope.storeId;
  });
}

/** Issue a one-use handoff code for a non-empty open cart of the channel's store. */
export async function createHandoff(scope: StorefrontScope, channelId: number, cartId: string) {
  return inStore(scope, async (scope) => {
    if (!(await ownsOpenCart(scope, cartId))) throw new DomainError("not_found", "Keranjang tidak ditemukan.");
    const [{ n }] = (await scope.exec
      .select({ n: count() })
      .from(cartLine)
      .where(and(eq(cartLine.storeId, scope.storeId), eq(cartLine.cartId, cartId)))) as [{ n: number }];
    if (n === 0) throw new DomainError("empty", "Keranjang kosong.");
    const code = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);
    const [h] = await scope.exec
      .insert(checkoutHandoff)
      .values({ storeId: scope.storeId, cartId, channelId, codeHash: sha256(code), expiresAt })
      .returning({ id: checkoutHandoff.id });
    return { id: h!.id, code, expiresAt };
  });
}

/**
 * Consume a handoff code exactly once (atomic UPDATE … WHERE consumed_at IS NULL).
 * Returns the cart to bind to the buyer's per-store cookie, or null when the code
 * is unknown, expired, replayed, the channel is revoked/expired, the store is not
 * active or the cart was already checked out.
 */
export async function exchangeHandoff(exec: Executor, code: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
  const codeHash = sha256(code);
  // Cross-store resolver (ADR-0005 §4): code → store id through the platform pool; the one-use
  // consume and every check then run atomically in that store's context.
  const [owner] = await platformDb().select({ storeId: checkoutHandoff.storeId }).from(checkoutHandoff).where(eq(checkoutHandoff.codeHash, codeHash));
  if (!owner) return null;
  return withStore(exec, owner.storeId, async (tx) => {
    const [h] = await tx
      .update(checkoutHandoff)
      .set({ consumedAt: sql`now()` })
      .where(and(eq(checkoutHandoff.codeHash, codeHash), isNull(checkoutHandoff.consumedAt), sql`${checkoutHandoff.expiresAt} > now()`))
      .returning({ storeId: checkoutHandoff.storeId, cartId: checkoutHandoff.cartId, channelId: checkoutHandoff.channelId });
    if (!h) return null;
    const [c] = await tx
      .select({ status: storefrontChannel.status, expiresAt: storefrontChannel.expiresAt, storeSlug: store.slug })
      .from(storefrontChannel)
      .innerJoin(store, eq(store.id, storefrontChannel.storeId))
      .where(and(eq(storefrontChannel.storeId, h.storeId), eq(storefrontChannel.id, h.channelId)));
    if (!c || !isLive(c)) return null;
    const scope = await storefrontScope(exec, c.storeSlug);
    if (!scope || !(await ownsOpenCart({ ...scope, exec: tx }, h.cartId))) return null;
    return { storeId: scope.storeId, storeSlug: scope.storeSlug, cartId: h.cartId };
  });
}

/**
 * Registered return destination for a buyer who arrived through a handoff: the
 * channel's stored origin + return path (allowlist), only while the channel is live.
 */
export async function channelReturnTarget(exec: Executor, cartId: string | undefined): Promise<string | null> {
  const storeId = await cartStore(cartId);
  if (!storeId) return null;
  const [row] = await withStore(exec, storeId, (tx) =>
    tx
      .select({ origin: storefrontChannel.origin, returnPath: storefrontChannel.returnPath, status: storefrontChannel.status, expiresAt: storefrontChannel.expiresAt })
      .from(checkoutHandoff)
      .innerJoin(
        storefrontChannel,
        and(eq(storefrontChannel.storeId, checkoutHandoff.storeId), eq(storefrontChannel.id, checkoutHandoff.channelId)),
      )
      .where(and(eq(checkoutHandoff.cartId, cartId!), isNotNull(checkoutHandoff.consumedAt)))
      .orderBy(desc(checkoutHandoff.consumedAt))
      .limit(1),
  );
  return row && isLive(row) ? `${row.origin}${row.returnPath}` : null;
}
