-- Hand-written (drizzle-kit does not model roles, grants or row-level security). Keep verbatim
-- when migrations are consolidated at merge (docs/DECISIONS.md D-9, ADR-0005, docs/tracks/rls.md).
--
-- Roles are created outside migrations (packages/db/docker/05-roles.sql locally; a DBA step in
-- production, because BYPASSRLS needs a superuser). This migration runs as the schema owner
-- (`bukalaris_owner`, MIGRATION_DATABASE_URL) and only grants and enables policies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bukalaris_app') OR NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bukalaris_platform') THEN
    RAISE EXCEPTION 'roles bukalaris_app and bukalaris_platform must exist before migration 0007 (packages/db/docker/05-roles.sql; docs/DEPLOY-COOLIFY.md "Database roles")';
  END IF;
END $$;--> statement-breakpoint

-- The store context of the current transaction: set by `set_config('app.store_id', <id>, true)`
-- (packages/db/src/tenant.ts). NULL when unset; `nullif` because a custom setting reads as ''
-- (not NULL) in a session that set it in an earlier transaction. STABLE, so a query evaluates
-- it once and indexes on store_id stay usable.
CREATE FUNCTION app_store_id() RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.store_id', true), '')::bigint $$;--> statement-breakpoint

-- ── Row-level security: every table that carries store_id, plus the tenant root ───────────
-- ENABLE applies the policy to ordinary roles, FORCE also to the owner (defence if BYPASSRLS
-- is ever removed from it). One policy per table, for every command: a row is visible or
-- writable only when its store_id equals the transaction's store. No context ⇒ no rows.
ALTER TABLE "store" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "store" USING ("id" = app_store_id()) WITH CHECK ("id" = app_store_id());--> statement-breakpoint

ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "membership" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "product" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "product" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "variant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "variant" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "variant" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "product_slug_alias" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_slug_alias" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "product_slug_alias" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "catalog_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog_audit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "catalog_audit" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "cart" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cart" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "cart" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "cart_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cart_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "cart_line" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "order" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "order_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "order_line" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "order_status_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_status_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "order_status_history" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "stock_adjustment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_adjustment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "stock_adjustment" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "audit_log" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "store_invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_invitation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "store_invitation" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "collection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "collection" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "collection" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "collection_product" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "collection_product" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "collection_product" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "page" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "page" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "page" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "media" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "storefront_channel" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storefront_channel" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "storefront_channel" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "checkout_handoff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "checkout_handoff" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "checkout_handoff" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "job" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "store_pickup_area" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_pickup_area" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "store_pickup_area" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "order_notification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_notification" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "order_notification" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "signal_destination" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signal_destination" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "signal_destination" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "signal_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signal_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "signal_event" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "order_signal_context" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_signal_context" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "order_signal_context" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint

-- ── Grants ─────────────────────────────────────────────────────────────────────────────────
-- bukalaris_platform: everything, today and for future objects created by the owner (it
-- bypasses RLS by role attribute; the application decides where it is used).
GRANT USAGE ON SCHEMA public TO bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bukalaris_platform;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bukalaris_platform, bukalaris_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE bukalaris_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bukalaris_platform;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE bukalaris_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO bukalaris_platform, bukalaris_app;--> statement-breakpoint

-- bukalaris_app: per table, only the commands the services issue (docs/tracks/rls.md has the
-- table). Deliberately NO default table privileges: a future table is unreachable by the app
-- until its migration grants access and (when it carries store_id) enables RLS — fail closed;
-- packages/db/test/rls.test.ts checks both for every table.
-- Better Auth tables (no store_id; the adapter runs on the app pool).
GRANT SELECT, INSERT, UPDATE, DELETE ON "user", "session", "account", "verification", "two_factor" TO bukalaris_app;--> statement-breakpoint
-- Tenant root: read + settings; stores are created and suspended by operators only.
GRANT SELECT, UPDATE ON "store" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "membership" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "store_invitation" TO bukalaris_app;--> statement-breakpoint
-- Catalog and content.
GRANT SELECT, INSERT, UPDATE ON "product", "variant", "collection", "page", "store_pickup_area" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "product_slug_alias", "collection_product" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "media" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "catalog_audit" TO bukalaris_app;--> statement-breakpoint
-- Commerce: carts are deleted by the cleanup process (platform), orders are never deleted.
GRANT SELECT, INSERT ON "cart" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "cart_line" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "order" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "order_line", "order_status_history", "stock_adjustment" TO bukalaris_app;--> statement-breakpoint
-- Channels and the one-use handoff (consumed with an UPDATE).
GRANT SELECT, INSERT, UPDATE ON "storefront_channel", "checkout_handoff" TO bukalaris_app;--> statement-breakpoint
-- Outbox: the app only enqueues (inside store transactions); claiming/completing is the worker.
GRANT SELECT, INSERT ON "job" TO bukalaris_app;--> statement-breakpoint
-- Ad signals: destinations are seller settings; events are enqueued by the app, delivered by the worker.
GRANT SELECT, INSERT, UPDATE ON "signal_destination" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "signal_event", "order_signal_context" TO bukalaris_app;--> statement-breakpoint
-- Audit: append-only for the app; operators read it through the platform pool.
GRANT INSERT ON "audit_log" TO bukalaris_app;--> statement-breakpoint
-- Store-less tables the request path needs.
GRANT SELECT, INSERT, UPDATE ON "rate_limit" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON "shipping_margin_rule" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "mail_outbox" TO bukalaris_app;--> statement-breakpoint
-- Log sink: insert, and read back only the id it returns (RETURNING needs SELECT on the column).
GRANT INSERT ON "system_log" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ("id") ON "system_log" TO bukalaris_app;
-- Nothing on platform_operator, operator_grant and order_notification: operator and worker paths only.
