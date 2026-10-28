import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../../client.ts";
import { mailOutbox } from "../../schema.ts";
import { configuredMailTransport, requireMailConfiguration, type MailDeliveryResult } from "../../platform/mail-transport.ts";
import { markDispatched, registerPlatformHandler, type JobContext, type Job } from "./jobs.ts";
import { registerReconciler } from "./manage.ts";
import { registerSchedule } from "./scheduler.ts";

export const MAIL_DELIVER = "mail.deliver";
export const MAIL_PURGE = "mail.purge";
const payload = z.strictObject({ mailId: z.number().int().positive() });
const resultSchema = z.strictObject({ status: z.enum(["accepted", "bounced", "failed"]), messageId: z.string().min(1).max(254).regex(/^[A-Za-z0-9._:@/+-]+$/) });

/** Body-free outcome boundary. An authenticated provider adapter calls this for a later bounce too (Q-16). */
export async function recordMailDeliveryResult(exec: Executor, mailId: number, provider: string, raw: MailDeliveryResult): Promise<void> {
  const result = resultSchema.parse(raw);
  await exec.transaction(async (tx) => {
    const [mail] = await tx.select().from(mailOutbox).where(eq(mailOutbox.id, mailId)).for("update");
    if (!mail || mail.provider !== provider || (mail.providerMessageId !== null && mail.providerMessageId !== result.messageId)) throw new Error("mail delivery result binding mismatch");
    if (mail.deliveryStatus === result.status && mail.providerMessageId === result.messageId) return;
    if (mail.deliveryStatus !== "pending" && !(mail.deliveryStatus === "accepted" && result.status === "bounced")) throw new Error("invalid mail delivery result transition");
    await tx.update(mailOutbox).set({
      deliveryStatus: result.status, providerMessageId: result.messageId,
      deliveredAt: result.status === "accepted" ? sql`now()` : mail.deliveredAt,
      textBody: "", htmlBody: null, bodiesPurgedAt: sql`now()`,
    }).where(eq(mailOutbox.id, mailId));
  });
}

/** The rule is delivery OR actual link expiry, not an invented retention duration. Database clock only. */
export async function purgeExpiredMailBodies(exec: Executor, batch = 1000): Promise<number> {
  const [row] = await exec.execute<{ n: number }>(sql`select public.mail_purge_expired(${batch})::int as n`);
  return row?.n ?? 0;
}

export async function deliverMailJob({ db }: JobContext, j: Job & { storeId: null }): Promise<void> {
  const { mailId } = payload.parse(j.payload);
  const config = requireMailConfiguration();
  const transport = configuredMailTransport(config);
  // Local outbox is an inspection sink, NOT proof of accepted delivery. Bodies expire at the link's own TTL.
  if (config.mode === "local" || !transport) return;
  await purgeExpiredMailBodies(db);
  const [mail] = await db.select().from(mailOutbox).where(and(eq(mailOutbox.id, mailId), eq(mailOutbox.deliveryStatus, "pending"), sql`(${mailOutbox.expiresAt} is null or ${mailOutbox.expiresAt} > now())`));
  if (!mail || mail.bodiesPurgedAt) return;
  // Fence commits before the external call. Crashes/timeouts become unknown; no automatic re-dispatch.
  await markDispatched(db, j);
  await db.update(mailOutbox).set({ provider: config.provider }).where(eq(mailOutbox.id, mailId));
  let result: MailDeliveryResult;
  try {
    result = await transport.send({
      idempotencyKey: `mail:${mail.id}`, from: config.from, to: mail.toEmail,
      subject: mail.subject, text: mail.textBody, ...(mail.htmlBody === null ? {} : { html: mail.htmlBody }),
    }, { signal: AbortSignal.timeout(config.timeoutMs) });
    // Validate inside the scrubbed boundary: even malformed provider output must not leak message content into jobs.
    result = resultSchema.parse(result);
  } catch {
    throw new Error("mail transport outcome unknown; reconcile before redispatch");
  }
  await recordMailDeliveryResult(db, mailId, config.provider, result);
}

registerPlatformHandler(MAIL_DELIVER, deliverMailJob, { priority: 1, replaySafe: false });
registerPlatformHandler(MAIL_PURGE, async ({ db }) => { await purgeExpiredMailBodies(db); }, { replaySafe: true });
registerSchedule({ kind: MAIL_PURGE, period: "minute", catchUp: 0 });
/** A crash after the body-free result was recorded but before the job was completed settles to done; anything else needs an operator. */
registerReconciler(MAIL_DELIVER, async (db, j) => {
  const { mailId } = payload.parse(j.payload);
  const [mail] = await db.select({ status: mailOutbox.deliveryStatus }).from(mailOutbox).where(eq(mailOutbox.id, mailId));
  return mail && mail.status !== "pending" ? "done" : "unknown";
});
