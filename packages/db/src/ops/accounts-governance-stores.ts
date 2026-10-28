// SA-03 store history, SA-16 optional verification record, SA-18 risk queue (T-63 slice 2).
// Startup relaxation (ADR-0011 section 5): the verification record is informational. Nothing references `account_verification`,
// so no state of it can block store creation, approval, activation, billing or payout; a test proves that by catalog and by use.
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { store } from "../schema.ts";
import { accountStatusEvent, accountVerification, storeRiskAck, supportCase } from "./schema-governance.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { pgCode, requirePlatformCap } from "./capabilities.ts";
import { withPersonalDataAccess } from "./console-access.ts";
import { canonicalPhone, governed, maskEmail, maskName, maskPhone, reasonCode, reasonText, requireOpenCase } from "./accounts-governance.ts";
import { scrubText } from "./ops.ts";
import { REVEAL_WINDOW_SECONDS } from "./accounts-governance-reveal.ts";

/** Status history of a store, newest first (append-only `account_status_event`; every transition has exactly one row). */
export async function storeStatusHistory(op: OperatorScope, storeId: number) {
  await requirePlatformCap(op, "tenants.read");
  return op.exec
    .select({ id: accountStatusEvent.id, fromStatus: accountStatusEvent.fromStatus, toStatus: accountStatusEvent.toStatus, reasonCode: accountStatusEvent.reasonCode, reasonNote: accountStatusEvent.reasonNote, actorUserId: accountStatusEvent.actorUserId, caseId: accountStatusEvent.caseId, createdAt: accountStatusEvent.createdAt })
    .from(accountStatusEvent)
    .where(and(eq(accountStatusEvent.subjectKind, "store"), eq(accountStatusEvent.subjectId, String(storeId))))
    .orderBy(desc(accountStatusEvent.id))
    .limit(50);
}

// ── SA-16 verification record ───────────────────────────────────────────────────────────────────────────────────────────
const KINDS = ["identity", "business"] as const;
const submitInput = z.strictObject({
  kind: z.enum(KINDS),
  verifiedName: z.string().trim().min(1).max(200).optional(),
  contactEmail: z.string().trim().toLowerCase().email("Email kontak tidak valid.").max(254).optional(),
  contactPhone: z.string().trim().max(32).optional(),
  registrationNumber: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9./ -]+$/, "Nomor registrasi tidak valid.").optional(),
  evidenceRef: z.string().trim().regex(/^[A-Za-z0-9_.:/-]{1,120}$/, "Referensi bukti hanya boleh berisi huruf, angka, dan _ . : / -").optional(),
  expiresAt: z.date().optional(),
  reasonCode: reasonCode.default("verification_submitted"),
  reason: reasonText,
});

/**
 * Add a new immutable version of the store's verification record (tenants.verify). Optional by design: nothing requires it. The
 * version number is allocated under an advisory lock per store and kind, and the unique `(subject, kind, version)` index backs it.
 */
export async function submitVerification(op: OperatorScope, storeId: number, raw: unknown): Promise<{ id: number; version: number }> {
  const i = submitInput.parse(raw);
  const phone = i.contactPhone ? canonicalPhone(i.contactPhone) : null;
  if (i.contactPhone && !phone) throw new DomainError("invalid", "Nomor telepon kontak tidak valid.");
  return governed(op, { capability: "tenants.verify", action: "verification.submit", subjectKind: "store", subjectId: String(storeId), storeId, reasonCode: i.reasonCode, reason: i.reason }, async (tx) => {
    const [s] = await tx.select({ id: store.id }).from(store).where(eq(store.id, storeId));
    if (!s) throw new DomainError("not_found", "Toko tidak ditemukan.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`verification:store:${storeId}:${i.kind}`}, 0))`);
    const [{ v }] = (await tx.select({ v: sql<number>`coalesce(max(${accountVerification.version}), 0)::int` }).from(accountVerification).where(and(eq(accountVerification.subjectKind, "store"), eq(accountVerification.subjectId, storeId), eq(accountVerification.kind, i.kind)))) as [{ v: number }];
    const [row] = await tx
      .insert(accountVerification)
      .values({ subjectKind: "store", subjectId: storeId, kind: i.kind, version: v + 1, status: "submitted", submittedBy: op.userId, evidenceRef: i.evidenceRef ?? null, verifiedName: i.verifiedName ?? null, contactEmail: i.contactEmail ?? null, contactPhone: phone, registrationNumber: i.registrationNumber ?? null, expiresAt: i.expiresAt ?? null })
      .returning({ id: accountVerification.id, version: accountVerification.version });
    return row!;
  });
}

/** Staff decision on a version (tenants.verify): submitted -> in_review -> verified | rejected; a verified version can be revoked. One current `verified` version per kind. */
export async function reviewVerification(op: OperatorScope, versionId: number, raw: unknown): Promise<void> {
  const i = z.strictObject({ to: z.enum(["in_review", "verified", "rejected", "revoked"]), reasonCode, reason: reasonText }).parse(raw);
  await governed(op, { capability: "tenants.verify", action: "verification.review", subjectKind: "verification", subjectId: String(versionId), reasonCode: i.reasonCode, reason: i.reason }, async (tx) => {
    const [v] = await tx.select().from(accountVerification).where(eq(accountVerification.id, versionId)).for("update");
    if (!v) throw new DomainError("not_found", "Versi verifikasi tidak ditemukan.");
    if (i.to === "verified") {
      // Superseding: the previous current version of this kind is revoked first, so the partial unique index never refuses a legitimate decision.
      await tx
        .update(accountVerification)
        .set({ status: "revoked", reviewerUserId: op.userId, decidedAt: sql`now()` as unknown as Date, decisionReasonCode: "superseded" })
        .where(and(eq(accountVerification.subjectKind, v.subjectKind), eq(accountVerification.subjectId, v.subjectId), eq(accountVerification.kind, v.kind), eq(accountVerification.status, "verified")));
    }
    try {
      const moved = await tx
        .update(accountVerification)
        .set({ status: i.to, reviewerUserId: op.userId, ...(i.to === "in_review" ? {} : { decidedAt: sql`now()` as unknown as Date, decisionReasonCode: i.reasonCode }) })
        .where(and(eq(accountVerification.id, versionId), eq(accountVerification.status, v.status)))
        .returning({ id: accountVerification.id });
      if (moved.length === 0) throw new DomainError("conflict", "Status versi verifikasi sudah berubah.");
    } catch (err) {
      if (pgCode(err) === "23514") throw new DomainError("illegal_transition", `Versi ini tidak dapat dipindah dari ${v.status} ke ${i.to}.`);
      throw err;
    }
  });
}

export interface VerificationView {
  id: number;
  kind: string;
  version: number;
  status: string;
  submittedAt: Date;
  reviewerUserId: string | null;
  decidedAt: Date | null;
  decisionReasonCode: string | null;
  expiresAt: Date | null;
  evidenceRef: string | null;
  maskedName: string | null;
  maskedEmail: string | null;
  maskedPhone: string | null;
  hasRegistrationNumber: boolean;
}
/** All versions of the store's record, newest first, with masked contact. The masked read is recorded (PRIV-9). */
export async function listVerifications(op: OperatorScope, storeId: number): Promise<VerificationView[]> {
  return withPersonalDataAccess(op, { capability: "tenants.verify", targetKind: "store", targetId: String(storeId), fieldClass: "verification_evidence", purposeCode: "verification_review", reason: "daftar versi verifikasi toko", accessLevel: "masked" }, async (tx) => {
    const rows = await tx.select().from(accountVerification).where(and(eq(accountVerification.subjectKind, "store"), eq(accountVerification.subjectId, storeId))).orderBy(desc(accountVerification.id));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      version: r.version,
      status: r.status,
      submittedAt: r.submittedAt,
      reviewerUserId: r.reviewerUserId,
      decidedAt: r.decidedAt,
      decisionReasonCode: r.decisionReasonCode,
      expiresAt: r.expiresAt,
      evidenceRef: r.evidenceRef,
      maskedName: r.verifiedName ? maskName(r.verifiedName) : null,
      maskedEmail: r.contactEmail ? maskEmail(r.contactEmail) : null,
      maskedPhone: r.contactPhone ? maskPhone(r.contactPhone) : null,
      hasRegistrationNumber: r.registrationNumber !== null,
    }));
  });
}

const FIELD_CLASS = { verifiedName: "name", contactEmail: "email", contactPhone: "phone" } as const;
/**
 * Reveal one protected field of a verification version (accounts.reveal, purpose `verification_review`, an open case, a reason): the
 * evidence row commits in the same transaction before the value is returned, and the value is valid for the reveal window only.
 */
export async function revealVerificationField(op: OperatorScope, versionId: number, raw: unknown, env: NodeJS.ProcessEnv = process.env): Promise<{ field: string; value: string; expiresAt: Date }> {
  const i = z.strictObject({ field: z.enum(["verifiedName", "contactEmail", "contactPhone"]), caseRef: z.unknown(), reason: reasonText }).parse(raw);
  const caseRow = await op.exec.transaction((tx) => requireOpenCase(tx, i.caseRef));
  const expiresAt = new Date(Date.now() + REVEAL_WINDOW_SECONDS(env) * 1000);
  const value = await withPersonalDataAccess(op, { capability: "accounts.reveal", targetKind: "verification", targetId: String(versionId), fieldClass: FIELD_CLASS[i.field], purposeCode: "verification_review", caseId: caseRow.caseNumber, reason: i.reason, accessLevel: "full", expiresAt }, async (tx) => {
    const [r] = await tx.select().from(accountVerification).where(eq(accountVerification.id, versionId));
    const v = r?.[i.field] ?? null;
    if (!v) throw new DomainError("not_found", "Nilai tidak tersedia.");
    return v;
  });
  return { field: i.field, value, expiresAt };
}

/**
 * Fields of this store's verification versions that THIS staff member revealed and whose window is still open (each in-window read is a `full`
 * access event bound to the original case and purpose). Anything else, or an ended window, is absent: the page shows the mask.
 */
export async function activeVerificationReveals(op: OperatorScope, storeId: number): Promise<{ versionId: number; field: keyof typeof FIELD_CLASS; value: string; expiresAt: Date }[]> {
  const versions = await op.exec.select({ id: accountVerification.id }).from(accountVerification).where(and(eq(accountVerification.subjectKind, "store"), eq(accountVerification.subjectId, storeId))).orderBy(desc(accountVerification.id)).limit(10);
  const out: { versionId: number; field: keyof typeof FIELD_CLASS; value: string; expiresAt: Date }[] = [];
  for (const v of versions) {
    for (const field of Object.keys(FIELD_CLASS) as (keyof typeof FIELD_CLASS)[]) {
      const [w] = (await op.exec.execute(sql`select case_id, purpose_code, expires_at from public.console_active_reveal(${op.userId}, 'verification', ${String(v.id)}, ${FIELD_CLASS[field]})`)) as unknown as { case_id: string | null; purpose_code: string; expires_at: Date | string }[];
      if (!w?.case_id) continue;
      try {
        const value = await withPersonalDataAccess(op, { capability: "accounts.reveal", targetKind: "verification", targetId: String(v.id), fieldClass: FIELD_CLASS[field], purposeCode: w.purpose_code, caseId: w.case_id, reason: "pengungkapan masih dalam jendela waktunya", accessLevel: "full", expiresAt: new Date(w.expires_at) }, async (tx) => {
          const [r] = await tx.select().from(accountVerification).where(eq(accountVerification.id, v.id));
          return r?.[field] ?? null;
        });
        if (value) out.push({ versionId: v.id, field, value, expiresAt: new Date(w.expires_at) });
      } catch (err) {
        if (!(err instanceof DomainError)) throw err; // authority lost: masked again
      }
    }
  }
  return out;
}

// ── SA-18 risk queue ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Flags are derived at read time from authoritative state, each with its source and rule (UX-22). A rule whose source does not exist yet
 * is listed as unavailable and never counts as zero. Thresholds are named defaults, not owner decisions (D-22 item 3): any count
 * above zero raises a flag; no age or ratio is invented.
 */
export const RISK_RULES = [
  { key: "shipment_awaiting_balance", source: "shipment.status = awaiting_balance", rule: "Pengiriman menunggu saldo ongkir", owner: "shipping.manage", available: true },
  { key: "shipment_problem", source: "shipment.status in (problem, failed)", rule: "Pengiriman bermasalah atau gagal dipesan", owner: "shipping.manage", available: true },
  { key: "payment_unknown", source: "payment_attempt.status = unknown", rule: "Pembayaran berstatus tidak pasti (menunggu verifikasi)", owner: "finance.read", available: true },
  { key: "late_payment_open", source: "late_payment_obligation.status = open", rule: "Pembayaran terlambat; pengembalian dana ke pembeli terutang", owner: "refunds.process", available: true },
  { key: "subscription_past_due", source: "subscription state (T-50)", rule: "Langganan lewat jatuh tempo atau masa tenggang habis", owner: "billing.read", available: false },
  { key: "shipping_account_unusable", source: "Partner shipping account state (T-48)", rule: "Akun pengiriman perlu kunci atau dinonaktifkan; pesanan menunggu akun", owner: "shipping.manage", available: false },
  { key: "payout_age", source: "payout and refund queue (T-37)", rule: "Pencairan atau pengembalian lebih tua dari batas yang diterima", owner: "payouts.process", available: false },
  { key: "affiliate_fraud", source: "affiliate counters (T-52)", rule: "Indikator penipuan afiliasi", owner: "affiliate.accounts.review", available: false },
] as const;

export interface RiskFlag {
  storeId: number;
  storeName: string;
  storeSlug: string;
  key: string;
  count: number;
  oldestAt: Date | null;
  acknowledged: { until: Date } | null;
}
export interface RiskQueue {
  asOf: Date;
  flags: RiskFlag[];
  /** Acknowledged flags are hidden by default; their number is always reported. */
  hiddenAcknowledged: number;
  unavailableRules: { key: string; rule: string; source: string }[];
  rules: typeof RISK_RULES;
}
export async function riskQueue(op: OperatorScope, raw: unknown = {}): Promise<RiskQueue> {
  await requirePlatformCap(op, "tenants.read");
  const f = z.object({ showAcknowledged: z.boolean().default(false) }).parse(raw);
  const rows = (await op.exec.execute(sql`
    select s.id as store_id, s.name as store_name, s.slug as store_slug, r.key, r.count::int as count, r.oldest as oldest
    from store s
    join (
      select store_id, 'shipment_awaiting_balance' as key, count(*) as count, min(created_at) as oldest from shipment where status = 'awaiting_balance' group by store_id
      union all select store_id, 'shipment_problem', count(*), min(created_at) from shipment where status in ('problem', 'failed') group by store_id
      union all select store_id, 'payment_unknown', count(*), min(created_at) from payment_attempt where status = 'unknown' group by store_id
      union all select store_id, 'late_payment_open', count(*), min(created_at) from late_payment_obligation where status = 'open' group by store_id
    ) r on r.store_id = s.id
    order by s.id, r.key`)) as unknown as { store_id: string; store_name: string; store_slug: string; key: string; count: number; oldest: Date | string | null }[];
  const acks = (await op.exec.execute(sql`
    select distinct on (store_ref, flag_key) store_ref, flag_key, expires_at from store_risk_ack order by store_ref, flag_key, id desc`)) as unknown as { store_ref: string; flag_key: string; expires_at: Date | string }[];
  const now = Date.now();
  const ackOf = (id: number, key: string) => {
    const a = acks.find((x) => Number(x.store_ref) === id && x.flag_key === key);
    return a && new Date(a.expires_at).getTime() > now ? { until: new Date(a.expires_at) } : null;
  };
  const all: RiskFlag[] = rows.map((r) => ({ storeId: Number(r.store_id), storeName: r.store_name, storeSlug: r.store_slug, key: r.key, count: Number(r.count), oldestAt: r.oldest ? new Date(r.oldest) : null, acknowledged: ackOf(Number(r.store_id), r.key) }));
  return {
    asOf: new Date(),
    flags: f.showAcknowledged ? all : all.filter((x) => !x.acknowledged),
    hiddenAcknowledged: all.filter((x) => x.acknowledged).length,
    unavailableRules: RISK_RULES.filter((r) => !r.available).map(({ key, rule, source }) => ({ key, rule, source })),
    rules: RISK_RULES,
  };
}

/** Acknowledge a flag with a reason and an expiry (tenants.manage). The flag stays derived from its source; the acknowledgement only hides it until `expiresAt`. */
export async function acknowledgeRisk(op: OperatorScope, storeId: number, raw: unknown): Promise<void> {
  const i = z.strictObject({ flagKey: z.enum(RISK_RULES.filter((r) => r.available).map((r) => r.key) as [string, ...string[]]), reason: reasonText, expiresAt: z.date() }).parse(raw);
  if (i.expiresAt.getTime() <= Date.now()) throw new DomainError("invalid", "Batas waktu pengakuan harus di masa depan.");
  await governed(op, { capability: "tenants.manage", action: "risk.ack", subjectKind: "store", subjectId: String(storeId), storeId, reasonCode: "risk_acknowledged", reason: i.reason }, async (tx) => {
    const [s] = await tx.select({ id: store.id }).from(store).where(eq(store.id, storeId));
    if (!s) throw new DomainError("not_found", "Toko tidak ditemukan.");
    await tx.insert(storeRiskAck).values({ storeRef: storeId, flagKey: i.flagKey, acknowledgedBy: op.userId, reason: scrubText(i.reason, 500), expiresAt: i.expiresAt });
  });
}

/** Cases that name this store (SA-03 "cases for this store"). */
export async function storeCases(op: OperatorScope, storeId: number) {
  await requirePlatformCap(op, "cases.read");
  return op.exec
    .select({ id: supportCase.id, caseNumber: supportCase.caseNumber, title: supportCase.title, status: supportCase.status })
    .from(supportCase)
    .where(and(eq(supportCase.subjectKind, "store"), eq(supportCase.subjectId, String(storeId))))
    .orderBy(desc(supportCase.id))
    .limit(20);
}
