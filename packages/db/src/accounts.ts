import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "./client.ts";
import { account, auditLog, mailOutbox, membership, platformOperator, session, store, storeInvitation, user } from "./schema.ts";
import { DomainError, requireCap, type Role, type SellerScope } from "./scoped.ts";

// M2 `accounts` track: dev mailer, store invitations, session lifecycle helpers (PR-15, IAM-9).

// ---------------------------------------------------------------------------
// Mailer. The only implementation in M2 stores mail in `mail_outbox` (no network);
// a real provider implements the same interface later (see docs/tracks/accounts.md).
// ---------------------------------------------------------------------------
export type Mail = { to: string; subject: string; text: string; html?: string };
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function dbMailer(exec: Executor): Mailer {
  return {
    async send(mail) {
      await exec.insert(mailOutbox).values({ toEmail: mail.to, subject: mail.subject, textBody: mail.text, htmlBody: mail.html ?? null });
    },
  };
}

/** Dev-only viewer data (the route guards NODE_ENV); newest first. */
export async function listOutbox(exec: Executor, limit = 50) {
  return exec.select().from(mailOutbox).orderBy(desc(mailOutbox.id)).limit(limit);
}

// ---------------------------------------------------------------------------
// Invitations.
// ---------------------------------------------------------------------------
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Roles an inviter may assign (IAM-9: never outside the inviter's authority). */
const assignable: Record<Role, readonly Role[]> = { owner: ["owner", "staff"], staff: [] };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const email = z.string().trim().toLowerCase().email("Alamat email tidak valid.").max(254);
const inviteInput = z.strictObject({ email, role: z.enum(["owner", "staff"], { error: "Peran tidak valid." }) });

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";
const statusOf = (r: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now = new Date()): InvitationStatus =>
  r.acceptedAt ? "accepted" : r.revokedAt ? "revoked" : r.expiresAt <= now ? "expired" : "pending";

/**
 * Invite an e-mail address to the scope's store. Returns the invitation id; the
 * token leaves the server only inside the e-mail sent through `mailer`.
 */
export async function createInvitation(
  scope: SellerScope,
  mailer: Mailer,
  raw: unknown,
  acceptUrl: (token: string) => string,
): Promise<number> {
  requireCap(scope, "members.manage");
  const input = inviteInput.parse(raw);
  if (!assignable[scope.role].includes(input.role)) throw new DomainError("forbidden", "Peran di luar wewenang Anda.");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const id = await scope.exec.transaction(async (tx) => {
    const [existing] = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .where(and(eq(membership.storeId, scope.storeId), sql`lower(${user.email}) = ${input.email}`));
    if (existing) throw new DomainError("already_member", "Email ini sudah menjadi anggota toko.");
    // One live invitation per e-mail per store: a new invite supersedes the pending one.
    await tx
      .update(storeInvitation)
      .set({ revokedAt: new Date() })
      .where(and(eq(storeInvitation.storeId, scope.storeId), eq(storeInvitation.email, input.email), isNull(storeInvitation.acceptedAt), isNull(storeInvitation.revokedAt)));
    const [row] = await tx
      .insert(storeInvitation)
      .values({ storeId: scope.storeId, email: input.email, role: input.role, tokenHash: hashToken(token), invitedBy: scope.userId, expiresAt })
      .returning({ id: storeInvitation.id });
    await tx.insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: `invite.create:${row!.id}:${input.role}` });
    return row!.id;
  });
  await mailer.send({
    to: input.email,
    subject: `Undangan bergabung ke ${scope.storeName} di Bukalaris`,
    text: [
      `Anda diundang menjadi ${input.role === "owner" ? "pemilik" : "staf"} toko ${scope.storeName} di Bukalaris.`,
      `Terima undangan: ${acceptUrl(token)}`,
      `Tautan berlaku sampai ${expiresAt.toISOString()} dan hanya dapat dipakai sekali.`,
    ].join("\n"),
  });
  return id;
}

export async function listInvitations(scope: SellerScope) {
  requireCap(scope, "members.manage");
  const rows = await scope.exec
    .select({ id: storeInvitation.id, email: storeInvitation.email, role: storeInvitation.role, expiresAt: storeInvitation.expiresAt, acceptedAt: storeInvitation.acceptedAt, revokedAt: storeInvitation.revokedAt, createdAt: storeInvitation.createdAt })
    .from(storeInvitation)
    .where(and(eq(storeInvitation.storeId, scope.storeId), isNull(storeInvitation.acceptedAt), isNull(storeInvitation.revokedAt)))
    .orderBy(desc(storeInvitation.id));
  return rows.map((r) => ({ ...r, status: statusOf(r) }));
}

export async function revokeInvitation(scope: SellerScope, invitationId: number): Promise<void> {
  requireCap(scope, "members.manage");
  await scope.exec.transaction(async (tx) => {
    const [row] = await tx
      .update(storeInvitation)
      .set({ revokedAt: new Date() })
      .where(and(eq(storeInvitation.id, invitationId), eq(storeInvitation.storeId, scope.storeId), isNull(storeInvitation.acceptedAt), isNull(storeInvitation.revokedAt)))
      .returning({ id: storeInvitation.id });
    if (!row) throw new DomainError("not_found", "Undangan tidak ditemukan.");
    await tx.insert(auditLog).values({ actorUserId: scope.userId, storeId: scope.storeId, action: `invite.revoke:${invitationId}` });
  });
}

export type InvitationPreview =
  | { status: "invalid" }
  | { status: Exclude<InvitationStatus, "pending">; storeName: string }
  | { status: "pending"; email: string; role: Role; storeName: string; hasAccount: boolean };

/** Public lookup for the accept page (token holder only; nothing else is revealed). */
export async function previewInvitation(exec: Executor, token: string): Promise<InvitationPreview> {
  const [row] = await exec
    .select({ email: storeInvitation.email, role: storeInvitation.role, expiresAt: storeInvitation.expiresAt, acceptedAt: storeInvitation.acceptedAt, revokedAt: storeInvitation.revokedAt, storeName: store.name, storeStatus: store.status })
    .from(storeInvitation)
    .innerJoin(store, eq(store.id, storeInvitation.storeId))
    .where(eq(storeInvitation.tokenHash, hashToken(token)));
  if (!row) return { status: "invalid" };
  const status = statusOf(row);
  if (status !== "pending") return { status, storeName: row.storeName };
  const [u] = await exec.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${row.email}`);
  return { status, email: row.email, role: row.role, storeName: row.storeName, hasAccount: !!u };
}

export type Acceptor =
  | { kind: "existing"; userId: string }
  | { kind: "new"; name: string; passwordHash: string };
const newAccount = z.object({ name: z.string().trim().min(2, "Nama minimal 2 karakter.").max(100) });

/**
 * Consume an invitation and grant membership in one transaction. For a new
 * account the user + credential rows are created in the same transaction, so a
 * concurrent second accept (row lock) or a failure leaves neither behind.
 */
export async function acceptInvitation(exec: Executor, token: string, acceptor: Acceptor) {
  return exec.transaction(async (tx) => {
    const [inv] = await tx.select().from(storeInvitation).where(eq(storeInvitation.tokenHash, hashToken(token))).for("update");
    if (!inv) throw new DomainError("invite_invalid", "Undangan tidak ditemukan.");
    const status = statusOf(inv);
    if (status === "accepted") throw new DomainError("invite_used", "Undangan ini sudah dipakai.");
    if (status === "revoked") throw new DomainError("invite_revoked", "Undangan ini sudah dibatalkan.");
    if (status === "expired") throw new DomainError("invite_expired", "Undangan ini sudah kedaluwarsa.");
    const [s] = await tx.select({ status: store.status }).from(store).where(eq(store.id, inv.storeId));
    if (s?.status !== "active") throw new DomainError("store_unavailable", "Toko sedang tidak aktif.");

    let userId: string;
    if (acceptor.kind === "existing") {
      const [u] = await tx.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, acceptor.userId));
      if (!u || u.email.toLowerCase() !== inv.email) throw new DomainError("email_mismatch", "Undangan ini ditujukan ke email lain.");
      userId = u.id;
    } else {
      const { name } = newAccount.parse(acceptor);
      const [taken] = await tx.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${inv.email}`);
      if (taken) throw new DomainError("account_exists", "Akun dengan email ini sudah ada. Silakan masuk.");
      userId = randomUUID();
      // Same rows Better Auth's credential sign-up would create (see seed.ts).
      await tx.insert(user).values({ id: userId, email: inv.email, name, emailVerified: true });
      await tx.insert(account).values({ id: randomUUID(), accountId: userId, providerId: "credential", userId, password: acceptor.passwordHash });
    }
    const [member] = await tx.select({ userId: membership.userId }).from(membership).where(and(eq(membership.storeId, inv.storeId), eq(membership.userId, userId)));
    if (member) throw new DomainError("already_member", "Anda sudah menjadi anggota toko ini.");
    await tx.insert(membership).values({ storeId: inv.storeId, userId, role: inv.role });
    await tx.update(storeInvitation).set({ acceptedAt: new Date(), acceptedUserId: userId }).where(eq(storeInvitation.id, inv.id));
    await tx.insert(auditLog).values({ actorUserId: userId, storeId: inv.storeId, action: `invite.accept:${inv.id}:${inv.role}` });
    return { storeId: inv.storeId, userId, role: inv.role, email: inv.email };
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle.
// ---------------------------------------------------------------------------
/** Revoke every session of a user who no longer has any membership and is not an operator. Returns the number revoked. */
export async function revokeSessionsIfOrphaned(exec: Executor, userId: string): Promise<number> {
  const [m] = await exec.select({ storeId: membership.storeId }).from(membership).where(eq(membership.userId, userId)).limit(1);
  const [op] = await exec.select({ userId: platformOperator.userId }).from(platformOperator).where(eq(platformOperator.userId, userId));
  if (m || op) return 0;
  return (await exec.delete(session).where(eq(session.userId, userId)).returning({ id: session.id })).length;
}

/** Live (unexpired) sessions of a user — used by tests to prove revocation. */
export async function countLiveSessions(exec: Executor, userId: string): Promise<number> {
  return (await exec.select({ id: session.id }).from(session).where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())))).length;
}
