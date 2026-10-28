// M2 `accounts` track tables (see AGENTS.md "Parallel tracks"). Re-exported by schema.ts.
import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { store, user } from "../schema.ts";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Durable mail intent and body-free delivery outcome; app access is only through registered functions (T-73). */
export const mailOutbox = pgTable("mail_outbox", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  textBody: text("text_body").notNull(),
  /** Optional HTML alternative (order notifications, T-36). */
  htmlBody: text("html_body"),
  oneTimePurpose: text("one_time_purpose", { enum: ["invitation", "recovery", "buyer_proof", "support_recovery"] }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  orderId: bigint("order_id", { mode: "number" }),
  recipient: text("recipient", { enum: ["buyer", "seller"] }),
  deliveryStatus: text("delivery_status", { enum: ["pending", "accepted", "bounced", "failed", "expired"] }).notNull().default("pending"),
  provider: text("provider"),
  providerMessageId: text("provider_message_id"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  bodiesPurgedAt: timestamp("bodies_purged_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  check("mail_outbox_purpose_chk", sql`${t.oneTimePurpose} is null or ${t.oneTimePurpose} in ('invitation', 'recovery', 'buyer_proof', 'support_recovery')`),
  check("mail_outbox_expiry_chk", sql`${t.oneTimePurpose} is null or ${t.expiresAt} is not null`),
  check("mail_outbox_status_chk", sql`${t.deliveryStatus} in ('pending', 'accepted', 'bounced', 'failed', 'expired')`),
  check("mail_outbox_recipient_chk", sql`(${t.orderId} is null and ${t.recipient} is null) or (${t.orderId} is not null and ${t.recipient} in ('buyer', 'seller') and ${t.oneTimePurpose} is null)`),
  check("mail_outbox_purged_chk", sql`${t.bodiesPurgedAt} is null or (${t.textBody} = '' or ${t.textBody} = '[dihapus]') and ${t.htmlBody} is null`),
  index("mail_outbox_expiry_idx").on(t.expiresAt),
]);

/**
 * Store membership invitation (SC-19/SC-20, IAM-9). Only the SHA-256 hash of the
 * single-use token is stored; the token itself travels only in the e-mail link.
 */
export const storeInvitation = pgTable(
  "store_invitation",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    storeId: bigint("store_id", { mode: "number" }).notNull().references(() => store.id),
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "staff"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by").notNull().references(() => user.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedUserId: text("accepted_user_id").references(() => user.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("store_invitation_store_idx").on(t.storeId, t.createdAt),
    check("store_invitation_role_chk", sql`${t.role} in ('owner', 'staff')`),
    check("store_invitation_email_chk", sql`${t.email} = lower(${t.email})`),
  ],
);
