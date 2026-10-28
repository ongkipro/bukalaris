// SA-20 cases and notes (DATA-14). A case is the container every account action, reveal and verification review cites.
// Notes are append-only and scrubbed of contact, URL, token and number shapes; the title is scrubbed too, so a case never
// carries personal data of its own (sensitive data is referenced by id).
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client.ts";
import { accountStatusEvent, supportAction, supportCase, supportCaseNote, CASE_KINDS, CASE_PRIORITIES, CASE_STATUSES, CASE_TRANSITIONS, SUBJECT_KINDS } from "./schema-governance.ts";
import { DomainError, type OperatorScope } from "../platform/scoped.ts";
import { requirePlatformCap } from "./capabilities.ts";
import { governed, reasonCode, reasonText } from "./accounts-governance.ts";
import { scrubText } from "./ops.ts";
import { pgCode } from "./capabilities.ts";

const openInput = z.strictObject({
  kind: z.enum(CASE_KINDS).default("support"),
  subjectKind: z.enum([...SUBJECT_KINDS, "order_ref"]).optional(),
  subjectId: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,64}$/, "ID subjek tidak valid.").optional(),
  title: z.string().trim().min(3, "Judul minimal 3 karakter.").max(200),
  priority: z.enum(CASE_PRIORITIES).default("normal"),
  dueAt: z.date().optional(),
  reasonCode: reasonCode.default("case_opened"),
  reason: reasonText,
});

/** Open a case (cases.write). The new row and its audit row are one transaction. */
export async function openCase(op: OperatorScope, raw: unknown): Promise<{ id: number; caseNumber: string }> {
  const i = openInput.parse(raw);
  if ((i.subjectKind === undefined) !== (i.subjectId === undefined)) throw new DomainError("invalid", "Jenis dan ID subjek harus diisi bersamaan.");
  return governed(op, { capability: "cases.write", action: "case.open", subjectKind: "case", subjectId: "new", reasonCode: i.reasonCode, reason: i.reason }, async (tx) => {
    const [row] = await tx
      .insert(supportCase)
      .values({ kind: i.kind, subjectKind: i.subjectKind ?? null, subjectId: i.subjectId ?? null, title: scrubText(i.title, 200), priority: i.priority, dueAt: i.dueAt ?? null, openedByUserId: op.userId, assigneeUserId: op.userId })
      .returning({ id: supportCase.id, caseNumber: supportCase.caseNumber });
    return { id: row!.id, caseNumber: row!.caseNumber! };
  });
}

export interface CaseListItem {
  id: number;
  caseNumber: string;
  kind: string;
  title: string;
  status: string;
  priority: string;
  subjectKind: string | null;
  subjectId: string | null;
  assigneeUserId: string | null;
  dueAt: Date | null;
  overdue: boolean;
  createdAt: Date;
}
export async function listCases(op: OperatorScope, raw: unknown = {}): Promise<{ items: CaseListItem[]; nextCursor: number | null }> {
  await requirePlatformCap(op, "cases.read");
  const f = z.object({ status: z.enum(CASE_STATUSES).optional(), subjectKind: z.string().max(32).optional(), subjectId: z.string().max(64).optional(), cursor: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(raw);
  const rows = await op.exec
    .select()
    .from(supportCase)
    .where(and(f.status ? eq(supportCase.status, f.status) : undefined, f.subjectKind ? eq(supportCase.subjectKind, f.subjectKind as never) : undefined, f.subjectId ? eq(supportCase.subjectId, f.subjectId) : undefined, f.cursor ? lt(supportCase.id, f.cursor) : undefined))
    .orderBy(desc(supportCase.id))
    .limit(f.limit + 1);
  const now = Date.now();
  const page = rows.slice(0, f.limit);
  return {
    items: page.map((c) => ({ id: c.id, caseNumber: c.caseNumber!, kind: c.kind, title: c.title, status: c.status, priority: c.priority, subjectKind: c.subjectKind, subjectId: c.subjectId, assigneeUserId: c.assigneeUserId, dueAt: c.dueAt, overdue: c.dueAt !== null && c.dueAt.getTime() < now && !["resolved", "closed"].includes(c.status), createdAt: c.createdAt })),
    nextCursor: rows.length > f.limit ? page[page.length - 1]!.id : null,
  };
}

export async function getCase(op: OperatorScope, id: number) {
  await requirePlatformCap(op, "cases.read");
  const [c] = await op.exec.select().from(supportCase).where(eq(supportCase.id, id));
  if (!c) return null;
  const [notes, actions, events] = await Promise.all([
    op.exec.select().from(supportCaseNote).where(eq(supportCaseNote.caseId, id)).orderBy(supportCaseNote.id),
    op.exec.select({ id: supportAction.id, actionKind: supportAction.actionKind, status: supportAction.status, resultCode: supportAction.resultCode, createdAt: supportAction.createdAt }).from(supportAction).where(eq(supportAction.caseId, id)).orderBy(desc(supportAction.id)).limit(50),
    op.exec.select({ id: accountStatusEvent.id, subjectKind: accountStatusEvent.subjectKind, subjectId: accountStatusEvent.subjectId, fromStatus: accountStatusEvent.fromStatus, toStatus: accountStatusEvent.toStatus, reasonCode: accountStatusEvent.reasonCode, createdAt: accountStatusEvent.createdAt }).from(accountStatusEvent).where(eq(accountStatusEvent.caseId, id)).orderBy(desc(accountStatusEvent.id)).limit(50),
  ]);
  // Notes were scrubbed when written; they are scrubbed again on the way out so a row written by another path cannot leak a contact shape.
  return { ...c, caseNumber: c.caseNumber!, overdue: c.dueAt !== null && c.dueAt.getTime() < Date.now() && !["resolved", "closed"].includes(c.status), notes: notes.map((n) => ({ ...n, body: scrubText(n.body, 2000) })), actions, events };
}

/** Append a note (cases.write). Contact, URL, token and long-number shapes are removed before storage; a closed case takes no notes. */
export async function addCaseNote(op: OperatorScope, caseId: number, body: string): Promise<number> {
  const text = z.string().trim().min(1, "Catatan wajib diisi.").max(2000).parse(body);
  return governed(op, { capability: "cases.write", action: "case.note", subjectKind: "case", subjectId: String(caseId), reasonCode: "case_note", reason: "catatan kasus ditambahkan" }, async (tx) => {
    const [c] = await tx.select({ status: supportCase.status }).from(supportCase).where(eq(supportCase.id, caseId)).for("share");
    if (!c) throw new DomainError("not_found", "Kasus tidak ditemukan.");
    if (c.status === "closed") throw new DomainError("case_closed", "Kasus sudah ditutup.");
    const clean = scrubText(text, 2000);
    if (!clean) throw new DomainError("invalid", "Catatan kosong setelah dibersihkan dari data pribadi.");
    const [row] = await tx.insert(supportCaseNote).values({ caseId, authorUserId: op.userId, kind: "note", body: clean }).returning({ id: supportCaseNote.id });
    return row!.id;
  });
}

/**
 * Move a case along its legal transitions (DATA-14). The move is a compare-and-swap on the status the caller saw, so two staff members
 * moving the same case yield one change and one `conflict`. `resolved` needs a resolution code; a reopen (`resolved -> open`) is audited with its reason.
 */
export async function moveCase(op: OperatorScope, caseId: number, input: { from: (typeof CASE_STATUSES)[number]; to: (typeof CASE_STATUSES)[number]; resolutionCode?: string; reasonCode?: string; reason: string }): Promise<void> {
  const to = z.enum(CASE_STATUSES).parse(input.to);
  const from = z.enum(CASE_STATUSES).parse(input.from);
  if (!CASE_TRANSITIONS[from].includes(to)) throw new DomainError("illegal_transition", `Kasus tidak dapat dipindah dari ${from} ke ${to}.`);
  const resolution = input.resolutionCode ? reasonCode.parse(input.resolutionCode) : null;
  if (to === "resolved" && !resolution) throw new DomainError("resolution_required", "Kode penyelesaian wajib untuk menyelesaikan kasus.");
  await governed(op, { capability: "cases.write", action: to === "open" ? "case.reopen" : "case.move", subjectKind: "case", subjectId: String(caseId), reasonCode: input.reasonCode ?? "case_moved", reason: input.reason }, async (tx: Tx) => {
    try {
      const moved = await tx
        .update(supportCase)
        .set({
          status: to,
          updatedAt: sql`now()` as unknown as Date,
          ...(to === "resolved" ? { resolvedAt: sql`now()` as unknown as Date, resolutionCode: resolution } : {}),
          ...(to === "closed" ? { closedAt: sql`now()` as unknown as Date } : {}),
          ...(to === "open" ? { resolvedAt: null, resolutionCode: null } : {}),
        })
        .where(and(eq(supportCase.id, caseId), eq(supportCase.status, from)))
        .returning({ id: supportCase.id });
      if (moved.length === 0) {
        const [c] = await tx.select({ id: supportCase.id }).from(supportCase).where(eq(supportCase.id, caseId));
        throw c ? new DomainError("conflict", "Status kasus sudah berubah. Muat ulang halaman.") : new DomainError("not_found", "Kasus tidak ditemukan.");
      }
      await tx.insert(supportCaseNote).values({ caseId, authorUserId: op.userId, kind: "system", body: `status ${from} -> ${to}` });
    } catch (err) {
      if (pgCode(err) === "23514") throw new DomainError("illegal_transition", "Perpindahan status kasus ini tidak diizinkan.");
      throw err;
    }
  });
}
