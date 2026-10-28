import { and, eq } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { dbMailer } from "../platform/accounts.ts";
import { surfaceOriginsFromEnv } from "../platform/host.ts";
import { membership, user } from "../schema.ts";
import { subscriptionNotice } from "./schema-billing.ts";

// Automated dunning (UX-18, BILL-7): the SCHEDULE and the MESSAGE INTENTS only. A message is an intent in the durable mail outbox (`mail_enqueue`,
// T-73); real delivery needs the approved provider and sender (PR-21/Q-16), so nothing here, and nothing in the UI, ever says a reminder was
// "sent": the only claim is "queued". Each notice is unique per store, kind and reference (a replayed cycle sends nothing twice) and is
// written in the same transaction as the mail intent, so a failed enqueue leaves no notice and the next run retries.

export type DunningKind = (typeof subscriptionNotice.$inferInsert)["kind"];

const wib = (at: Date) => new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "long", year: "numeric" }).format(at);
const rupiah = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

export type DunningContext = { storeName: string; trialEndsAt: Date; pastDueAt?: Date | null; graceEndsAt?: Date | null; invoice?: { number: string; totalIdr: number; periodStart: string; periodEnd: string } | null };

export function dunningMessage(kind: DunningKind, c: DunningContext): { subject: string; text: string } {
  const link = `${surfaceOriginsFromEnv().appOrigin}/seller/billing`;
  const tail = `\n\nBuka halaman Langganan untuk melihat tagihan dan membayar: ${link}\nData dan toko Anda tetap aman; yang berhenti hanya pengelolaan lewat Seller Admin.`;
  switch (kind) {
    case "trial_ending":
      return { subject: `Masa percobaan ${c.storeName} berakhir ${wib(c.trialEndsAt)}`, text: `Masa percobaan toko ${c.storeName} berakhir pada ${wib(c.trialEndsAt)}. Setelah itu langganan perlu dibayar agar Seller Admin tetap bisa diubah.${tail}` };
    case "invoice_ready":
      return { subject: `Tagihan langganan ${c.storeName} ${c.invoice?.number ?? ""}`.trim(), text: `Tagihan ${c.invoice?.number ?? ""} untuk toko ${c.storeName}, periode ${c.invoice?.periodStart ?? ""} sampai ${c.invoice?.periodEnd ?? ""} (akhir periode tidak termasuk), sebesar ${rupiah(c.invoice?.totalIdr ?? 0)}.${tail}` };
    case "past_due":
      return { subject: `Langganan ${c.storeName} belum dibayar`, text: `Langganan toko ${c.storeName} sudah melewati masa aktif. Seller Admin sekarang hanya bisa dibaca sampai pembayaran selesai. Toko dan checkout pembeli tetap berjalan. Batas masa tenggang: ${c.graceEndsAt ? wib(c.graceEndsAt) : "-"}.${tail}` };
    case "grace_ending":
      return { subject: `Masa tenggang ${c.storeName} segera berakhir`, text: `Masa tenggang langganan toko ${c.storeName} berakhir ${c.graceEndsAt ? wib(c.graceEndsAt) : ""}. Seller Admin tetap hanya bisa dibaca sampai pembayaran selesai.${tail}` };
    case "suspended":
      return { subject: `Langganan ${c.storeName} ditangguhkan`, text: `Masa tenggang langganan toko ${c.storeName} sudah berakhir. Seller Admin hanya bisa dibaca; toko dan checkout pembeli tetap berjalan, dan pembayaran tetap bisa dilakukan kapan saja.${tail}` };
  }
}

/**
 * Queue one dunning notice for a store (the owners' addresses). Returns the number of recipients queued, or null when this
 * (store, kind, ref) notice already exists. Runs inside the caller's store transaction on the platform pool.
 */
export async function queueNotice(tx: Tx, input: { storeId: number; kind: DunningKind; ref: string; context: DunningContext }): Promise<number | null> {
  const owners = await tx
    .select({ email: user.email })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.storeId, input.storeId), eq(membership.role, "owner")));
  const [row] = await tx.insert(subscriptionNotice).values({ storeId: input.storeId, kind: input.kind, ref: input.ref, recipients: owners.length }).onConflictDoNothing().returning({ id: subscriptionNotice.id });
  if (!row) return null;
  const { subject, text } = dunningMessage(input.kind, input.context);
  const mailer = dbMailer(tx);
  for (const o of owners) await mailer.send({ to: o.email, subject, text });
  return owners.length;
}
