-- T-59 CONTRACT step. NOT APPLIED by anything: not by the test global setup, not by `pnpm db:migrate`, not by
-- anything else. It stays here until the owner approves it (D-22 item 4).
--
-- WHEN IT MAY RUN (all of these, in this order):
--   1. Migration 0011_chain_a_foundation.sql (the expand step: resolver functions, roles, audit_log policy, per-table platform grants) is
--      applied in the target database.
--   2. The web version that calls the resolver functions (storefrontScope, sellerContext, cart, channel, feed,
--      handoff, invitation and order-link lookups on the APP pool) is deployed everywhere, and no older web
--      or worker process that still reads those tables through bukalaris_platform is running. Rolling an old
--      version back after this file ran needs the revert block at the end.
--   3. Every table created since the expand step has its entry in platform/isolation-registry.ts (this file only
--      re-grants the privileges listed there; a table without an entry loses platform access and the invariant
--      test fails), and every platform-pool code path added since (Owner console grant management, payout and tax
--      services, retention purge) has its privileges in the `platform` column.
--   4. The owner approved it (it removes access that the previous version relies on).
--   5. The local seeds (`pnpm db:seed`, `db:seed:demo`) write many tables through bukalaris_platform; after this
--      file they must connect with MIGRATION_DATABASE_URL (the owner) or they fail with 42501. They are local-only.
--
-- What it does: bukalaris_platform loses the table-wide SELECT/INSERT/UPDATE/DELETE of migration 0007 and the default
-- privileges for future owner-created tables, then receives exactly the registry's per-table privileges again.
-- Sequence privileges and the app role are untouched. A future table is unreachable for the platform role until its
-- own migration grants it (fail closed), and a restricted table never is.
-- packages/db/test/rls-contract.test.ts applies this file to a scratch copy of the schema, checks the result
-- against the registry and runs the platform-pool production paths on it.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM bukalaris_platform;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE bukalaris_owner IN SCHEMA public REVOKE ALL ON TABLES FROM bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "access_review_decision" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "account_status_event" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "account_verification" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "affiliate" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "affiliate_attribution" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "affiliate_block" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "affiliate_catalog" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "affiliate_click" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "affiliate_code" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "affiliate_counter" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "affiliate_link" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "affiliate_offer" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "affiliate_policy" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "affiliate_seller_policy" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "approval_request" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_log" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "billing_control" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "break_glass_grant" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, DELETE ON "cart" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cashback_rule" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON "checkout_session" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "collection" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "courier_service_policy" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "discount" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "discount_buyer_usage" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "discount_redemption" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "flash_sale" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "flash_sale_item" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "flash_sale_redemption" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "four_eyes_rule" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "issue_notification" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "issue_report" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "issue_report_event" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "job" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "late_payment_obligation" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ledger_entry" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "mail_outbox" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "media" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "membership" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "operator_grant" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "operator_grant_event" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "operator_step_up_proof" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "order" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "order_financials" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "order_line" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "order_line_financials" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "order_notification" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "order_redaction" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, DELETE ON "order_signal_context" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "order_status_history" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "page" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "payment_attempt" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "payment_attempt_event" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "payment_callback" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "payment_observation" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "payout" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "payout_control" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "payout_destination" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "platform_job_kind" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "platform_operator" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "product" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "promo_hub" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "promo_hub_collection" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, DELETE ON "rate_limit" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "reconciliation_batch" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "reconciliation_batch_item" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "refund" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "retention_class" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "retention_policy" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "retention_policy_event" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "scheduler_cursor" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "scheduler_heartbeat" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, DELETE ON "session" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "session_mfa" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "shipment" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "shipment_cost" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "shipping_control" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "shipping_dispatch_lease" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "shipping_margin_rule" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "shipping_partner_budget" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "signal_destination" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "signal_event" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "store" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "store_pickup_area" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "store_risk_ack" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "store_shipping_account" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "store_step_up_proof" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "store_subscription" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "subscription_event" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "subscription_invoice" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "subscription_notice" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "subscription_payment_attempt" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "subscription_payment_callback" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "subscription_plan" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "support_action" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "support_case" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "support_case_note" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "support_recovery_link" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "system_log" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tax_computation" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tax_document" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tax_document_sequence" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tax_entity_profile" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "tax_event" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tax_identity" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tax_policy_version" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "tax_setting" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "transfer_evidence_artifact" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "transfer_evidence_registry" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "user" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "variant" TO bukalaris_platform;

-- Revert (only for a rollback of the web version; run by hand, never by tooling):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bukalaris_platform;
--   ALTER DEFAULT PRIVILEGES FOR ROLE bukalaris_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bukalaris_platform;
-- (then re-REVOKE on any restricted table).
