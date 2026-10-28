// SA-23 account search and SA-24 diagnostic view for seller team members (T-63 slice 3 and 4).
// Masking happens here, in the data layer, before any DTO is built: HTML, RSC, JSON and exports all carry the masked values.
// A staff identity (platform_operator row) never appears and is never a target (IAM-15, PRIV-9 (j)). The raw query is never
// stored or logged: the audit row carries a keyed fingerprint only, and the rate limit counts attempts without query text.
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client.ts";
import { accountStatusEvent, supportAction, supportCase } from "./schema-governance.ts";
import { auditLog, membership, platformOperator, session, store, user } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { requirePlatformCap } from "./capabilities.ts";
import { withPersonalDataAccess, PURPOSES_BY_CAPABILITY } from "./console-access.ts";
import { activeRevealedFields } from "./accounts-governance-reveal.ts";
import { canonicalPhone, maskEmail, maskName, queryFingerprint, requireAccountTarget, requireOpenCase } from "./accounts-governance.ts";

export type AccountKind = "seller" | "affiliate" | "buyer";
export type CanonicalQuery = { kind: "email"; value: string } | { kind: "phone"; value: string } | { kind: "id"; value: string };

export interface MaskedHit {
  kind: AccountKind;
  /** The internal reference of the account (never a contact). */
  id: string;
  maskedName: string;
  maskedEmail: string;
  status: "active" | "suspended";
  memberships: number;
}
export interface AccountDiagnostics {
  kind: AccountKind;
  id: string;
  maskedName: string;
  maskedEmail: string;
  emailVerified: boolean;
  status: "active" | "suspended";
  suspendedAt: Date | null;
  mfaEnrolled: boolean;
  activeSessions: number;
  /** Newest live session creation time; sessions that were signed out or revoked leave no trace, so this is "newest known session", not an audit of sign-ins. */
  lastSessionAt: Date | null;
  /** True when any membership is `owner`: a store-owner account (its MFA reset is four-eyes). */
  storeOwner: boolean;
  memberships: { storeId: number; storeName: string; storeSlug: string; storeStatus: string; role: string }[];
  openCases: { id: number; caseNumber: string; title: string; status: string }[];
  history: { id: number; fromStatus: string | null; toStatus: string; reasonCode: string; createdAt: Date }[];
  actions: { id: number; actionKind: string; status: string; resultCode: string | null; approvalRequestId: number | null; createdAt: Date }[];
  /** Fields whose reveal window is still open for THIS staff member; empty once the window ends (masked again). */
  revealed: { field: "email" | "name"; value: string; expiresAt: Date }[];
}

/**
 * The masked projection interface of an account kind (T-63 slice 3). The seller team member kind is implemented here; the
 * affiliate and buyer kinds plug into the same interface in T-72 (affiliate through its context, buyer through the ADR-0010 resolver).
 */
export interface AccountProjection {
  kind: AccountKind;
  find(tx: Tx, query: CanonicalQuery): Promise<MaskedHit[]>;
  diagnose(tx: Tx, id: string): Promise<Omit<AccountDiagnostics, "revealed"> | null>;
}
const status = (suspendedAt: Date | null) => (suspendedAt ? ("suspended" as const) : ("active" as const));
const notStaff = sql`not exists (select 1 from ${platformOperator} o where o.user_id = ${user.id})`;
const isSeller = sql`exists (select 1 from ${membership} m where m.user_id = ${user.id})`;

export const sellerProjection: AccountProjection = {
  kind: "seller",
  async find(tx, q) {
    // Seller team accounts carry an e-mail only; a phone query is accepted and canonicalized but has nothing to match until a verified phone exists.
    if (q.kind === "phone") return [];
    const rows = await tx
      .select({ id: user.id, name: user.name, email: user.email, suspendedAt: user.suspendedAt, memberships: sql<number>`(select count(*)::int from ${membership} m where m.user_id = ${user.id})` })
      .from(user)
      .where(and(q.kind === "email" ? sql`lower(${user.email}) = ${q.value}` : eq(user.id, q.value), notStaff, isSeller))
      .limit(5);
    return rows.map((r) => ({ kind: "seller" as const, id: r.id, maskedName: maskName(r.name), maskedEmail: maskEmail(r.email), status: status(r.suspendedAt), memberships: r.memberships }));
  },
  async diagnose(tx, id) {
    const [u] = await tx.select({ id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified, twoFactorEnabled: user.twoFactorEnabled, suspendedAt: user.suspendedAt }).from(user).where(and(eq(user.id, id), notStaff));
    if (!u) return null;
    const [members, sessions, openCases, history, actions] = await Promise.all([
      tx.select({ storeId: store.id, storeName: store.name, storeSlug: store.slug, storeStatus: store.status, role: membership.role }).from(membership).innerJoin(store, eq(store.id, membership.storeId)).where(eq(membership.userId, id)).orderBy(store.id),
      tx.select({ active: sql<number>`count(*) filter (where ${session.expiresAt} > now())::int`, newest: sql<Date | string | null>`max(${session.createdAt}) filter (where ${session.expiresAt} > now())` }).from(session).where(eq(session.userId, id)),
      tx.select({ id: supportCase.id, caseNumber: supportCase.caseNumber, title: supportCase.title, status: supportCase.status }).from(supportCase).where(and(eq(supportCase.subjectKind, "user"), eq(supportCase.subjectId, id), sql`${supportCase.status} in ('open', 'in_progress', 'waiting')`)).orderBy(desc(supportCase.id)).limit(10),
      tx.select({ id: accountStatusEvent.id, fromStatus: accountStatusEvent.fromStatus, toStatus: accountStatusEvent.toStatus, reasonCode: accountStatusEvent.reasonCode, createdAt: accountStatusEvent.createdAt }).from(accountStatusEvent).where(and(eq(accountStatusEvent.subjectKind, "user"), eq(accountStatusEvent.subjectId, id))).orderBy(desc(accountStatusEvent.id)).limit(20),
      tx.select({ id: supportAction.id, actionKind: supportAction.actionKind, status: supportAction.status, resultCode: supportAction.resultCode, approvalRequestId: supportAction.approvalRequestId, createdAt: supportAction.createdAt }).from(supportAction).where(and(eq(supportAction.subjectKind, "user"), eq(supportAction.subjectId, id))).orderBy(desc(supportAction.id)).limit(20),
    ]);
    const s = sessions[0]!;
    return {
      kind: "seller",
      id: u.id,
      maskedName: maskName(u.name),
      maskedEmail: maskEmail(u.email),
      emailVerified: u.emailVerified,
      status: status(u.suspendedAt),
      suspendedAt: u.suspendedAt,
      mfaEnrolled: u.twoFactorEnabled,
      activeSessions: s.active,
      lastSessionAt: s.newest ? new Date(s.newest) : null,
      storeOwner: members.some((m) => m.role === "owner"),
      memberships: members,
      openCases: openCases.map((c) => ({ ...c, caseNumber: c.caseNumber! })),
      history,
      actions,
    };
  },
};
/** Kind registry: T-72 adds `affiliate` and `buyer`. A kind without an entry is not-found, never an empty result. */
export const ACCOUNT_PROJECTIONS: Partial<Record<AccountKind, AccountProjection>> = { seller: sellerProjection };

/** Canonical form of a staff query: an e-mail (any case or spacing), a mobile number (`08…`, `62…`, `+62…`) or an internal id. */
export function canonicalizeQuery(raw: string): CanonicalQuery | null {
  const q = raw.normalize("NFKC").trim();
  if (q.length < 3 || q.length > 254) return null;
  if (q.includes("@")) {
    const email = q.replace(/\s+/g, "").toLowerCase();
    return z.email().safeParse(email).success ? { kind: "email", value: email } : null;
  }
  const phone = canonicalPhone(q);
  if (phone) return { kind: "phone", value: phone };
  return /^[A-Za-z0-9_-]{8,64}$/.test(q) ? { kind: "id", value: q } : null;
}

/** RL-ACCT-SEARCH: per staff member, counted from the audit rows of this action (no query text exists in them). Named defaults, D-22 item 3. */
export const searchLimit = (env: NodeJS.ProcessEnv = process.env) => ({ max: Math.max(1, Number(env.ACCOUNT_SEARCH_LIMIT) || 30), windowMs: Math.max(1, Number(env.ACCOUNT_SEARCH_WINDOW_SECONDS) || 600) * 1000 });

export interface AccountSearchResult {
  hits: MaskedHit[];
  /** Buyer results need an open case and a purpose on the search itself, whether or not any buyer matches (and none exists before T-72). */
  buyerResults: "needs_case_and_purpose" | "not_available";
}
const searchInput = z.strictObject({ query: z.string().max(512), buyer: z.strictObject({ caseRef: z.unknown(), purposeCode: z.string().max(64) }).optional() });

export async function searchAccounts(op: OperatorScope, raw: unknown, env: NodeJS.ProcessEnv = process.env): Promise<AccountSearchResult> {
  await requirePlatformCap(op, "accounts.read");
  const i = searchInput.parse(raw);
  const canon = canonicalizeQuery(i.query);
  if (!canon) throw new DomainError("query_invalid", "Masukkan email, nomor ponsel, atau ID akun (minimal 3 karakter).");
  const fp = queryFingerprint(`${canon.kind}:${canon.value}`, env);
  // The attempt is counted first, in its own transaction under a per-staff lock, so concurrent searches cannot slip past the limit.
  const { max, windowMs } = searchLimit(env);
  const allowed = await op.exec.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`account.search:${op.userId}`}, 0))`);
    const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(and(eq(auditLog.actorUserId, op.userId), eq(auditLog.action, "account.search"), sql`${auditLog.createdAt} > now() - make_interval(secs => ${windowMs / 1000})`))) as [{ n: number }];
    const ok = n < max;
    await tx.insert(auditLog).values({ actorUserId: op.userId, actorCapability: "accounts.read", action: "account.search", subjectKind: "account_search", subjectId: fp ?? "unkeyed", accessLevel: "masked", outcome: ok ? "allowed" : "denied", reason: ok ? `kind:${canon.kind}` : "rate_limited" });
    return ok;
  });
  if (!allowed) throw new DomainError("rate_limited", "Terlalu banyak pencarian. Coba lagi beberapa menit lagi.");
  let buyerResults: AccountSearchResult["buyerResults"] = "needs_case_and_purpose";
  if (i.buyer) {
    const purposes = PURPOSES_BY_CAPABILITY["accounts.read"] ?? [];
    if (!purposes.includes(i.buyer.purposeCode)) throw new DomainError("purpose_not_allowed", "Tujuan ini tidak diizinkan.");
    await op.exec.transaction((tx) => requireOpenCase(tx, i.buyer!.caseRef));
    buyerResults = "not_available";
  }
  const hits = await withPersonalDataAccess(op, { capability: "accounts.read", targetKind: "account_search", targetId: fp ?? "unkeyed", fieldClass: "email", purposeCode: "support_case", reason: "pencarian akun", accessLevel: "masked" }, async (tx) => {
    const found = await Promise.all(Object.values(ACCOUNT_PROJECTIONS).map((p) => p!.find(tx, canon)));
    return found.flat();
  });
  return { hits, buyerResults };
}

/** The masked diagnostic view of one account (accounts.read). The read is a recorded masked access; revealed fields appear only inside the staff member's own open window. */
export async function accountDiagnostics(op: OperatorScope, kind: string, id: string): Promise<AccountDiagnostics> {
  await requirePlatformCap(op, "accounts.read");
  const projection = ACCOUNT_PROJECTIONS[kind as AccountKind];
  if (!projection || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new DomainError("not_found", "Akun tidak ditemukan.");
  await requireAccountTarget(op, id, "accounts.read");
  const view = await withPersonalDataAccess(op, { capability: "accounts.read", targetKind: "user", targetId: id, fieldClass: "email", purposeCode: "support_case", reason: "tampilan diagnostik akun", accessLevel: "masked" }, (tx) => projection.diagnose(tx, id));
  if (!view) throw new DomainError("not_found", "Akun tidak ditemukan.");
  return { ...view, revealed: await activeRevealedFields(op, id) };
}
