import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  acceptInvitation,
  countLiveSessions,
  createInvitation,
  dbMailer,
  INVITATION_TTL_MS,
  listInvitations,
  listOutbox,
  previewInvitation,
  revokeInvitation,
} from "../src/platform/accounts.ts";
import { changeMember } from "../src/platform/membership.ts";
import { auditLog, mailOutbox, membership, platformOperator, session, storeInvitation } from "../src/schema.ts";
import { sellerContext } from "../src/platform/scoped.ts";
import { admin, db, makeStore, makeUser, platform, seller } from "./helpers.ts";

// mail_outbox has no FK to the truncated tables, so the shared helper's cascade does not reach it.
beforeEach(() => admin.execute("truncate mail_outbox restart identity"));

const mailer = dbMailer(db);
const acceptUrl = (token: string) => `http://localhost:3000/invite/${token}`;
const passwordHash = await hashPassword("Rahasia-123");

/** Invite through the real service and pull the token back out of the dev outbox (the only place it exists). */
async function invite(scope: Parameters<typeof createInvitation>[0], email: string, role: "owner" | "staff") {
  const id = await createInvitation(scope, mailer, { email, role }, acceptUrl);
  const [mail] = await listOutbox(db, 1);
  const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail!.textBody)![1]!;
  expect(mail!.toEmail).toBe(email.trim().toLowerCase());
  return { id, token };
}

async function makeSession(userId: string) {
  const token = randomUUID();
  await platform.insert(session).values({ id: randomUUID(), token, userId, expiresAt: new Date(Date.now() + 3_600_000) });
  return token;
}

describe("invitations (SC-19/SC-20, IAM-9)", () => {
  it("owner invites by e-mail; a new user accepts once with a password and lands in the store with the invited role", async () => {
    const s = await makeStore("toko-a");
    const { id, token } = await invite(s.owner, "  Baru@Example.com ", "staff");
    expect(await previewInvitation(db, token)).toMatchObject({ status: "pending", email: "baru@example.com", role: "staff", storeName: "Toko toko-a", hasAccount: false });
    expect((await listInvitations(s.owner)).map((i) => [i.id, i.status])).toEqual([[id, "pending"]]);

    const result = await acceptInvitation(db, token, { kind: "new", name: "Baru", passwordHash });
    expect(result).toMatchObject({ storeId: s.storeId, role: "staff", email: "baru@example.com" });
    const ctx = await sellerContext(db, result.userId);
    expect(ctx.ok && { storeId: ctx.scope.storeId, role: ctx.scope.role }).toEqual({ storeId: s.storeId, role: "staff" });

    // Single use: the same link cannot be accepted again, and it no longer lists as pending.
    await expect(acceptInvitation(db, token, { kind: "existing", userId: result.userId })).rejects.toMatchObject({ code: "invite_used" });
    expect(await previewInvitation(db, token)).toMatchObject({ status: "accepted" });
    expect(await listInvitations(s.owner)).toEqual([]);

    const actions = (await platform.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.storeId, s.storeId))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining([`invite.create:${id}:staff`, `invite.accept:${id}:staff`]));
    // Only a hash is persisted.
    expect((await platform.select().from(storeInvitation))[0]!.tokenHash).not.toContain(token);
  });

  it("a bogus token and an expired invitation are both rejected", async () => {
    const s = await makeStore("toko-a");
    expect(await previewInvitation(db, "nope")).toEqual({ status: "invalid" });
    await expect(acceptInvitation(db, "nope", { kind: "new", name: "X Y", passwordHash })).rejects.toMatchObject({ code: "invite_invalid" });

    const { id, token } = await invite(s.owner, "late@example.com", "staff");
    await platform.update(storeInvitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(storeInvitation.id, id));
    expect(await previewInvitation(db, token)).toMatchObject({ status: "expired" });
    await expect(acceptInvitation(db, token, { kind: "new", name: "Late", passwordHash })).rejects.toMatchObject({ code: "invite_expired" });
    expect(INVITATION_TTL_MS).toBe(7 * 24 * 3_600_000);
  });

  it("owner can revoke a pending invitation; a revoked link is dead and a re-invite supersedes the old one", async () => {
    const s = await makeStore("toko-a");
    const first = await invite(s.owner, "x@example.com", "staff");
    await revokeInvitation(s.owner, first.id);
    expect(await previewInvitation(db, first.token)).toMatchObject({ status: "revoked" });
    await expect(acceptInvitation(db, first.token, { kind: "new", name: "X Y", passwordHash })).rejects.toMatchObject({ code: "invite_revoked" });
    await expect(revokeInvitation(s.owner, first.id)).rejects.toMatchObject({ code: "not_found" });

    const second = await invite(s.owner, "x@example.com", "staff");
    const third = await invite(s.owner, "x@example.com", "owner");
    expect(await previewInvitation(db, second.token)).toMatchObject({ status: "revoked" });
    expect((await listInvitations(s.owner)).map((i) => i.id)).toEqual([third.id]);
  });

  it("role authority: staff cannot invite, owners cannot assign unknown roles, existing members are not re-invited", async () => {
    const s = await makeStore("toko-a");
    const staffId = await makeUser("staff");
    await platform.insert(membership).values({ storeId: s.storeId, userId: staffId, role: "staff" });
    const staff = await seller(staffId);
    await expect(createInvitation(staff, mailer, { email: "a@example.com", role: "staff" }, acceptUrl)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listInvitations(staff)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createInvitation(s.owner, mailer, { email: "a@example.com", role: "admin" }, acceptUrl)).rejects.toMatchObject({ name: "ZodError" });
    await expect(createInvitation(s.owner, mailer, { email: "not-an-email", role: "staff" }, acceptUrl)).rejects.toMatchObject({ name: "ZodError" });
    const [staffRow] = await platform.select().from(membership).where(eq(membership.userId, staffId));
    const staffEmail = (await platform.query.user.findFirst({ where: (u, { eq }) => eq(u.id, staffRow!.userId) }))!.email;
    await expect(createInvitation(s.owner, mailer, { email: staffEmail.toUpperCase(), role: "owner" }, acceptUrl)).rejects.toMatchObject({ code: "already_member" });
    expect(await listOutbox(db)).toEqual([]);
  });

  it("invitations cannot cross stores: foreign owners cannot see or revoke them, acceptance grants only the invited store", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const { id, token } = await invite(a.owner, "pindah@example.com", "owner");
    expect(await listInvitations(b.owner)).toEqual([]);
    await expect(revokeInvitation(b.owner, id)).rejects.toMatchObject({ code: "not_found" });

    const { userId } = await acceptInvitation(db, token, { kind: "new", name: "Pindah", passwordHash });
    const rows = await platform.select().from(membership).where(eq(membership.userId, userId));
    expect(rows.map((r) => [r.storeId, r.role])).toEqual([[a.storeId, "owner"]]);
  });

  it("an existing account must match the invited e-mail; a taken e-mail cannot create a second account", async () => {
    const s = await makeStore("toko-a");
    const other = await makeUser("other");
    const otherEmail = (await platform.query.user.findFirst({ where: (u, { eq }) => eq(u.id, other) }))!.email;
    const { token } = await invite(s.owner, otherEmail, "staff");
    expect(await previewInvitation(db, token)).toMatchObject({ status: "pending", hasAccount: true });
    const stranger = await makeUser("stranger");
    await expect(acceptInvitation(db, token, { kind: "existing", userId: stranger })).rejects.toMatchObject({ code: "email_mismatch" });
    await expect(acceptInvitation(db, token, { kind: "new", name: "Dup", passwordHash })).rejects.toMatchObject({ code: "account_exists" });
    await acceptInvitation(db, token, { kind: "existing", userId: other });
    expect((await sellerContext(db, other)) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it("accepting is atomic: two concurrent accepts of one link create exactly one account and one membership", async () => {
    const s = await makeStore("toko-a");
    const { token } = await invite(s.owner, "race@example.com", "staff");
    const settled = await Promise.allSettled([
      acceptInvitation(db, token, { kind: "new", name: "Race 1", passwordHash }),
      acceptInvitation(db, token, { kind: "new", name: "Race 2", passwordHash }),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "invite_used" } });
    const users = await platform.query.user.findMany({ where: (u, { eq }) => eq(u.email, "race@example.com") });
    expect(users).toHaveLength(1);
    expect(await platform.select().from(membership).where(eq(membership.userId, users[0]!.id))).toHaveLength(1);
  });

  it("a validation failure while creating the account leaves no user behind", async () => {
    const s = await makeStore("toko-a");
    const { token } = await invite(s.owner, "short@example.com", "staff");
    await expect(acceptInvitation(db, token, { kind: "new", name: "A", passwordHash })).rejects.toMatchObject({ name: "ZodError" });
    expect(await platform.query.user.findMany({ where: (u, { eq }) => eq(u.email, "short@example.com") })).toEqual([]);
    expect(await previewInvitation(db, token)).toMatchObject({ status: "pending" });
  });
});

describe("membership lifecycle (PR-15, IAM-9)", () => {
  it("a role change or removal applies to the next membership check; removal revokes an orphaned user's sessions", async () => {
    const s = await makeStore("toko-a");
    const staffId = await makeUser("staff");
    await platform.insert(membership).values({ storeId: s.storeId, userId: staffId, role: "staff" });
    await makeSession(staffId);
    await makeSession(staffId);
    expect(await countLiveSessions(db, staffId)).toBe(2);

    await changeMember(s.owner, staffId, "owner");
    expect((await seller(staffId)).role).toBe("owner");
    expect(await countLiveSessions(db, staffId)).toBe(2); // role change keeps the sessions

    await changeMember(s.owner, staffId, null);
    expect(await sellerContext(db, staffId)).toEqual({ ok: false, reason: "no_membership" });
    expect(await countLiveSessions(db, staffId)).toBe(0);
    const actions = (await platform.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.storeId, s.storeId))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining([`member.remove:${staffId}`, `session.revoke:${staffId}`]));
  });

  it("sessions survive removal when the user still belongs to another store or is a platform operator", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    const multi = await makeUser("multi");
    await platform.insert(membership).values([{ storeId: a.storeId, userId: multi, role: "staff" }, { storeId: b.storeId, userId: multi, role: "staff" }]);
    await makeSession(multi);
    await changeMember(a.owner, multi, null);
    expect(await countLiveSessions(db, multi)).toBe(1);

    const opUser = await makeUser("op-member");
    await platform.insert(platformOperator).values({ userId: opUser });
    await platform.insert(membership).values({ storeId: b.storeId, userId: opUser, role: "staff" });
    await makeSession(opUser);
    await changeMember(b.owner, opUser, null);
    expect(await countLiveSessions(db, opUser)).toBe(1);
  });

  it("the dev mailer stores mail instead of sending it", async () => {
    await dbMailer(db).send({ to: "a@example.com", subject: "Halo", text: "Isi" });
    expect(await platform.select().from(mailOutbox)).toMatchObject([{ toEmail: "a@example.com", subject: "Halo", textBody: "Isi" }]);
  });
});
