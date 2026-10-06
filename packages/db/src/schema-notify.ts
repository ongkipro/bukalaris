// M2 `notify` track (T-36, PR-21). Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { order, store } from "./schema.ts";

export const NOTIFY_EVENTS = ["created", "confirmed", "shipped", "cancelled"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];
export const NOTIFY_RECIPIENTS = ["buyer", "seller"] as const;
export type NotifyRecipient = (typeof NOTIFY_RECIPIENTS)[number];

/**
 * One row per e-mail actually handed to the Mailer, written in the same transaction
 * as the mail. The unique key makes a re-run of the job (lost lease, retry after a
 * partial failure) skip addresses that were already notified: at most one mail per
 * order, event and address.
 */
export const orderNotification = pgTable(
  "order_notification",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    orderId: bigint("order_id", { mode: "number" }).notNull(),
    event: text("event", { enum: NOTIFY_EVENTS }).notNull(),
    recipient: text("recipient", { enum: NOTIFY_RECIPIENTS }).notNull(),
    toEmail: text("to_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "order_notification_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    unique("order_notification_uq").on(t.orderId, t.event, t.recipient, t.toEmail),
    check("order_notification_event_chk", sql`${t.event} in ('created', 'confirmed', 'shipped', 'cancelled')`),
    check("order_notification_recipient_chk", sql`${t.recipient} in ('buyer', 'seller')`),
  ],
);
