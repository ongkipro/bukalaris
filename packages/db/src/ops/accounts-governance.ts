// T-63 account governance, shared parts: masking, the reason and idempotency inputs, case resolution and the audited transaction.
// Services of this family (cases, stores, accounts, support actions, reveal, staff) take an OperatorScope and call
// `requirePlatformCap` (through `governed` or `withPersonalDataAccess`) as their first statement. No password, session token,
// recovery link or OTP ever appears in a DTO, a log line, an audit reason or a support-action row.
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client.ts";
import { auditLog, membership, platformOperator } from "../schema.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { holdsCapability, requirePlatformCap } from "./capabilities.ts";
import { scrubText } from "./ops.ts";
import { supportCase, type SubjectKind } from "./schema-governance.ts";
import type { PlatformCapability } from "./schema-ops.ts";

// ── Masking (PRIV-9): a data-layer function; page code never masks a raw value ───────────────────────────────────────────
/** `b***@t***.com`: first character of the local part and of the domain, the rest hidden. A value that is not an address is fully hidden. */
export function maskEmail(value: string | null | undefined): string {
  const m = /^([^@\s]+)@([^@\s.]+)((?:\.[^@\s]+)+)$/.exec((value ?? "").trim());
  return m ? `${m[1]![0]}***@${m[2]![0]}***${m[3]!.slice(m[3]!.lastIndexOf("."))}` : "***";
}
/** Initial of each word, the rest hidden: `B*** S***`. */
export function maskName(value: string | null | undefined): string {
  const words = (value ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 4);
  return words.length ? words.map((w) => `${[...w][0]}***`).join(" ") : "***";
}
/** Canonical Indonesian mobile number (`62…`) or null: accepts `08…`, `62…`, `+62…`, spaces, dashes and brackets. */
export function canonicalPhone(value: string): string | null {
  const digits = value.replace(/[\s().-]/g, "").replace(/^\+/, "");
  if (!/^\d{9,15}$/.test(digits)) return null;
  const n = digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
  return /^62\d{8,13}$/.test(n) ? n : null;
}
/** Last four digits only. */
export const maskPhone = (value: string | null | undefined): string => (value && /\d{4}$/.test(value) ? `***${value.slice(-4)}` : "***");

/** A keyed fingerprint of a canonical query (never the query itself) so audit can count and correlate without storing contact text. */
export function queryFingerprint(canonical: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.ACCOUNT_SEARCH_FINGERPRINT_KEY ?? env.BETTER_AUTH_SECRET;
  return secret ? createHmac("sha256", `bukalaris.account-search:${secret}`).update(canonical).digest("hex").slice(0, 16) : null;
}

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const reasonCode = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/, "Kode alasan tidak valid.");
export const reasonText = z.string().trim().min(5, "Alasan minimal 5 karakter.").max(500);
/** A case reference: the numeric id or the number staff say aloud (`C-000123`). */
export const caseRefSchema = z.union([z.number().int().positive(), z.string().regex(/^C-\d{6,}$/, "Nomor kasus tidak valid.")]);
export const idempotencyKey = z.string().min(8, "Kunci idempotensi minimal 8 karakter.").max(128);

export type GovernedCase = { id: number; caseNumber: string; kind: string; status: string; subjectKind: string | null; subjectId: string | null };
const OPEN_CASE_STATUSES = ["open", "in_progress", "waiting"];

/**
 * The open case an action or a reveal cites (PRIV-9, UX-22 "a case and a reason for every action"). A resolved or closed case does
 * not authorise anything. A case that names a target action must name a subject, and the target must be that subject, or (store case) a member of that store.
 */
export async function requireOpenCase(tx: Tx, raw: unknown, target?: { kind: SubjectKind; id: string }): Promise<GovernedCase> {
  const ref = caseRefSchema.safeParse(raw);
  if (!ref.success) throw new DomainError("case_required", "Kasus yang masih terbuka wajib dipilih.");
  const [c] = await tx
    .select({ id: supportCase.id, caseNumber: supportCase.caseNumber, kind: supportCase.kind, status: supportCase.status, subjectKind: supportCase.subjectKind, subjectId: supportCase.subjectId })
    .from(supportCase)
    .where(typeof ref.data === "number" ? eq(supportCase.id, ref.data) : eq(supportCase.caseNumber, ref.data));
  if (!c || !OPEN_CASE_STATUSES.includes(c.status)) throw new DomainError("case_required", "Kasus yang masih terbuka wajib dipilih.");
  // Wave 3 review: a case without a subject authorises NO target; otherwise one generic case could be cited for every account.
  if (target && (!c.subjectKind || !c.subjectId)) throw new DomainError("case_mismatch", "Kasus ini tidak mengenai target tindakan.");
  if (target && c.subjectKind && c.subjectId) {
    const same = c.subjectKind === target.kind && c.subjectId === target.id;
    let storeMember = false;
    if (!same && c.subjectKind === "store" && target.kind === "user") {
      const [m] = await tx.select({ u: membership.userId }).from(membership).where(sql`${membership.storeId} = ${Number(c.subjectId)} and ${membership.userId} = ${target.id}`);
      storeMember = m !== undefined;
    }
    if (!same && !storeMember) throw new DomainError("case_mismatch", "Kasus ini tidak mengenai target tindakan.");
  }
  return { id: c.id, caseNumber: c.caseNumber!, kind: c.kind, status: c.status, subjectKind: c.subjectKind, subjectId: c.subjectId };
}

/** A staff identity is never an account-support target: not-found, with a denial row so the attempt is visible in the audit log. */
export async function requireAccountTarget(op: OperatorScope, userId: string, capability: PlatformCapability): Promise<void> {
  const [row] = await op.exec.select({ id: platformOperator.userId }).from(platformOperator).where(eq(platformOperator.userId, userId));
  if (row) {
    await op.exec.insert(auditLog).values({ actorUserId: op.userId, actorCapability: capability, action: "operator.denied", subjectKind: "user", subjectId: "staff", outcome: "denied", reason: "staff_target" });
    throw new DomainError("not_found", "Akun tidak ditemukan.");
  }
}

// ── The audited transaction ─────────────────────────────────────────────────────────────────────────────────────────────
export type GovernedInput = {
  capability: PlatformCapability;
  /** Audit action name, `family.verb` (the audit viewer redacts by the family). */
  action: string;
  subjectKind: string;
  subjectId: string;
  reasonCode: string;
  reason: string;
  /** Tenant the audit row belongs to (store-scoped history such as `storeAudit`), if any. */
  storeId?: number;
  /** The case this action cites. `required` makes a missing or closed case a refusal; `ref` may be absent for optional-case actions. */
  case?: { ref: unknown; required: boolean; target?: { kind: SubjectKind; id: string } };
};

/**
 * The mutation wrapper of this family: capability first (denial row on refusal), then ONE transaction that re-checks the capability,
 * resolves the cited case, runs the change, re-checks the capability just before the audit row and writes that row. A change that
 * cannot be audited, or an operator whose grant was revoked meanwhile, rolls everything back. The audit reason carries the scrubbed
 * text only; the reason code goes in `purpose_code`.
 */
export async function governed<T>(op: OperatorScope, input: GovernedInput, run: (tx: Tx, citedCase: GovernedCase | null) => Promise<T>): Promise<T> {
  await requirePlatformCap(op, input.capability);
  const code = reasonCode.safeParse(input.reasonCode);
  const text = reasonText.safeParse(input.reason);
  if (!code.success || !text.success) throw new DomainError("reason_required", "Kode alasan dan alasan (minimal 5 karakter) wajib diisi.");
  return op.exec.transaction(async (tx) => {
    const held = async () => {
      if (!(await holdsCapability(tx, op.userId, input.capability))) throw new DomainError("forbidden", `Akses ditolak: butuh izin ${input.capability}.`);
    };
    await held();
    const wantsCase = input.case !== undefined && (input.case.required || (input.case.ref !== undefined && input.case.ref !== null && input.case.ref !== ""));
    const cited = wantsCase ? await requireOpenCase(tx, input.case!.ref, input.case!.target) : null;
    const result = await run(tx, cited);
    await held();
    await tx.insert(auditLog).values({
      actorUserId: op.userId,
      storeId: input.storeId ?? null,
      actorCapability: input.capability,
      action: input.action,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId.slice(0, 200),
      caseId: cited?.caseNumber ?? null,
      purposeCode: code.data,
      reason: scrubText(text.data),
      accessLevel: "write",
      outcome: "allowed",
    });
    return result;
  });
}
