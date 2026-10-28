import { z } from "zod";
import { scrubText } from "./ops.ts";

// Per-action redaction allowlists of the Owner console viewers (T-62, D-21 "allowlist-based audit redaction", SEC-5).
// Nothing is shown by pattern: a viewer renders only what an allowlist names, so a new action or a new key is hidden
// until someone adds it here, and `assertSafeAllowlist` refuses (at import time, so the app does not start) a key that
// looks like a credential.

/** Key names that must never be allowlisted, whatever the action. */
export const CREDENTIAL_LIKE_KEY = /(pass(word|wd|phrase)?|secret|token|cookie|authorization|credential|api[-_]?key|otp|recovery|private[-_]?key|session|bearer|signature|hash|digest_secret|body|payload|header)/i;

export function assertSafeAllowlist(allowlist: Readonly<Record<string, readonly string[]>>): void {
  for (const [action, keys] of Object.entries(allowlist)) {
    for (const key of keys) if (CREDENTIAL_LIKE_KEY.test(key)) throw new Error(`redaction allowlist: "${key}" (action ${action}) looks like a credential and cannot be allowlisted`);
  }
}

/**
 * Audit viewer: per action FAMILY (the text before the first ":" of `audit_log.action`), the `key:value` tokens of the
 * stored reason that may be shown, and whether the free-text reason (scrubbed) may be shown. An unlisted family shows its
 * name and the structured columns only.
 */
export const AUDIT_VIEW: Readonly<Record<string, { fields: readonly string[]; reason: boolean }>> = {
  "store.create": { fields: [], reason: true },
  "store.active": { fields: [], reason: true },
  "store.suspended": { fields: [], reason: true },
  "operator.denied": { fields: [], reason: false },
  "console.denied": { fields: [], reason: false },
  "approval.decide": { fields: [], reason: true },
  "approval.read": { fields: ["count"], reason: false },
  "audit.read": { fields: ["count"], reason: false },
  "access.read": { fields: ["count"], reason: false },
  "issue.create": { fields: ["page_id"], reason: false },
  "issue.read": { fields: ["count"], reason: false },
  "jobs.requeue": { fields: ["job", "kind"], reason: true },
  "jobs.reconcile": { fields: ["job", "kind"], reason: true },
  "projection.rebuild": { fields: ["projection", "rows"], reason: true },
  "retention.set": { fields: ["class", "days"], reason: true },
  "logs.read": { fields: ["event"], reason: false },
  "shipping.margin": { fields: [], reason: true },
  "shipping.margin.update": { fields: [], reason: true },
  "shipping.settings": { fields: [], reason: true },
  "shipping.cashback.draft": { fields: [], reason: true },
  "shipping.courier": { fields: [], reason: true },
  "shipping.account.recover": { fields: [], reason: true },
  // T-63 account governance: operator-written reasons are scrubbed on write and shown scrubbed; the reason codes live in purpose_code.
  "case.open": { fields: [], reason: true },
  "case.note": { fields: [], reason: false },
  "case.move": { fields: [], reason: true },
  "case.reopen": { fields: [], reason: true },
  "support.revoke_sessions": { fields: [], reason: true },
  "support.start_recovery": { fields: [], reason: true },
  "support.suspend": { fields: [], reason: true },
  "support.reinstate": { fields: [], reason: true },
  "support.reset_mfa": { fields: [], reason: true },
  "support.reset_mfa_execute": { fields: ["approval"], reason: false },
  "account.search": { fields: ["kind"], reason: false },
  "verification.submit": { fields: [], reason: true },
  "verification.review": { fields: [], reason: true },
  "risk.ack": { fields: [], reason: true },
  "staff.deactivate": { fields: [], reason: true },
  "staff.reactivate": { fields: [], reason: true },
  "staff.revoke_sessions": { fields: [], reason: true },
  "staff.mfa_reset_request": { fields: [], reason: true },
  "staff.mfa_reset_execute": { fields: ["approval"], reason: false },
  "access_review.confirmed": { fields: [], reason: true },
  "access_review.revoked": { fields: [], reason: true },
  "break_glass.request": { fields: ["approval"], reason: false },
  "break_glass.grant": { fields: ["grant", "approval"], reason: false },
  "break_glass.revoke": { fields: ["grant"], reason: false },
  "break_glass.review": { fields: ["grant"], reason: false },
};
assertSafeAllowlist(Object.fromEntries(Object.entries(AUDIT_VIEW).map(([k, v]) => [k, v.fields])));

/** Issue-report context keys the viewer may render at the top level, and inside nested diagnostic entries. */
export const ISSUE_CONTEXT_FIELDS = {
  top: ["schemaVersion", "release", "viewport", "capabilities", "recentRequests", "failedActions", "recentClientErrors", "partial", "controlRole", "controlName", "userAgent"],
  nested: ["requestId", "route", "method", "status", "durationMs", "outcome", "name", "code", "message", "digest", "width", "height"],
} as const;
assertSafeAllowlist(ISSUE_CONTEXT_FIELDS);

export const auditFamily = (action: string) => action.split(":", 1)[0] ?? action;

export type AuditRowView = { id: number; createdAt: Date; actorUserId: string; action: string; storeId: number | null; actorCapability: string | null; subjectKind: string | null; subjectId: string | null; caseId: string | null; outcome: string | null; accessLevel: string | null; reason: string | null };
export interface AuditEntry {
  id: number;
  createdAt: Date;
  actorUserId: string;
  /** The action family only (the text before the first ":"). */
  action: string;
  storeId: number | null;
  actorCapability: string | null;
  subjectKind: string | null;
  subjectId: string | null;
  caseId: string | null;
  outcome: string | null;
  accessLevel: string | null;
  /** Allowlisted `key:value` tokens of the stored reason for this action family. */
  fields: Record<string, string>;
  /** Scrubbed free-text reason; null unless the action family allows it. */
  reason: string | null;
}
export function auditView(row: AuditRowView): AuditEntry {
  const family = auditFamily(row.action);
  const rule = AUDIT_VIEW[family];
  const fields: Record<string, string> = {};
  if (rule && row.reason) {
    for (const m of row.reason.matchAll(/(?:^|\s)([a-z_]{1,32}):([^\s]{1,80})/g)) {
      if (rule.fields.includes(m[1]!) && !(m[1]! in fields)) fields[m[1]!] = scrubText(m[2], 80);
    }
  }
  return {
    id: row.id, createdAt: row.createdAt, actorUserId: row.actorUserId, action: family, storeId: row.storeId, actorCapability: row.actorCapability,
    subjectKind: row.subjectKind, subjectId: row.subjectId ? scrubText(row.subjectId, 80) : null, caseId: row.caseId ? scrubText(row.caseId, 64) : null,
    outcome: row.outcome, accessLevel: row.accessLevel, fields, reason: rule?.reason && row.reason ? scrubText(row.reason, 500) : null,
  };
}

/** The typed shape the issue viewer renders: what survives the allowlist and validates; anything malformed degrades to the empty context. */
export const issueContextView = z.object({
  release: z.string().optional(),
  userAgent: z.string().optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).nullable().optional(),
  capabilities: z.array(z.string()).default([]),
  recentRequests: z.array(z.object({ requestId: z.string(), route: z.string(), method: z.string(), status: z.number(), durationMs: z.number(), outcome: z.string() })).default([]),
  failedActions: z.array(z.object({ name: z.string(), code: z.string() })).default([]),
  recentClientErrors: z.array(z.object({ name: z.string(), message: z.string(), digest: z.string().optional() })).default([]),
  partial: z.boolean().optional(),
  controlRole: z.string().optional(),
  controlName: z.string().optional(),
});
export type IssueContextView = z.infer<typeof issueContextView>;
/** Applied again at read time, so a row written by any other path cannot leak extra keys. */
export function redactIssueContext(context: unknown): IssueContextView {
  const walk = (value: unknown, nested: boolean): unknown => {
    if (typeof value === "string") return scrubText(value, 500);
    if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, 100).map((v) => walk(v, true));
    if (typeof value !== "object") return undefined;
    const allowed: readonly string[] = nested ? ISSUE_CONTEXT_FIELDS.nested : ISSUE_CONTEXT_FIELDS.top;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (!allowed.includes(key)) continue;
      const next = walk(v, true);
      if (next !== undefined) out[key] = next;
    }
    return out;
  };
  const parsed = issueContextView.safeParse(walk(context, false));
  return parsed.success ? parsed.data : issueContextView.parse({});
}
