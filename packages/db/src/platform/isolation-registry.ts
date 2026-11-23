// Per-table isolation registry (ADR-0005 amendment, T-59, SEC-23). The single place that says
// what class every table is in, which policy it must carry and which privileges each login
// role may hold. packages/db/test/rls.test.ts, scripts/verify-docker.sh and
// scripts/db-restore-rehearsal.sh derive their assertions from it (the shell scripts through
// `node packages/db/src/isolation-print.ts`); nothing counts policies by hand.
//
// A migration that creates a table adds its entry in the same change: the invariant test fails
// for a table that is not here and for an entry whose table does not exist.

export type IsolationClass = "tenant" | "buyer" | "affiliate" | "platform" | "shared-read" | "restricted" | "auth";

/**
 * Classes:
 * - tenant: seller-owned rows. ENABLE + FORCE RLS, policy `tenant_isolation` on the store key
 *   (`store_id`, or `id` on the tenant root `store`). `audit_log` is the one variant: it also
 *   admits store-less inserts from the named writers in `AUDIT_STORELESS_WRITERS`.
 * - buyer: one global buyer's rows. FORCE RLS, `buyer_isolation` on `app.buyer_id`; a `store_id`
 *   column is provenance, never the tenancy key. (No table yet: ADR-0010.)
 * - affiliate: one affiliate's rows. FORCE RLS, `affiliate_isolation` on `app.affiliate_id`. (No table yet: ADR-0009.)
 * - platform: platform-owned rows without a tenant key. No policy; `bukalaris_app` holds only the
 *   privileges listed here (often none).
 * - shared-read: the same rows for every tenant. No policy; the app role may only SELECT.
 * - restricted: platform tables owned by the no-login role `bukalaris_restricted`. Neither
 *   `bukalaris_app` nor `bukalaris_platform` holds any privilege; access is only through the
 *   SECURITY DEFINER functions of `DEFINER_FUNCTIONS`. (No table yet: the first ones arrive with
 *   T-60 and T-37; the mechanism is proven by a scratch table in test/rls.test.ts.)
 * - auth: the Better Auth tables. No policy; the app role runs the auth adapter on them. The
 *   operator identity moves to separate operator tables (class `restricted`) in T-59b; these five
 *   stay shared by seller, affiliate and buyer identities until then.
 */
export type Privileges = string; // canonical "SELECT,INSERT,UPDATE,DELETE" subset, "" for none

export interface TableEntry {
  class: IsolationClass;
  /** Column the policy compares: `store_id` (tenant), `id` on `store`, `buyer_id`, `affiliate_id`. */
  key?: string;
  /** Policy variant for the tenant class; default is the plain key policy. */
  policy?: "audit-writers";
  /** Privileges `bukalaris_app` holds on the table. */
  app: Privileges;
  /** Column-level grants of `bukalaris_app` beyond the table-level ones. */
  appColumns?: Record<string, Privileges>;
  /** Column-level grants of `bukalaris_platform` beyond the table-level ones (T-106: the payment-ring re-seal writes four envelope columns only). */
  platformColumns?: Record<string, Privileges>;
  /**
   * Privileges `bukalaris_platform` needs for the production paths that run on the platform pool
   * (Owner console, worker, cleanup, named services). The expand step grants them next to the
   * old table-wide grants; the contract step (drizzle-pending/t59-contract.sql) leaves only these.
   */
  platform: Privileges;
}

const tenant = (app: Privileges, platform: Privileges, key = "store_id"): TableEntry => ({ class: "tenant", key, app, platform });
/** Column grants listed by privilege set, emitted in the catalog's column order (as `pg_attribute` names sort). */
const columnGrants = (byPrivileges: Record<Privileges, string[]>): Record<string, Privileges> =>
  Object.fromEntries(Object.entries(byPrivileges).flatMap(([p, columns]) => columns.map((c) => [c, p] as const)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export const ISOLATION_REGISTRY: Record<string, TableEntry> = {
  // ── tenant: store policy ──────────────────────────────────────────────────────────────────
  // T-81: settings only; identity and lifecycle belong to the platform writer, not a tenant UPDATE.
  store: { ...tenant("SELECT", "SELECT,INSERT,UPDATE", "id"), appColumns: Object.fromEntries(["description", "name", "theme", "whatsapp"].map((column) => [column, "UPDATE"])) },
  membership: tenant("SELECT,INSERT,UPDATE,DELETE", "SELECT,INSERT"),
  store_invitation: tenant("SELECT,INSERT,UPDATE", ""),
  product: tenant("SELECT,INSERT,UPDATE", "SELECT"),
  variant: tenant("SELECT,INSERT,UPDATE", "SELECT"),
  collection: tenant("SELECT,INSERT,UPDATE", "SELECT"), // platform: the Owner console store detail counts them
  page: tenant("SELECT,INSERT,UPDATE", "SELECT"),
  store_pickup_area: tenant("SELECT,INSERT,UPDATE", "SELECT"), // T-48 worker uses this store's pickup, never a shared platform pickup
  product_slug_alias: tenant("SELECT,INSERT,DELETE", ""),
  collection_product: tenant("SELECT,INSERT,DELETE", ""),
  media: tenant("SELECT,INSERT,UPDATE,DELETE", "SELECT"),
  catalog_audit: tenant("SELECT,INSERT", ""),
  cart: tenant("SELECT,INSERT", "SELECT,DELETE"),
  cart_line: tenant("SELECT,INSERT,UPDATE,DELETE", ""),
  order: tenant("SELECT,INSERT,UPDATE", "SELECT,UPDATE"),
  order_line: tenant("SELECT,INSERT", "SELECT"),
  order_status_history: tenant("SELECT,INSERT", "SELECT,INSERT"),
  stock_adjustment: tenant("SELECT,INSERT", ""),
  storefront_channel: tenant("SELECT,INSERT,UPDATE", ""),
  checkout_handoff: tenant("SELECT,INSERT,UPDATE", ""),
  job: tenant("SELECT,INSERT", "SELECT,INSERT,UPDATE"),
  signal_destination: tenant("SELECT,INSERT,UPDATE", "SELECT"),
  signal_event: tenant("SELECT,INSERT,UPDATE", "SELECT,INSERT,UPDATE"), // app UPDATE: T-43 redaction strips the user block; platform INSERT: the payment verification enqueues the prepaid Purchase (T-49)
  order_signal_context: tenant("SELECT,INSERT,DELETE", "SELECT,DELETE"), // app DELETE: T-43 redaction
  order_notification: tenant("SELECT,UPDATE", "SELECT,INSERT,UPDATE"), // app: T-43 redaction reads recipients and overwrites the buyer address
  order_redaction: tenant("SELECT,INSERT", "SELECT,INSERT"),
  feed_token: tenant("SELECT,INSERT,UPDATE", ""),
  shipment: tenant("SELECT,INSERT,UPDATE", "SELECT,UPDATE"), // app: requests and counters; results come from the worker
  // T-104: the app role inserts (five columns of an empty row) and updates only its own `seller_owned` row (provider_account_guard) and never
  // reads a sealed column; the envelope comes only from provider_key_envelope(). Columns in catalog order (attname), each with its exact privileges.
  store_shipping_account: { class: "tenant", key: "store_id", app: "", appColumns: columnGrants({ SELECT: ["id"], INSERT: ["external_user_id"], "SELECT,INSERT": ["kind", "store_id"], "SELECT,INSERT,UPDATE": ["environment", "status"], UPDATE: ["key_id", "sealed_at", "sealed_key", "step_up_ref", "updated_at"], "SELECT,UPDATE": ["key_fingerprint", "key_hint", "last_checked_at", "last_result", "pickup_address_id", "pickup_registered_at", "revision"] }), platform: "SELECT,UPDATE" },
  // T-104: the store's own AutoLaris account, same rules; the platform pool reads only (the T-106 worker), the owner-side demo reset deletes.
  // T-106: + the seller's preferences (enabled, excluded_channels, fee_bearer); platform column UPDATE on the four envelope columns for the payment-ring re-seal (JOB-23).
  store_payment_account: { class: "tenant", key: "store_id", app: "", appColumns: columnGrants({ SELECT: ["id"], "SELECT,INSERT": ["store_id"], "SELECT,INSERT,UPDATE": ["environment", "status"], UPDATE: ["key_id", "payment_only_confirmed_by", "sealed_at", "sealed_key", "step_up_ref", "updated_at"], "SELECT,UPDATE": ["destination_area_id", "enabled", "excluded_channels", "fee_bearer", "key_fingerprint", "key_hint", "last_checked_at", "last_result", "origin_area_id", "payment_only_confirmed_at", "revision", "sender_address", "shipper_email"] }), platform: "SELECT", platformColumns: columnGrants({ UPDATE: ["key_fingerprint", "key_id", "sealed_at", "sealed_key"] }) },
  // T-105 (ADR-0013 section 4): the seller's courier filters and COD settings, read again at order submit. The worker only switches a courier's COD
  // off after a provider refusal (UPDATE on the rules); the Owner console reads both for support.
  store_courier_rule: tenant("SELECT,INSERT,UPDATE", "SELECT,UPDATE"),
  store_shipping_setting: tenant("SELECT,INSERT,UPDATE", "SELECT"),
  // T-115 (ADR-0013 section 11): the parcel's Mengantar status history (written by the single writer on the platform pool, append-only), the
  // verified webhook deliveries (written by the webhook route on the app pool, never applied), foreign parcels (found by the account scan; the
  // seller only resolves them) and the store's link with its own account (dedicated-account confirmation, sealed Webhook Secret, the balance and
  // invoice mirror). The app role never reads the sealed secret, its key id or its step-up reference: provider_key_envelope() opens it.
  shipment_status_event: tenant("SELECT", "SELECT,INSERT"),
  shipping_webhook_event: tenant("SELECT,INSERT", "SELECT"),
  shipping_foreign_parcel: { class: "tenant", key: "store_id", app: "SELECT", appColumns: columnGrants({ UPDATE: ["resolution_note", "resolved_at", "resolved_by"] }), platform: "SELECT,INSERT,UPDATE" },
  store_shipping_sync: { class: "tenant", key: "store_id", app: "", appColumns: columnGrants({ "SELECT,INSERT": ["hook_id", "store_id"], SELECT: ["account_read_at", "balance_idr", "invoices", "last_scan_at", "scan_error"], "SELECT,UPDATE": ["dedicated_confirmed_at", "dedicated_confirmed_by", "dedicated_environment", "dedicated_fingerprint", "last_webhook_at", "revision", "updated_at", "webhook_environment", "webhook_fingerprint", "webhook_sealed_at"], UPDATE: ["sealed_webhook_secret", "step_up_ref", "webhook_key_id"] }), platform: "SELECT,INSERT,UPDATE" },
  landing_page: tenant("SELECT,INSERT,UPDATE", ""),
  landing_page_revision: tenant("SELECT,INSERT", ""), // immutable snapshots
  // T-49 AutoLaris payment contract (migration 0012). The app role creates the attempt at checkout and the callback evidence; the worker owns every later write.
  payment_attempt: tenant("SELECT,INSERT", "SELECT,INSERT,UPDATE"), // identity and amounts immutable, `paid` monotonic (payment_attempt_guard)
  payment_attempt_event: tenant("SELECT,INSERT", "SELECT,INSERT"), // append-only
  // raw body blanked only by redact_payment_callbacks(); never deleted; the app role inserts and reads only the non-body columns
  payment_callback: { class: "tenant", key: "store_id", app: "INSERT", appColumns: Object.fromEntries(["attempt_id", "body_sha256", "body_shape", "created_at", "id", "quarantined", "redacted_at", "store_id"].map((column) => [column, "SELECT"])), platform: "SELECT" },
  payment_observation: tenant("", "SELECT,INSERT"), // append-only record of every provider inquiry; the seller never reads it
  late_payment_obligation: tenant("", "SELECT,INSERT"), // buyer refund obligation of a payment verified after the order was cancelled
  // T-106 (ADR-0013 decisions 24 and 27): the seller's manual confirmation (one append-only record per attempt, written by the seller on the app pool) and
  // the payment anomalies raised for the seller (by the worker's status check or by a manual confirmation). Both append-only (trigger), never deleted but by the demo reset.
  payment_manual_confirmation: tenant("SELECT,INSERT", "SELECT"),
  payment_anomaly: tenant("SELECT,INSERT", "SELECT,INSERT"),
  // T-113 (ADR-0013 section 10): the store's bank accounts (listed and removed by the owner with a step-up; the removal stamp is the only change), its
  // bank-transfer switch, the frozen destinations of an order, the buyer's proof (decided by the seller; the files purged by the cleanup on the platform
  // pool) and the seller's confirmation record (append-only).
  store_bank_account: { ...tenant("SELECT,INSERT", "SELECT"), appColumns: columnGrants({ UPDATE: ["removal_step_up_ref", "removed_at", "removed_by"] }) },
  store_bank_transfer: tenant("SELECT,INSERT,UPDATE", "SELECT"),
  order_bank_transfer: tenant("SELECT,INSERT", "SELECT"), // immutable (payment_evidence_guard)
  payment_proof: { ...tenant("SELECT,INSERT", "SELECT"), appColumns: columnGrants({ UPDATE: ["decided_at", "decided_by", "reject_reason", "status"] }), platformColumns: columnGrants({ UPDATE: ["files", "files_purged_at"] }) },
  bank_transfer_confirmation: tenant("SELECT,INSERT", "SELECT"), // append-only (payment_evidence_guard)
  // T-116: store owner's acceptance of versioned seller terms (append-only, owner membership verified by guard).
  store_terms_acceptance: tenant("SELECT,INSERT", "SELECT"),
  // T-112: digital product access links, plain-text access note, and per-line buyer grants (FORCE RLS; never exposed publicly).
  product_access_item: tenant("SELECT,INSERT,UPDATE,DELETE", "SELECT"),
  product_access_note: tenant("SELECT,INSERT,UPDATE,DELETE", "SELECT"),
  digital_grant: tenant("SELECT,INSERT,UPDATE", "SELECT,INSERT,UPDATE"),
  // T-37 seller ledger, payouts and refunds (migration 0013). Credits, releases and settlement are the platform pool's; the app login can only DEBIT its own
  // balance (ledger_entry_insert_guard), request payouts, keep its destination, submit a refund destination and consume its own step-up proof.
  order_financials: tenant("SELECT,INSERT", "SELECT,INSERT"), // immutable (financial_snapshot_guard); platform INSERT: local seeds call placeOrder on the platform pool
  order_seller_refund: tenant("SELECT,INSERT", "SELECT"), // T-107: the seller records a refund made outside Bukalaris; append-only (payment_evidence_guard), sum bound by order_seller_refund_guard
  order_line_financials: tenant("SELECT,INSERT", "SELECT,INSERT"),
  shipment_cost: tenant("SELECT", "SELECT,INSERT"), // append-once, booked by the worker before any provider write
  ledger_entry: tenant("SELECT,INSERT", "SELECT,INSERT,UPDATE"), // append-only; the one UPDATE is a guarded pending -> available release
  payout_destination: tenant("SELECT,INSERT,UPDATE", "SELECT"), // seller-written; never edited, only superseded. platform SELECT: the tenant fail-closed sweep and verify:ledger; operators read bank data only via withPersonalDataAccess
  payout: tenant("SELECT,INSERT", "SELECT,UPDATE"), // DATA-7 says restricted: kept `tenant` like the T-60 tables until T-59b (bank snapshot reads go through withPersonalDataAccess)
  refund: tenant("SELECT,INSERT,UPDATE", "SELECT,INSERT,UPDATE"), // app UPDATE: the buyer's refund destination only (refund_guard); platform INSERT: late payments
  reconciliation_batch_item: { class: "tenant", key: "store_id", app: "", appColumns: Object.fromEntries(["evidence_date", "id", "order_id", "reconciled_at", "reconciliation_source", "store_id"].map((column) => [column, "SELECT"])), platform: "SELECT,INSERT,UPDATE" },
  store_step_up_proof: tenant("SELECT,UPDATE", "SELECT"), // inserted only by issue_store_step_up()
  // T-50 platform subscription billing (migration 0013): platform-owned records with a store key. The app role (seller Pay, callback route, seller views) reads its
  // own store's rows and INSERTs only an invoice, an attempt and callback digests, each pinned by a guard trigger; every later write is the worker's or the Owner console's.
  store_subscription: tenant("SELECT", "SELECT,UPDATE"), // one per store (bootstrapped by the store insert trigger); trial end and anchor written once
  subscription_invoice: tenant("SELECT,INSERT", "SELECT,INSERT,UPDATE"), // amounts immutable, a period is one non-void invoice (partial unique indexes), coverage applied once
  subscription_payment_attempt: tenant("SELECT,INSERT", "SELECT,INSERT,UPDATE"), // one live/uncertain attempt per invoice (partial unique index); identity and amounts immutable
  subscription_payment_callback: tenant("SELECT,INSERT", "SELECT"), // digest and shape only, never the body
  subscription_event: tenant("", "SELECT,INSERT"), // append-only; creation events come from the database triggers, the rest from the platform services
  // T-46: seller-owned configuration and atomic checkout reservations. Redemption evidence is append-only.
  discount: tenant("SELECT,INSERT,UPDATE", "SELECT,UPDATE"),
  discount_buyer_usage: tenant("SELECT,INSERT,UPDATE", "SELECT,UPDATE"),
  discount_redemption: tenant("SELECT,INSERT", "SELECT,INSERT"),
  flash_sale: tenant("SELECT,INSERT,UPDATE", "SELECT"),
  flash_sale_item: tenant("SELECT,INSERT,UPDATE", "SELECT,UPDATE"),
  flash_sale_redemption: tenant("SELECT,INSERT", "SELECT,INSERT"),
  promo_hub: tenant("SELECT,INSERT,UPDATE", "SELECT"),
  promo_hub_collection: tenant("SELECT,INSERT,DELETE", "SELECT"),
  // T-52 seller opt-in (migration 0016): closed by default, one row per store (policy), per product (offer) and per blocked affiliate. Guard triggers hold the state
  // machines and the programme's rate bounds; every write also leaves the projection job (affiliate.catalog.project). Platform: the worker projects from them.
  affiliate_seller_policy: tenant("SELECT,INSERT,UPDATE", "SELECT"),
  affiliate_offer: tenant("SELECT,INSERT,UPDATE", "SELECT"),
  affiliate_block: tenant("SELECT,INSERT,DELETE", "SELECT"),
  // T-45: what a hosted-checkout buyer typed (PR-25). The app role captures, marks the recovery, stamps "WA dibuka" and redacts; it never deletes. The platform
  // role (cleanup.ts) sweeps idle sessions to abandoned and purges rows older than 30 days. checkout_session_guard pins the transitions and both stamps.
  checkout_session: tenant("SELECT,INSERT,UPDATE", "SELECT,UPDATE,DELETE"),
  // audit_log: append-only for both roles. Rows with a store follow the store policy; store-less rows
  // only come from a named writer (app.audit_writer, withAuditWriter in tenant.ts).
  audit_log: { class: "tenant", key: "store_id", policy: "audit-writers", app: "INSERT", platform: "SELECT,INSERT" },

  // ── buyer: global buyer identity (T-57, ADR-0010, migration 0013). Own-buyer policy on app.buyer_id; written only by the owner-side
  // resolver buyer_resolve_order() (the platform login holds no table privilege on any of them). The portal (T-58) adds the address write grant.
  buyer: { class: "buyer", key: "id", app: "SELECT", platform: "" },
  buyer_identifier: { class: "buyer", key: "buyer_id", app: "SELECT", platform: "" }, // canonical phone / e-mail: sensitive, unique across buyers
  buyer_order_link: { class: "buyer", key: "buyer_id", app: "SELECT", platform: "" }, // store_id is provenance and the compound FK to the order, not the tenancy key
  buyer_identity_event: { class: "buyer", key: "buyer_id", app: "", platform: "" }, // append-only evidence; no login role reads it (restricted service reads only, T-72)
  buyer_address: { class: "buyer", key: "buyer_id", app: "SELECT", platform: "" },

  // ── affiliate: platform affiliate programme (T-52, ADR-0009, migration 0016). Own-affiliate policy on app.affiliate_id. The app role never inserts into the
  // click or attribution tables: checkout and the click entry point write them through the definer functions below. The affiliate's raw click log is not
  // readable by the app role at all, and its attribution rows only without the order, click and code references (column grant).
  affiliate: { class: "affiliate", key: "id", app: "SELECT", platform: "SELECT,INSERT,UPDATE" }, // registered pending, reviewed by the Owner console (T-54); guard trigger holds the state machine
  affiliate_link: { class: "affiliate", key: "affiliate_id", app: "SELECT,INSERT,UPDATE", platform: "SELECT" }, // own links; the only change after insert is active to revoked
  affiliate_code: { class: "affiliate", key: "affiliate_id", app: "SELECT,INSERT,UPDATE", platform: "SELECT" },
  affiliate_click: { class: "affiliate", key: "affiliate_id", app: "", platform: "SELECT" }, // written once by affiliate_capture_click(); retired only by retention_purge_affiliate_click()
  affiliate_attribution: { class: "affiliate", key: "affiliate_id", app: "", appColumns: Object.fromEntries(["affiliate_id", "commission_base_idr", "commission_idr", "created_at", "eligible_at", "hold_days", "id", "method", "source", "status", "store_id", "void_reason", "window_days"].map((column) => [column, "SELECT"])), platform: "SELECT" }, // written only by affiliate_record_attribution(); T-53 adds the state writers

  // ── auth: Better Auth adapter on the app pool ─────────────────────────────────────────────
  user: { class: "auth", app: "SELECT,INSERT,UPDATE,DELETE", platform: "SELECT" },
  session: { class: "auth", app: "SELECT,INSERT,UPDATE,DELETE", platform: "SELECT,DELETE" }, // platform: IAM-9 revocation of orphaned users
  account: { class: "auth", app: "SELECT,INSERT,UPDATE,DELETE", platform: "" },
  verification: { class: "auth", app: "SELECT,INSERT,UPDATE,DELETE", platform: "" },
  two_factor: { class: "auth", app: "SELECT,INSERT,UPDATE,DELETE", platform: "" },

  // ── platform: no tenant key ───────────────────────────────────────────────────────────────
  // Operator identity tables: the app role has no access at all. They become `restricted` with the
  // separate operator tables (T-59b).
  platform_operator: { class: "platform", app: "", platform: "SELECT,UPDATE" }, // T-63: UPDATE only for the deactivation of a staff member (SA-38)
  operator_grant: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE,DELETE" }, // T-60: grant/revoke run on the platform pool
  // T-60 Owner console tables (migration 0011): no app access; each carries its own append-only or no-delete triggers/REVOKEs.
  operator_grant_event: { class: "platform", app: "", platform: "SELECT,INSERT" }, // append-only audit of grants
  four_eyes_rule: { class: "platform", app: "", platform: "SELECT" }, // seeded by migration, never written at runtime
  approval_request: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" }, // never deleted
  break_glass_grant: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" }, // never deleted
  operator_step_up_proof: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE,DELETE" }, // single-use proofs, swept when expired
  session_mfa: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE,DELETE" }, // written by the auth hook on the platform pool
  // T-74 scheduler and retention tables (migration 0011): the app role holds nothing; `job` rows without a store are
  // invisible to it by the tenant policy (NULL never equals app.store_id) and by the platform_job_kind guard.
  platform_job_kind: { class: "platform", app: "", platform: "SELECT" }, // registry of kinds allowed to omit store_id
  scheduler_heartbeat: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  scheduler_cursor: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  retention_class: { class: "platform", app: "", platform: "SELECT" }, // seeded by migration; row_filter is trusted SQL, so never writable at runtime
  // Written only by the owner-side retention_set_period() (checks the actor, appends an event); unset period = purge disabled.
  retention_policy: { class: "platform", app: "", platform: "SELECT" },
  retention_policy_event: { class: "platform", app: "", platform: "SELECT" }, // append-only history of period changes (no purge class covers it)
  // T-68 queue: mutable report, immutable events and in-product notifications.
  issue_report: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  issue_report_event: { class: "platform", app: "", platform: "SELECT,INSERT" }, // append-only (trigger)
  issue_notification: { class: "platform", app: "", platform: "SELECT,INSERT" },
  // T-62: DATA-14 access evidence. Restricted: no login role holds a privilege; the two definer functions below are the only paths.
  personal_data_access_event: { class: "restricted", app: "", platform: "" },
  subscription_notice: { class: "platform", app: "", platform: "SELECT,INSERT" }, // T-50 dunning message intents, unique per store, kind and reference (append-only)
  billing_control: { class: "platform", app: "", platform: "SELECT,UPDATE" }, // T-50 singleton: billing-job freeze and dunning switch
  // system_log has a store_id column but deliberately no RLS: it is written before a store context
  // exists and the app role can log under any store id (accepted ceiling, ADR-0005 amendment 5).
  system_log: { class: "platform", app: "INSERT", appColumns: { id: "SELECT" }, platform: "SELECT,INSERT" }, // id: RETURNING needs SELECT
  rate_limit: { class: "platform", app: "SELECT,INSERT,UPDATE", platform: "SELECT,DELETE" },
  // T-37: platform money records. No tenant key; written by the reconciliation service on the platform pool (batch) and the payout/refund settlement paths (evidence).
  reconciliation_batch: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  transfer_evidence_artifact: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" }, // UPDATE: claimed once (guard)
  transfer_evidence_registry: { class: "platform", app: "", platform: "SELECT,INSERT" }, // append-only
  payout_control: { class: "platform", app: "SELECT", platform: "SELECT,UPDATE" }, // T-37 finish singleton: the post-restore payout freeze (app SELECT: the seller screen says why a request is refused)
  mail_outbox: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" }, // T-73: app has EXECUTE-only enqueue and order-scoped privacy functions
  // T-65: platform tax core. Tax identity and statements are platform data, not seller tenancy: tax_identity and tax_document carry the
  // affiliate policy (own-subject reads under app.affiliate_id). tax_identity grants the app role only the non-sealed columns (SELECT);
  // writes, including the sealed insert, run on the platform pool in the named services of src/tax (so no tax_identity INSERT for the app role).
  // They stay `platform`/`affiliate` and not `restricted`: reaching them through definer functions only is the T-59b work.
  tax_setting: { class: "platform", app: "", platform: "SELECT,INSERT" },
  tax_entity_profile: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  tax_policy_version: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  tax_computation: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  tax_document_sequence: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  tax_event: { class: "platform", app: "", platform: "SELECT,INSERT" },
  tax_identity: { class: "affiliate", key: "affiliate_id", app: "", appColumns: Object.fromEntries(["affiliate_id", "id", "id_kind", "id_last4", "payee_class", "status", "store_id", "subject_kind", "submitted_at", "version"].map((column) => [column, "SELECT"])), platform: "SELECT,INSERT,UPDATE" },
  tax_document: { class: "affiliate", key: "affiliate_id", app: "SELECT", platform: "SELECT,INSERT,UPDATE" },
  // T-65: the only UPDATE path for sealed identity columns (re-seal under a new key id); the table trigger refuses every other sealed change.
  // T-63 account governance (migration 0013): platform class, no app access. History and decisions are INSERT-only (append_only_guard);
  // cases, actions and verification versions move only through the legal transitions of their guard triggers; nothing is deleted.
  support_case: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  support_case_note: { class: "platform", app: "", platform: "SELECT,INSERT" },
  account_status_event: { class: "platform", app: "", platform: "SELECT,INSERT" },
  support_action: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  account_verification: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  store_risk_ack: { class: "platform", app: "", platform: "SELECT,INSERT" },
  support_recovery_link: { class: "platform", app: "", platform: "SELECT" }, // created only by support_recovery_create(), consumed only by support_recovery_redeem()
  access_review_decision: { class: "platform", app: "", platform: "SELECT,INSERT" },
  cashback_rule: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  shipping_partner_budget: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  shipping_dispatch_lease: { class: "platform", app: "", platform: "SELECT,INSERT,UPDATE" },
  // T-105: the province of a provider area, written by the app role from an area-search answer only (no tenant key: an area is the same for every store).
  shipping_area: { class: "platform", app: "SELECT,INSERT,UPDATE", platform: "SELECT" },
  // T-105 (ADR-0013 decision 34, C-P4): the per-provider production switch and its recorded sandbox pass; written by the Owner console, read at every call.
  provider_live_setting: { class: "platform", app: "SELECT", platform: "SELECT,INSERT,UPDATE" },

  // T-52: the discovery projection (public seller and product fields, deliberately cross-store), the programme limits and the phase-1 fraud counters.
  affiliate_catalog: { class: "platform", app: "SELECT", platform: "SELECT,INSERT,UPDATE,DELETE" }, // filled by the JOB-20 handler (the revision pair only grows: guard); DELETE only for the full rebuild (pure replace, JOB-22)
  affiliate_counter: { class: "platform", app: "", platform: "SELECT" }, // written only by the definer functions that observe the event; read by the risk queue (SA-18)
  // ── shared-read ───────────────────────────────────────────────────────────────────────────
  shipping_margin_rule: { class: "shared-read", app: "SELECT", platform: "SELECT,INSERT,UPDATE" }, // platform: Owner console edits the margin
  subscription_plan: { class: "shared-read", app: "SELECT", platform: "SELECT,INSERT" }, // T-50 versioned billing configuration; append-only, the seller reads the price and the trial/grace days
  courier_service_policy: { class: "shared-read", app: "SELECT", platform: "SELECT,INSERT,UPDATE" }, // COD allow-list (data, not code); administered under T-48
  affiliate_policy: { class: "shared-read", app: "SELECT", platform: "SELECT" }, // T-52 programme limits (one row: rate bounds, attribution window, hold); the writer is the Owner console (T-54)
  shipping_control: { class: "shared-read", app: "SELECT", platform: "SELECT,UPDATE" },
  // T-106: Owner console payment settings read by every store at checkout: locked channels (a row = locked), versioned fee rates (append-only) and the
  // decision-34 production switch for seller AutoLaris keys (one row, seeded off).
  payment_channel_lock: { class: "shared-read", app: "SELECT", platform: "SELECT,INSERT,DELETE" },
  payment_fee_rate: { class: "shared-read", app: "SELECT", platform: "SELECT,INSERT" },
  payment_production_switch: { class: "shared-read", app: "SELECT", platform: "SELECT,UPDATE" },
  // T-116: versioned seller terms and their adviser reviews (append-only; every store reads, only the Owner console writes).
  seller_terms_version: { class: "shared-read", app: "SELECT", platform: "SELECT,INSERT" },
  seller_terms_review: { class: "shared-read", app: "SELECT", platform: "SELECT,INSERT" },
};

/** Writers that may insert store-less `audit_log` rows from the app role. The SQL function `app_audit_writer()` carries the same list. */
export const AUDIT_STORELESS_WRITERS = ["account.security"] as const;
export type AuditWriter = (typeof AUDIT_STORELESS_WRITERS)[number];

/** Expected `pg_policy` shape of an entry, as `pg_get_expr` prints it; null when the class carries no policy. */
export function expectedPolicy(entry: TableEntry): { name: string; using: string; withCheck: string } | null {
  const key = entry.key ?? "";
  if (entry.class === "tenant") {
    const using = `(${key} = app_store_id())`;
    return {
      name: "tenant_isolation",
      using,
      withCheck: entry.policy === "audit-writers" ? `((${key} = app_store_id()) OR ((${key} IS NULL) AND (app_audit_writer() IS NOT NULL)))` : using,
    };
  }
  if (entry.class === "buyer") return { name: "buyer_isolation", using: `(${key} = app_buyer_id())`, withCheck: `(${key} = app_buyer_id())` };
  if (entry.class === "affiliate") return { name: "affiliate_isolation", using: `(${key} = app_affiliate_id())`, withCheck: `(${key} = app_affiliate_id())` };
  return null;
}

/** The roles of ADR-0005 and the amendment. `login: false` roles never connect; they own objects. */
export const ROLES = {
  bukalaris_owner: { login: true, bypassrls: true },
  bukalaris_app: { login: true, bypassrls: false },
  bukalaris_platform: { login: true, bypassrls: true },
  bukalaris_restricted: { login: false, bypassrls: false },
  bukalaris_resolver: { login: false, bypassrls: true },
} as const;

/**
 * Every SECURITY DEFINER function of schema public (ADR-0005 amendment 4): owner, who may EXECUTE
 * (PUBLIC never) and, for resolvers, the tables the owner reads. `bukalaris_resolver` holds exactly
 * SELECT on the union of `reads`. Functions are identified as `name(argument types)`.
 * Fixed `search_path = pg_catalog, public`, schema-qualified names and no dynamic SQL are checked on
 * the catalog by the invariant test.
 */
export interface DefinerFunction {
  owner: "bukalaris_resolver" | "bukalaris_restricted" | "bukalaris_owner";
  /**
   * `resolver` (default): fixed `search_path = pg_catalog, public`, schema-qualified tables, no dynamic SQL.
   * `retention` and `guard` are owned by the migrator/table owner (the purge must delete from tables the platform role
   * cannot delete from) and pin `search_path = pg_catalog, pg_temp`, so every table reference must be written
   * `public.<table>` or `pg_catalog.<table>` (a temporary table can never shadow one). Dynamic SQL is allowed only
   * where `dynamicSql` is set, and then only through `format(%I)`-quoted identifiers.
   */
  kind?: "resolver" | "retention" | "guard";
  dynamicSql?: boolean;
  /** Roles holding EXECUTE. */
  execute: readonly ("bukalaris_app" | "bukalaris_platform")[];
  /** Tables read by the body (resolvers only). */
  reads?: readonly string[];
}

export const DEFINER_FUNCTIONS: Record<string, DefinerFunction> = {
  "promotion_counter_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "promotion_financial_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "promotion_evidence_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "checkout_session_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] }, // T-45: transitions, monotonic stamps and the 60-minute idle rule of checkout_session
  "reset_demo_promotions(bigint[])": { owner: "bukalaris_owner", kind: "retention", execute: [] }, // owner connection only (local demo seed), 'demo-%' stores only
  // The scope constructors and the cart lookup also run in the local seeds (`placeOrder`) on the platform pool.
  "resolve_store_by_slug(text)": { owner: "bukalaris_resolver", execute: ["bukalaris_app", "bukalaris_platform"], reads: ["store"] },
  "resolve_member_stores(text)": { owner: "bukalaris_resolver", execute: ["bukalaris_app", "bukalaris_platform"], reads: ["membership", "store"] },
  "resolve_cart_store(uuid)": { owner: "bukalaris_resolver", execute: ["bukalaris_app", "bukalaris_platform"], reads: ["cart"] },
  "resolve_channel_store(text,text)": { owner: "bukalaris_resolver", execute: ["bukalaris_app"], reads: ["storefront_channel"] },
  "resolve_feed_store(text,text)": { owner: "bukalaris_resolver", execute: ["bukalaris_app"], reads: ["feed_token"] },
  "resolve_handoff_store(text)": { owner: "bukalaris_resolver", execute: ["bukalaris_app"], reads: ["checkout_handoff"] },
  "resolve_invitation_store(text)": { owner: "bukalaris_resolver", execute: ["bukalaris_app"], reads: ["store_invitation"] },
  // T-49: the signed callback reference resolves to its store on the app pool; the raw callback body is redacted by an owner-side function once the owner records a period.
  "resolve_payment_attempt_store(text)": { owner: "bukalaris_resolver", execute: ["bukalaris_app", "bukalaris_platform"], reads: ["payment_attempt"] },
  "redact_payment_callbacks(integer)": { owner: "bukalaris_owner", kind: "retention", execute: ["bukalaris_platform"] },
  // T-49: local demo reset only; deletes the payment rows of 'demo-%' stores (the seed's reserved slug prefix) and nothing else.
  "reset_demo_payments(bigint[])": { owner: "bukalaris_owner", kind: "retention", execute: [] }, // owner connection only (local demo seed)
  "payment_attempt_insert_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "payment_event_insert_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "payment_manual_confirmation_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] }, // T-106: the confirmation names an attempt of that order on the store's own account
  // T-107 (ADR-0013 section 8): the money-boundary rule and its guards, owner-only (the services ask the same question with their own store-scoped query).
  "store_money_mode(bigint)": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "money_boundary_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "money_cutover_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] }, // review M2: the first own account only with no platform money in flight
  "order_financials_money_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  // T-113: the bank-account list (step-up, five listed, removal stamp only), the bank-transfer order records and the paid rule of decision 38.
  "store_bank_account_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "order_bank_transfer_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "payment_proof_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "bank_transfer_confirmation_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "order_bank_transfer_paid_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  // T-116: append-only guards for seller terms, adviser reviews and store acceptances (plus owner membership on acceptance).
  "seller_terms_immutable_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "store_terms_acceptance_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  // T-111: product kind immutability after sale and variant weight/stock-tracking rules per product kind.
  "product_kind_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "variant_kind_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  // T-112: digital access item kind/cap guard and digital grant paid-only/no-delete guard + affiliate hold/void trigger.
  "product_access_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "digital_grant_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "digital_grant_affiliate_sync()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "order_seller_refund_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  // T-50: the signed callback reference of a subscription attempt resolves to its store (app pool); the effective vat_output policies (public tax configuration) are
  // readable by the seller Pay path. The triggers below pin what an invoice or attempt may start as and write the creation events; the bootstrap row-creates a trial
  // subscription for every new store; the demo reset is owner-connection only.
  "resolve_subscription_attempt_store(text)": { owner: "bukalaris_resolver", execute: ["bukalaris_app", "bukalaris_platform"], reads: ["subscription_payment_attempt"] },
  "billing_effective_vat(date)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app", "bukalaris_platform"] }, // effective vat_output policies for the seller Pay path (reads tax_policy_version as the owner)
  "subscription_bootstrap()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "subscription_invoice_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "subscription_event_writer()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "subscription_expire_attempt(uuid,integer)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app", "bukalaris_platform"] }, // bound to app_store_id(), expires one accepted attempt of the caller's store after its expiry
  "reset_demo_billing(bigint[])": { owner: "bukalaris_owner", kind: "retention", execute: [] }, // owner connection only (local demo seed)
  "resolve_order_store(bigint)": { owner: "bukalaris_resolver", execute: ["bukalaris_app"], reads: ["order"] },
  // T-74: the generic purge is not executable by anyone but its owner; each class has a wrapper the platform role may call.
  "retention_purge(text,integer)": { owner: "bukalaris_owner", kind: "retention", dynamicSql: true, execute: [] },
  "retention_purge_signal_event(integer)": { owner: "bukalaris_owner", kind: "retention", execute: ["bukalaris_platform"] },
  "retention_purge_system_log(integer)": { owner: "bukalaris_owner", kind: "retention", execute: ["bukalaris_platform"] },
  "retention_purge_audit_log(integer)": { owner: "bukalaris_owner", kind: "retention", execute: ["bukalaris_platform"] },
  "retention_purge_job(integer)": { owner: "bukalaris_owner", kind: "retention", execute: ["bukalaris_platform"] },
  "retention_purge_job_dead(integer)": { owner: "bukalaris_owner", kind: "retention", execute: ["bukalaris_platform"] },
  "retention_purge_access_event(integer)": { owner: "bukalaris_owner", kind: "retention", execute: ["bukalaris_platform"] },
  "retention_purge_issue_report(integer)": { owner: "bukalaris_owner", kind: "retention", execute: ["bukalaris_platform"] },
  "retention_anonymize_issues(integer,timestampwithtimezone)": { owner: "bukalaris_owner", kind: "retention", execute: [] },
  "issue_report_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  // T-74: trigger guard that lets a platform-registered kind omit store_id; it reads a table the app role cannot see.
  "job_platform_kind_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  // T-74: the audited setter of retention periods; the platform login holds EXECUTE and SELECT only (no write on the period table).
  "retention_set_period(text,integer,text,text)": { owner: "bukalaris_owner", kind: "retention", execute: ["bukalaris_platform"] },
  // T-60: trigger guards of the four-eyes tables. Definer with a pinned search_path and qualified names, so a temporary table in the
  // caller's session cannot stand in for operator_grant or four_eyes_rule (review finding).
  "approval_request_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "break_glass_grant_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  // T-62: the single write path and the single read path of personal_data_access_event (restricted table, owner bukalaris_restricted).
  "console_record_access(text,text,text,text,text,text,text,text,timestampwithtimezone,bigint)": { owner: "bukalaris_restricted", execute: ["bukalaris_platform"] },
  "console_access_events(integer,bigint)": { owner: "bukalaris_restricted", execute: ["bukalaris_platform"] },
  // T-65: the only UPDATE path for sealed identity columns (re-seal under a new key id); the table trigger refuses every other sealed change.
  "tax_identity_reseal(bigint,text,text,text,text)": { owner: "bukalaris_owner", kind: "retention", execute: ["bukalaris_platform"] },
  // T-57: the platform resolver of JOB-10 (target-bound: reads the committed order snapshot itself, writes buyer, identifiers, link and events in one
  // statement) and the local demo reset of those rows (owner connection only).
  "buyer_resolve_order(bigint,bigint,text,boolean)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_platform"] },
  "reset_demo_buyers(bigint[])": { owner: "bukalaris_owner", kind: "retention", execute: [] },
  // T-73: owner-side intent, scoped privacy and expiry purge; never return credential-bearing bodies to app.
  "mail_enqueue(text,text,text,text,text,timestampwithtimezone,bigint,text)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app", "bukalaris_platform"] },
  "mail_privacy_export(bigint[])": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app", "bukalaris_platform"] },
  "mail_privacy_redact(bigint[])": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app", "bukalaris_platform"] },
  "mail_purge_expired(integer)": { owner: "bukalaris_owner", kind: "retention", execute: ["bukalaris_platform"] },
  // T-37: guards of the ledger, payout and refund tables read other tables (order, financial snapshot, batches, destinations) and run as the owner with a pinned search_path.
  "financial_snapshot_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "financial_lines_check()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "ledger_entry_insert_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "ledger_entry_change_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "reconciliation_batch_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "reconciliation_item_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "payout_destination_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "payout_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "payout_pairing_check()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "refund_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "approval_binds(bigint,text,text,text,jsonb)": { owner: "bukalaris_owner", kind: "guard", execute: [] }, // T-37 finish: does an approval request approve exactly this action, target and payload? (called by the money guards)
  "payout_freeze_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] }, // T-37 finish: one guard on payout, refund and reconciliation_batch
  // T-37: the only source of a seller step-up proof. Callable by the app login, so it re-derives everything it needs (session, owner membership, fresh MFA of THAT session) instead of trusting its arguments.
  "issue_store_step_up(bigint,text,text,text,text,text,integer)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app"] },
  // T-37: local demo reset only; owner connection only (no login role), deletes the ledger rows of 'demo-%' stores.
  "reset_demo_ledger(bigint[])": { owner: "bukalaris_owner", kind: "retention", execute: [] },
  // T-63: account governance. The three owner-side writers re-check the capability inside the function (a login role can call them with
  // any actor id); redemption is the app role's only path to the recovery-link table; the reveal lookup reads the restricted evidence table.
  "console_set_user_suspension(text,text,boolean)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_platform"] },
  "console_reset_user_mfa(text,text,text)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_platform"] },
  "support_recovery_create(text,bigint,text,text,timestampwithtimezone)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_platform"] },
  "support_recovery_redeem(text)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app"] },
  "resolve_user_suspended(text)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app", "bukalaris_platform"] },
  "console_active_reveal(text,text,text,text)": { owner: "bukalaris_restricted", execute: ["bukalaris_platform"] },
  "shipping_store_bootstrap()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "shipping_account_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "shipping_snapshot_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "shipping_reconciliation_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "shipping_policy_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "reset_demo_shipping(bigint[])": { owner: "bukalaris_owner", kind: "retention", execute: [] }, // T-48: local demo reset only; owner connection only (T-104: also the demo stores' own payment accounts)
  // T-104: the application role's only read of a sealed provider envelope, refused for every store but app_store_id().
  "provider_key_envelope(bigint,text)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app", "bukalaris_platform"] }, // T-106: the worker opens a store's key through it too (inside withStore)
  // T-115: the webhook address id -> its store (the route continues on the app pool in that store's context). Owned by the table owner like
  // resolve_user_suspended, so bukalaris_resolver never holds SELECT on the table that carries the sealed Webhook Secret (review minor 8).
  "resolve_mengantar_webhook_store(text)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app"] },
  // T-52 affiliate programme. The three callable by the checkout re-check app_store_id() themselves and read the buyer phone, the affiliate, the click and the financial
  // snapshot from the database: a caller names no affiliate, method, click or amount. The click entry point takes only the public token. Guards and triggers are never callable.
  "affiliate_resolve_core(bigint,bigint,text,text[])": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "affiliate_resolve(bigint,bigint,text,text[])": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app"] },
  "affiliate_record_attribution(bigint,bigint,text,text[])": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app"] },
  "affiliate_code_valid(bigint,text)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app"] },
  "affiliate_line_rate(bigint,bigint)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app"] },
  "affiliate_capture_click(text,text)": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app"] },
  "affiliate_count_code_failure()": { owner: "bukalaris_owner", kind: "guard", execute: ["bukalaris_app"] },
  "affiliate_bump(text,bigint)": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "retention_purge_affiliate_click(integer)": { owner: "bukalaris_owner", kind: "retention", execute: ["bukalaris_platform"] }, // JOB-27: no period row, no effect
  "reset_demo_affiliate(bigint[])": { owner: "bukalaris_owner", kind: "retention", execute: [] }, // owner connection only (local demo seed)
  "affiliate_status_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "affiliate_selector_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "affiliate_offer_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "affiliate_seller_policy_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "affiliate_policy_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "affiliate_catalog_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "affiliate_click_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "affiliate_attribution_guard()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "affiliate_financial_check()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "affiliate_offer_enqueue()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "affiliate_seller_policy_enqueue()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
  "affiliate_product_touch()": { owner: "bukalaris_owner", kind: "guard", execute: [] },
};

// ── Canonical forms used by the invariant test and the shell scripts ─────────────────────────
const ORDER = ["SELECT", "INSERT", "UPDATE", "DELETE"];
for (const [table, e] of Object.entries(ISOLATION_REGISTRY)) {
  for (const p of [e.app, e.platform, ...Object.values(e.appColumns ?? {}), ...Object.values(e.platformColumns ?? {})]) {
    const parts = p === "" ? [] : p.split(",");
    if (parts.some((x) => !ORDER.includes(x)) || parts.join() !== ORDER.filter((x) => parts.includes(x)).join()) throw new Error(`isolation registry: ${table}: "${p}" is not a canonical privilege list`);
  }
  if ((e.class === "tenant" || e.class === "buyer" || e.class === "affiliate") !== (e.key !== undefined)) throw new Error(`isolation registry: ${table}: only tenant, buyer and affiliate entries carry a policy key`);
  if (e.class === "restricted" && (e.app !== "" || e.platform !== "")) throw new Error(`isolation registry: ${table}: a restricted table grants nothing to the app or platform role`);
  if (e.class === "shared-read" && e.app !== "SELECT") throw new Error(`isolation registry: ${table}: shared-read means SELECT only for the app role`);
}

/** Registry rows as `table|role|privileges|columns` for the shell checks (`isolation-print.ts`). */
export function registryRows(): { table: string; class: IsolationClass; app: Privileges; platform: Privileges; platformColumns: Record<string, Privileges>; policy: string }[] {
  return Object.entries(ISOLATION_REGISTRY)
    .map(([table, e]) => ({ table, class: e.class, app: e.app, platform: e.platform, platformColumns: e.platformColumns ?? {}, policy: expectedPolicy(e)?.name ?? "" }))
    .sort((a, b) => a.table.localeCompare(b.table));
}
