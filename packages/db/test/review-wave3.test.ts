import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openCase } from "../src/ops/accounts-governance-cases.ts";
import { limitStepUpAttempts, refundStepUpAttempt, STEP_UP_ATTEMPT_LIMITS } from "../src/ledger/stepup.ts";
import { startSupportRecovery } from "../src/ops/accounts-governance-support.ts";
import { supportRecoveryLink } from "../src/ops/schema-governance.ts";
import { session, user } from "../src/schema.ts";
import { admin, makeOperator, makeStore, makeUser, platform } from "./helpers.ts";

// Independent review of wave 3 (2026-10-28): every case is a failure scenario the review described. The platform login is what a
// compromised worker or Owner-console process would hold; the definer functions must not let it skip a second person.

const pgCode = (p: Promise<unknown>) => p.then(() => "allowed", (e: { cause?: { code?: string }; code?: string }) => e.cause?.code ?? e.code);

beforeEach(async () => {
  await admin.execute(sql`truncate support_case, support_case_note, account_status_event, account_verification, store_risk_ack, support_action, access_review_decision, support_recovery_link, personal_data_access_event restart identity cascade`).catch(() => {});
});

async function memberWithSession(slug: string, role: "owner" | "staff") {
  const s = await makeStore(slug);
  const userId = role === "owner" ? s.ownerId : await makeUser(`${slug}-anggota`);
  if (role === "staff") await admin.execute(sql`insert into membership (store_id, user_id, role) values (${s.storeId}, ${userId}, 'staff')`);
  await admin.update(user).set({ emailVerified: true }).where(eq(user.id, userId));
  await admin.insert(session).values({ id: randomUUID(), userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  return { ...s, userId };
}

describe("T-63: a compromised platform login cannot mint a recovery link or skip four-eyes on a second-factor reset", () => {
  it("the platform login cannot INSERT a recovery link, and the creation function refuses a forged actor, user or action", async () => {
    const victim = await memberWithSession("toko-korban", "staff");
    const support = await makeOperator(["accounts.support", "cases.read", "cases.write"]);
    const holder = await makeOperator(["accounts.support"]);
    expect(await pgCode(platform.insert(supportRecoveryLink).values({ tokenSha256: "a".repeat(64), userId: victim.userId, supportActionId: 1, expiresAt: new Date(Date.now() + 3_600_000) }))).toBe("42501");
    const c = await openCase(support, { subjectKind: "user", subjectId: victim.userId, title: "bantuan akun", reason: "pelapor meminta bantuan" });
    const act = await startSupportRecovery(support, victim.userId, { caseRef: c.id, reasonCode: "locked_out", reason: "seller kehilangan akses", idempotencyKey: `k-${randomUUID()}` });
    // The real action exists. A different operator (even one holding accounts.support) cannot attach a link to it, and neither can a made-up actor.
    const create = (actor: string, action: number, target: string) =>
      platform.execute(sql`select support_recovery_create(${actor}, ${action}::bigint, ${target}, ${"b".repeat(64)}, now() + interval '1 hour')`);
    expect(await pgCode(create(holder.userId, act.supportActionId, victim.userId))).toBe("42501");
    expect(await pgCode(create("not-an-operator", act.supportActionId, victim.userId))).toBe("42501");
    expect(await pgCode(create(support.userId, act.supportActionId, (await memberWithSession("toko-lain", "staff")).userId))).toBe("42501"); // another user than the action's subject
    expect((await admin.select().from(supportRecoveryLink)).length).toBe(1); // only the legitimate link from startSupportRecovery
  });

  it("console_reset_user_mfa refuses a store owner and a staff identity without an executed four-eyes approval, even with a real capability holder as actor", async () => {
    const owner = await memberWithSession("toko-pemilik", "owner");
    const supportActor = await makeOperator(["accounts.support"]);
    const staffTarget = await makeOperator(["dashboard.read"]);
    const staffManager = await makeOperator(["staff.manage"]);
    const reset = (actor: string, target: string, capability: string) => platform.execute(sql`select console_reset_user_mfa(${actor}, ${target}, ${capability})`);
    expect(await pgCode(reset(supportActor.userId, owner.userId, "accounts.support"))).toBe("42501");
    expect(await pgCode(reset(staffManager.userId, staffTarget.userId, "staff.manage"))).toBe("42501");
    // A seller team member who is not an owner still resets with one approver (notice sent): the function allows it.
    const member = await memberWithSession("toko-anggota", "staff");
    expect(await pgCode(reset(supportActor.userId, member.userId, "accounts.support"))).toBe("allowed");
  });
});

describe("T-63: a case without a subject authorises no target", () => {
  it("one generic case cannot be cited to act on an account", async () => {
    const victim = await memberWithSession("toko-korban", "staff");
    const support = await makeOperator(["accounts.support", "cases.read", "cases.write"]);
    const generic = await openCase(support, { title: "kasus umum tanpa subjek", reason: "pelapor menghubungi dukungan" });
    await expect(startSupportRecovery(support, victim.userId, { caseRef: generic.id, reasonCode: "locked_out", reason: "memakai kasus umum", idempotencyKey: `k-${randomUUID()}` })).rejects.toMatchObject({ code: "case_mismatch" });
    expect((await admin.select().from(supportRecoveryLink)).length).toBe(0);
  });
});

describe("T-37: the step-up code cannot be guessed without limit from a stolen owner session (review of the finish build, P2)", () => {
  it("the sixth attempt inside the window is refused with rate_limited, whether or not the code is right, and another user is unaffected", async () => {
    const s = await makeStore("toko-limit");
    const other = await makeStore("toko-lain-limit");
    for (let i = 0; i < STEP_UP_ATTEMPT_LIMITS.user.limit; i++) await limitStepUpAttempts(s.owner);
    await expect(limitStepUpAttempts(s.owner)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(limitStepUpAttempts(s.owner)).rejects.toMatchObject({ code: "rate_limited" }); // still locked: a correct code during the lockout is refused too
    await expect(limitStepUpAttempts(other.owner)).resolves.toBeUndefined();
  });

  it("only FAILED codes accumulate: correct codes give their slot back, so a legitimate owner is never locked out, and parallel guesses cannot exceed the limit", async () => {
    const s = await makeStore("toko-benar");
    for (let i = 0; i < STEP_UP_ATTEMPT_LIMITS.user.limit * 3; i++) {
      await limitStepUpAttempts(s.owner);
      await refundStepUpAttempt(s.owner); // the code was right
    }
    await expect(limitStepUpAttempts(s.owner)).resolves.toBeUndefined();
    const t = await makeStore("toko-tebak");
    const parallel = await Promise.allSettled(Array.from({ length: 30 }, () => limitStepUpAttempts(t.owner)));
    expect(parallel.filter((r) => r.status === "fulfilled")).toHaveLength(STEP_UP_ATTEMPT_LIMITS.user.limit); // 30 parallel wrong guesses: only 5 get through
  });
});
