import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { order, store } from "../schema.ts";

// Global buyer identity (T-57, ADR-0010 section 3, DATA-4, DATA-12). Platform-owned: none of these tables has an owning
// `store_id`; `buyer_order_link.store_id` and `buyer_identity_event.store_id` are provenance and the compound foreign key that
// ties a link to its seller order, never a tenancy key. Isolation class `buyer` (isolation-registry.ts): own-buyer row-level
// security on the transaction-local `app.buyer_id`, written only by the SECURITY DEFINER resolver `buyer_resolve_order`.
// The policies, grants, guards, SQL normalization port and resolver are in the T-57 section of the migration.
//
// Association is not verification: nothing here marks an identifier verified or bound at checkout, and no column copies an
// order's contact or amounts.

const BUYER_STATUSES = ["provisional", "active", "restricted", "closed"] as const;
const IDENTIFIER_KINDS = ["phone", "email"] as const;
const BINDING_STATES = ["observed", "bound", "disputed", "revoked"] as const;
const RESOLUTION_METHODS = ["phone", "email", "created"] as const;
const ACCESS_STATES = ["unverified", "confirmed", "restricted"] as const;
export const BUYER_EVENT_TYPES = [
  "buyer_created",
  "order_linked",
  "identifier_observed",
  "phone_email_conflict",
  "email_phone_mismatch",
  "identifier_bound",
  "link_confirmed",
  "identity_restricted",
  "merge_requested",
  "merge_completed",
] as const;
export type BuyerEventType = (typeof BUYER_EVENT_TYPES)[number];
const ACTOR_TYPES = ["system", "buyer", "operator"] as const;

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
/** Canonical forms: the same patterns as `CANONICAL_PHONE_RE` and the e-mail validator of `normalize.ts` (a database check, not only a service rule). */
const CANONICAL_PHONE_SQL = sql.raw(`'^628[0-9]{7,12}$'`);
const CANONICAL_EMAIL_SQL = sql.raw(`'^(?:[A-Za-z0-9_''+-]+\\.)*[A-Za-z0-9_''+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\\.)+[A-Za-z]{2,}$'`);

export const buyer = pgTable(
  "buyer",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    status: text("status", { enum: BUYER_STATUSES }).notNull().default("provisional"),
    /** Buyer-managed. Never written from checkout data. */
    displayName: text("display_name"),
    /** The phone that anchors the account: same-buyer FK, kind `phone` (guard trigger), nullable. */
    primaryPhoneIdentifierId: bigint("primary_phone_identifier_id", { mode: "number" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    closedAt: timestamptz("closed_at"),
  },
  (t) => [
    foreignKey({ name: "buyer_primary_phone_fk", columns: [t.id, t.primaryPhoneIdentifierId], foreignColumns: [buyerIdentifier.buyerId, buyerIdentifier.id] }),
    check("buyer_status_chk", sql`${t.status} in (${quoted(BUYER_STATUSES)})`),
    check("buyer_closed_chk", sql`(${t.closedAt} is not null) = (${t.status} = 'closed')`),
    check("buyer_display_name_chk", sql`${t.displayName} is null or char_length(${t.displayName}) between 1 and 120`),
  ],
);

export const buyerIdentifier = pgTable(
  "buyer_identifier",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    buyerId: bigint("buyer_id", { mode: "number" }).notNull().references((): AnyPgColumn => buyer.id),
    kind: text("kind", { enum: IDENTIFIER_KINDS }).notNull(),
    /** Sensitive restricted data, never a public lookup key. Phone `628…`, e-mail trimmed lower case (normalize.ts). */
    canonicalValue: text("canonical_value").notNull(),
    /** Set only after a valid proof of possession (T-58). Checkout never sets it. */
    verifiedAt: timestamptz("verified_at"),
    bindingState: text("binding_state", { enum: BINDING_STATES }).notNull().default("observed"),
    /** Set only with the authorized account binding (T-58). Checkout never sets it. */
    accountBoundAt: timestamptz("account_bound_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    // Global, including unverified observations and revoked rows: reuse of a revoked identifier is OPEN (recycling policy).
    unique("buyer_identifier_value_uq").on(t.kind, t.canonicalValue),
    unique("buyer_identifier_buyer_id_uq").on(t.buyerId, t.id),
    // One live phone per buyer.
    uniqueIndex("buyer_identifier_live_phone_uq").on(t.buyerId).where(sql`${t.kind} = 'phone' and ${t.bindingState} <> 'revoked'`),
    index("buyer_identifier_buyer_idx").on(t.buyerId),
    check("buyer_identifier_kind_chk", sql`${t.kind} in (${quoted(IDENTIFIER_KINDS)})`),
    check("buyer_identifier_binding_chk", sql`${t.bindingState} in (${quoted(BINDING_STATES)})`),
    check(
      "buyer_identifier_value_chk",
      sql`(${t.kind} = 'phone' and ${t.canonicalValue} ~ ${CANONICAL_PHONE_SQL}) or (${t.kind} = 'email' and ${t.canonicalValue} ~ ${CANONICAL_EMAIL_SQL} and ${t.canonicalValue} !~ '[A-Z]' and char_length(${t.canonicalValue}) <= 254)`,
    ),
    // Observed = no proof, no binding; bound = proof and binding; a binding time never exists without a proof time; revoked_at marks exactly `revoked`.
    check("buyer_identifier_proof_chk", sql`(${t.bindingState} <> 'observed' or (${t.verifiedAt} is null and ${t.accountBoundAt} is null)) and (${t.bindingState} <> 'bound' or (${t.verifiedAt} is not null and ${t.accountBoundAt} is not null)) and (${t.accountBoundAt} is null or ${t.verifiedAt} is not null)`),
    check("buyer_identifier_revoked_chk", sql`(${t.revokedAt} is not null) = (${t.bindingState} = 'revoked')`),
  ],
);

export const buyerOrderLink = pgTable(
  "buyer_order_link",
  {
    buyerId: bigint("buyer_id", { mode: "number" }).notNull().references(() => buyer.id),
    /** Provenance and the compound foreign key to the seller order; not a seller grant to this row. */
    storeId: bigint("store_id", { mode: "number" }).notNull(),
    orderId: bigint("order_id", { mode: "number" }).notNull(),
    resolvedIdentifierId: bigint("resolved_identifier_id", { mode: "number" }).notNull(),
    resolutionMethod: text("resolution_method", { enum: RESOLUTION_METHODS }).notNull(),
    accessState: text("access_state", { enum: ACCESS_STATES }).notNull().default("unverified"),
    linkedAt: timestamptz("linked_at").notNull().defaultNow(),
    confirmedAt: timestamptz("confirmed_at"),
  },
  (t) => [
    primaryKey({ name: "buyer_order_link_pk", columns: [t.storeId, t.orderId] }),
    foreignKey({ name: "buyer_order_link_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    foreignKey({ name: "buyer_order_link_identifier_fk", columns: [t.buyerId, t.resolvedIdentifierId], foreignColumns: [buyerIdentifier.buyerId, buyerIdentifier.id] }),
    index("buyer_order_link_buyer_idx").on(t.buyerId, t.linkedAt),
    check("buyer_order_link_method_chk", sql`${t.resolutionMethod} in (${quoted(RESOLUTION_METHODS)})`),
    check("buyer_order_link_access_chk", sql`${t.accessState} in (${quoted(ACCESS_STATES)})`),
    check("buyer_order_link_confirmed_chk", sql`(${t.confirmedAt} is not null) = (${t.accessState} = 'confirmed')`),
  ],
);

/** Append-only (trigger, no UPDATE/DELETE privilege): no raw contact, OTP, link or address ever goes in a row. */
export const buyerIdentityEvent = pgTable(
  "buyer_identity_event",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    buyerId: bigint("buyer_id", { mode: "number" }).notNull().references(() => buyer.id),
    storeId: bigint("store_id", { mode: "number" }).references(() => store.id),
    orderId: bigint("order_id", { mode: "number" }),
    eventType: text("event_type", { enum: BUYER_EVENT_TYPES }).notNull(),
    /** The other buyer of a conflict, mismatch or merge; internal only. */
    relatedBuyerId: bigint("related_buyer_id", { mode: "number" }).references(() => buyer.id),
    actorType: text("actor_type", { enum: ACTOR_TYPES }).notNull(),
    actorId: text("actor_id"),
    requestId: text("request_id"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "buyer_identity_event_order_fk", columns: [t.storeId, t.orderId], foreignColumns: [order.storeId, order.id] }),
    index("buyer_identity_event_buyer_idx").on(t.buyerId, t.createdAt),
    index("buyer_identity_event_order_idx").on(t.storeId, t.orderId),
    check("buyer_identity_event_type_chk", sql`${t.eventType} in (${quoted(BUYER_EVENT_TYPES)})`),
    check("buyer_identity_event_actor_chk", sql`${t.actorType} in (${quoted(ACTOR_TYPES)}) and (${t.actorId} is null or char_length(${t.actorId}) <= 120) and (${t.requestId} is null or char_length(${t.requestId}) <= 120)`),
    // A conflict, mismatch or merge names the other buyer; no other event does. An order needs its store.
    check(
      "buyer_identity_event_related_chk",
      sql`((${t.eventType} in ('phone_email_conflict', 'email_phone_mismatch', 'merge_requested', 'merge_completed')) = (${t.relatedBuyerId} is not null)) and (${t.relatedBuyerId} is null or ${t.relatedBuyerId} <> ${t.buyerId})`,
    ),
    check("buyer_identity_event_order_chk", sql`${t.orderId} is null or ${t.storeId} is not null`),
  ],
);

/** Buyer-managed address book (written by the buyer portal, T-58). Checkout addresses stay order snapshots and are never copied here. */
export const buyerAddress = pgTable(
  "buyer_address",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    buyerId: bigint("buyer_id", { mode: "number" }).notNull().references(() => buyer.id),
    label: text("label").notNull(),
    recipientName: text("recipient_name").notNull(),
    phoneCanonical: text("phone_canonical").notNull(),
    addressText: text("address_text").notNull(),
    destinationAreaId: text("destination_area_id").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("buyer_address_default_uq").on(t.buyerId).where(sql`${t.isDefault}`),
    index("buyer_address_buyer_idx").on(t.buyerId),
    check("buyer_address_text_chk", sql`char_length(${t.label}) between 1 and 60 and char_length(${t.recipientName}) between 2 and 120 and char_length(${t.addressText}) between 10 and 500`),
    check("buyer_address_phone_chk", sql`${t.phoneCanonical} ~ ${CANONICAL_PHONE_SQL}`),
    check("buyer_address_area_chk", sql`${t.destinationAreaId} ~ '^[a-f0-9]{24}$'`),
  ],
);
