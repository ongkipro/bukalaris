CREATE TABLE "approval_request" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "approval_request_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"action_key" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"payload_canonical" text NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_request_status_chk" CHECK ("approval_request"."status" in ('pending', 'approved', 'rejected', 'expired', 'executed', 'cancelled')),
	CONSTRAINT "approval_request_payload_chk" CHECK ("approval_request"."payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "approval_request_canonical_chk" CHECK ("approval_request"."payload_sha256" = encode(sha256(convert_to("approval_request"."payload_canonical", 'UTF8')), 'hex') and length("approval_request"."payload_canonical") <= 4000),
	CONSTRAINT "approval_request_reason_chk" CHECK (length(btrim("approval_request"."reason")) between 5 and 500),
	CONSTRAINT "approval_request_two_people_chk" CHECK ("approval_request"."decided_by" is null or "approval_request"."requested_by" <> "approval_request"."decided_by"),
	CONSTRAINT "approval_request_decision_chk" CHECK (("approval_request"."decided_by" is null) = ("approval_request"."decided_at" is null)),
	CONSTRAINT "approval_request_state_chk" CHECK (("approval_request"."status" not in ('approved', 'rejected', 'executed') or "approval_request"."decided_by" is not null) and ("approval_request"."status" <> 'pending' or "approval_request"."decided_by" is null)),
	CONSTRAINT "approval_request_executed_chk" CHECK (("approval_request"."status" = 'executed') = ("approval_request"."executed_at" is not null)),
	CONSTRAINT "approval_request_expiry_chk" CHECK ("approval_request"."expires_at" > "approval_request"."created_at")
);
--> statement-breakpoint
CREATE TABLE "break_glass_grant" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "break_glass_grant_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"requested_by" text NOT NULL,
	"approved_by" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"case_id" text NOT NULL,
	"reason" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "break_glass_two_people_chk" CHECK ("break_glass_grant"."requested_by" <> "break_glass_grant"."approved_by"),
	CONSTRAINT "break_glass_window_chk" CHECK ("break_glass_grant"."expires_at" > "break_glass_grant"."starts_at"),
	CONSTRAINT "break_glass_case_chk" CHECK (length(btrim("break_glass_grant"."case_id")) > 0 and length(btrim("break_glass_grant"."reason")) > 0),
	CONSTRAINT "break_glass_allowlist_chk" CHECK (cardinality("break_glass_grant"."capabilities") > 0 and "break_glass_grant"."capabilities" <@ array['accounts.read', 'accounts.reveal', 'finance.read', 'tax.read']::text[])
);
--> statement-breakpoint
CREATE TABLE "four_eyes_rule" (
	"action_key" text PRIMARY KEY NOT NULL,
	"capability" text NOT NULL,
	"phase" text NOT NULL,
	"max_validity" interval NOT NULL,
	"active" boolean NOT NULL,
	CONSTRAINT "four_eyes_rule_cap_chk" CHECK ("four_eyes_rule"."capability" in ('dashboard.read', 'tenants.read', 'tenants.manage', 'tenants.verify', 'shipping.manage', 'billing.read', 'billing.manage', 'finance.read', 'payouts.process', 'refunds.process', 'payouts.reconcile', 'ledger.adjust', 'affiliate.accounts.read', 'affiliate.accounts.review', 'affiliate.policy.manage', 'affiliate.payout.process', 'affiliate.disputes.manage', 'accounts.read', 'accounts.support', 'accounts.suspend', 'accounts.identifiers.review', 'accounts.reveal', 'members.recover', 'cases.read', 'cases.write', 'moderation.manage', 'complaints.manage', 'privacy.requests.manage', 'incidents.manage', 'compliance.read', 'privacy.export.approve', 'tax.read', 'tax.manage', 'tax.approve', 'tax.remit', 'tax.documents.issue', 'tax.identity.review', 'tax.period.close', 'settings.manage', 'providers.read', 'providers.manage', 'logs.read', 'ops.read', 'audit.read', 'audit.export', 'ops.issues.report', 'ops.issues.manage', 'ops.issues.attachments', 'ops.jobs.manage', 'updates.write', 'updates.publish', 'staff.read', 'staff.manage', 'access.review', 'break_glass.approve')),
	CONSTRAINT "four_eyes_rule_phase_chk" CHECK ("four_eyes_rule"."phase" in ('P1', 'P2')),
	CONSTRAINT "four_eyes_rule_validity_chk" CHECK ("four_eyes_rule"."max_validity" > interval '0')
);
--> statement-breakpoint
CREATE TABLE "operator_grant_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "operator_grant_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"operator_user_id" text NOT NULL,
	"capability" text NOT NULL,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"actor_user_id" text,
	"reason" text NOT NULL,
	"approval_request_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_grant_event_cap_chk" CHECK ("operator_grant_event"."capability" in ('dashboard.read', 'tenants.read', 'tenants.manage', 'tenants.verify', 'shipping.manage', 'billing.read', 'billing.manage', 'finance.read', 'payouts.process', 'refunds.process', 'payouts.reconcile', 'ledger.adjust', 'affiliate.accounts.read', 'affiliate.accounts.review', 'affiliate.policy.manage', 'affiliate.payout.process', 'affiliate.disputes.manage', 'accounts.read', 'accounts.support', 'accounts.suspend', 'accounts.identifiers.review', 'accounts.reveal', 'members.recover', 'cases.read', 'cases.write', 'moderation.manage', 'complaints.manage', 'privacy.requests.manage', 'incidents.manage', 'compliance.read', 'privacy.export.approve', 'tax.read', 'tax.manage', 'tax.approve', 'tax.remit', 'tax.documents.issue', 'tax.identity.review', 'tax.period.close', 'settings.manage', 'providers.read', 'providers.manage', 'logs.read', 'ops.read', 'audit.read', 'audit.export', 'ops.issues.report', 'ops.issues.manage', 'ops.issues.attachments', 'ops.jobs.manage', 'updates.write', 'updates.publish', 'staff.read', 'staff.manage', 'access.review', 'break_glass.approve')),
	CONSTRAINT "operator_grant_event_action_chk" CHECK ("operator_grant_event"."action" in ('grant', 'revoke')),
	CONSTRAINT "operator_grant_event_source_chk" CHECK ("operator_grant_event"."source" in ('product', 'system_bootstrap', 'system_recovery')),
	CONSTRAINT "operator_grant_event_reason_chk" CHECK (length(btrim("operator_grant_event"."reason")) > 0),
	CONSTRAINT "operator_grant_event_source_actor_chk" CHECK (("operator_grant_event"."source" = 'product' and "operator_grant_event"."actor_user_id" is not null) or ("operator_grant_event"."source" <> 'product' and "operator_grant_event"."actor_user_id" is null and "operator_grant_event"."approval_request_id" is null))
);
--> statement-breakpoint
CREATE TABLE "operator_step_up_proof" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"action_key" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session_mfa" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"method" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_job_kind" (
	"kind" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_class" (
	"class" text PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"time_column" text NOT NULL,
	"row_filter" text DEFAULT 'true' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_policy" (
	"class" text NOT NULL,
	"period_days" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policy_class_pk" PRIMARY KEY("class"),
	CONSTRAINT "retention_policy_period_chk" CHECK ("retention_policy"."period_days" >= 1)
);
--> statement-breakpoint
CREATE TABLE "scheduler_cursor" (
	"kind" text PRIMARY KEY NOT NULL,
	"last_period_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler_heartbeat" (
	"name" text PRIMARY KEY NOT NULL,
	"last_tick_at" timestamp with time zone NOT NULL,
	"last_enqueued_count" integer DEFAULT 0 NOT NULL,
	"tick_interval_ms" integer NOT NULL,
	CONSTRAINT "scheduler_heartbeat_interval_chk" CHECK ("scheduler_heartbeat"."tick_interval_ms" > 0 and "scheduler_heartbeat"."last_enqueued_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "operator_grant" DROP CONSTRAINT "operator_grant_cap_chk";--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_status_chk";--> statement-breakpoint
-- T-74: rows that are still 'failed' become 'dead' before the check constraint is re-added with the new status set.
UPDATE "job" SET "status" = 'dead' WHERE "status" = 'failed';--> statement-breakpoint
DROP INDEX "job_claim_idx";--> statement-breakpoint
ALTER TABLE "job" ALTER COLUMN "store_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_grant" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "priority" smallint DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "lease_ms" integer DEFAULT 60000 NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_action_key_four_eyes_rule_action_key_fk" FOREIGN KEY ("action_key") REFERENCES "public"."four_eyes_rule"("action_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_requested_by_platform_operator_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_decided_by_platform_operator_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grant" ADD CONSTRAINT "break_glass_grant_requested_by_platform_operator_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grant" ADD CONSTRAINT "break_glass_grant_approved_by_platform_operator_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grant" ADD CONSTRAINT "break_glass_grant_reviewed_by_platform_operator_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_grant_event" ADD CONSTRAINT "operator_grant_event_approval_request_id_approval_request_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_step_up_proof" ADD CONSTRAINT "operator_step_up_proof_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_mfa" ADD CONSTRAINT "session_mfa_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy" ADD CONSTRAINT "retention_policy_class_retention_class_class_fk" FOREIGN KEY ("class") REFERENCES "public"."retention_class"("class") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_request_open_uq" ON "approval_request" USING btree ("action_key","target_kind","target_id","payload_sha256") WHERE "approval_request"."status" in ('pending', 'approved');--> statement-breakpoint
CREATE INDEX "approval_request_requester_idx" ON "approval_request" USING btree ("requested_by","status");--> statement-breakpoint
CREATE INDEX "operator_grant_event_operator_idx" ON "operator_grant_event" USING btree ("operator_user_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "operator_step_up_session_idx" ON "operator_step_up_proof" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "job_claim_idx" ON "job" USING btree ("priority","next_attempt_at","id") WHERE "job"."status" in ('pending', 'running');--> statement-breakpoint
ALTER TABLE "operator_grant" ADD CONSTRAINT "operator_grant_cap_chk" CHECK ("operator_grant"."capability" in ('dashboard.read', 'tenants.read', 'tenants.manage', 'tenants.verify', 'shipping.manage', 'billing.read', 'billing.manage', 'finance.read', 'payouts.process', 'refunds.process', 'payouts.reconcile', 'ledger.adjust', 'affiliate.accounts.read', 'affiliate.accounts.review', 'affiliate.policy.manage', 'affiliate.payout.process', 'affiliate.disputes.manage', 'accounts.read', 'accounts.support', 'accounts.suspend', 'accounts.identifiers.review', 'accounts.reveal', 'members.recover', 'cases.read', 'cases.write', 'moderation.manage', 'complaints.manage', 'privacy.requests.manage', 'incidents.manage', 'compliance.read', 'privacy.export.approve', 'tax.read', 'tax.manage', 'tax.approve', 'tax.remit', 'tax.documents.issue', 'tax.identity.review', 'tax.period.close', 'settings.manage', 'providers.read', 'providers.manage', 'logs.read', 'ops.read', 'audit.read', 'audit.export', 'ops.issues.report', 'ops.issues.manage', 'ops.issues.attachments', 'ops.jobs.manage', 'updates.write', 'updates.publish', 'staff.read', 'staff.manage', 'access.review', 'break_glass.approve'));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_priority_chk" CHECK ("job"."priority" in (0, 1, 2));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_lease_chk" CHECK ("job"."lease_ms" > 0);--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_dispatch_chk" CHECK ("job"."status" <> 'pending' or "job"."dispatched_at" is null);--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_status_chk" CHECK ("job"."status" in ('pending', 'running', 'done', 'dead', 'unknown'));--> statement-breakpoint

-- ===== T-59: roles, resolver functions, per-table platform grants, audit_log policy (hand-written) =====
-- T-59 (RLS framework and narrow platform grants), EXPAND step. Hand-written: drizzle-kit models neither
-- roles, grants, policies nor SECURITY DEFINER functions. The parent folds this file into the next
-- numbered migration verbatim (docs/DECISIONS.md D-9, D-22 item 4); until then packages/db/test/global-setup.ts
-- and the rls tests apply it after the migrations. Every statement is safe to run twice.
--
-- Expand only: nothing is revoked here. The previous web version keeps working (it still reads the
-- store, cart, channel, handoff and invitation lookups through the platform pool). The contract step,
-- which revokes the old table-wide grants of bukalaris_platform, is drizzle-pending/t59-contract.sql
-- and may only run after the new web version is deployed and the owner approves (D-22 item 4).
--
-- Needs the superuser bootstrap packages/db/docker/05-roles.sql first (the roles and the membership of
-- bukalaris_owner in the two no-login roles); a DBA step in production (docs/DEPLOY-COOLIFY.md).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bukalaris_resolver') OR NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bukalaris_restricted') THEN
    RAISE EXCEPTION 'roles bukalaris_resolver and bukalaris_restricted must exist (packages/db/docker/05-roles.sql; docs/DEPLOY-COOLIFY.md "Database roles")';
  END IF;
  IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'bukalaris_restricted') THEN
    RAISE EXCEPTION 'role bukalaris_restricted must be NOBYPASSRLS (only bukalaris_resolver reads across stores); see docs/DEPLOY-COOLIFY.md "Database roles"';
  END IF;
  IF NOT pg_has_role('bukalaris_owner', 'bukalaris_resolver', 'USAGE') OR NOT pg_has_role('bukalaris_owner', 'bukalaris_restricted', 'USAGE') THEN
    RAISE EXCEPTION 'bukalaris_owner must be a member of bukalaris_resolver and bukalaris_restricted (05-roles.sql: GRANT ... TO bukalaris_owner)';
  END IF;
END $$;--> statement-breakpoint

-- The schema is created without a PUBLIC usage grant on a wiped local database (and may be in production):
-- the no-login roles need it to resolve the schema-qualified names their functions use.
GRANT USAGE ON SCHEMA public TO bukalaris_resolver, bukalaris_restricted;--> statement-breakpoint

-- ── Contexts ────────────────────────────────────────────────────────────────────────────────
-- Same shape as app_store_id() (0007): transaction-local setting, NULL when unset, so a missing context
-- compares to NULL and matches no row.
-- These settings guard against application bugs, not against SQL run by the app role itself: any app-role session can
-- set them (ADR-0005 amendment, limit of the GUC contexts; T-59c replaces the audit writer setting by a definer function).
CREATE OR REPLACE FUNCTION app_buyer_id() RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.buyer_id', true), '')::bigint $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_affiliate_id() RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.affiliate_id', true), '')::bigint $$;--> statement-breakpoint
-- The named writers allowed to insert store-less audit_log rows from the app role. Adding a writer is a
-- migration (and an entry in AUDIT_STORELESS_WRITERS in platform/isolation-registry.ts), never a runtime value.
-- Returns the writer when it is on the list, NULL for a missing or unknown one.
CREATE OR REPLACE FUNCTION app_audit_writer() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT w FROM (SELECT nullif(current_setting('app.audit_writer', true), '') AS w) x WHERE w = ANY (ARRAY['account.security']) $$;--> statement-breakpoint

-- ── audit_log: store rows as before, store-less rows only from a named writer ──────────────────
DROP POLICY IF EXISTS tenant_isolation ON "audit_log";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "audit_log"
  USING ("store_id" = app_store_id())
  WITH CHECK ("store_id" = app_store_id() OR ("store_id" IS NULL AND app_audit_writer() IS NOT NULL));--> statement-breakpoint

-- ── Cross-store resolvers (ADR-0005 amendment 4) ────────────────────────────────────────────
-- SECURITY DEFINER functions owned by the no-login BYPASSRLS role bukalaris_resolver, executable by
-- bukalaris_app only. Fixed search_path, schema-qualified names, one fixed statement each, store id
-- (and for storefront and seller lookups name, slug, status, role) as the only output: a SQL injection
-- through a storefront lookup reaches these functions, not payouts or buyer data. The caller continues
-- on the app pool inside that store's context. The tables the owner may read are exactly the `reads`
-- of DEFINER_FUNCTIONS in platform/isolation-registry.ts.
GRANT SELECT ON "store", "membership", "cart", "storefront_channel", "feed_token", "checkout_handoff", "store_invitation", "order" TO bukalaris_resolver;--> statement-breakpoint

CREATE OR REPLACE FUNCTION resolve_store_by_slug(p_slug text) RETURNS TABLE (id bigint, name text, slug text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT s.id, s.name, s.slug FROM public.store s WHERE s.slug = p_slug AND s.status = 'active' $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_member_stores(p_user_id text) RETURNS TABLE (store_id bigint, name text, slug text, status text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT s.id, s.name, s.slug, s.status, m.role FROM public.membership m JOIN public.store s ON s.id = m.store_id WHERE m.user_id = p_user_id ORDER BY s.id $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_cart_store(p_cart_id uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT c.store_id FROM public.cart c WHERE c.id = p_cart_id $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_channel_store(p_prefix text, p_token_hash text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT c.store_id FROM public.storefront_channel c WHERE c.token_prefix = p_prefix AND c.token_hash = p_token_hash $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_feed_store(p_prefix text, p_token_hash text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT f.store_id FROM public.feed_token f WHERE f.token_prefix = p_prefix AND f.token_hash = p_token_hash AND f.status = 'active' $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_handoff_store(p_code_hash text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT h.store_id FROM public.checkout_handoff h WHERE h.code_hash = p_code_hash $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_invitation_store(p_token_hash text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT i.store_id FROM public.store_invitation i WHERE i.token_hash = p_token_hash $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_order_store(p_order_id bigint) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT o.store_id FROM public."order" o WHERE o.id = p_order_id $$;--> statement-breakpoint

-- Ownership moves to the resolver (the new owner needs CREATE on the schema for the move only), then
-- EXECUTE is taken from PUBLIC and given to the app role (and, for the scope constructors and the cart lookup that the local seeds call, the platform role).
GRANT CREATE ON SCHEMA public TO bukalaris_resolver;--> statement-breakpoint
ALTER FUNCTION resolve_store_by_slug(text) OWNER TO bukalaris_resolver;--> statement-breakpoint
ALTER FUNCTION resolve_member_stores(text) OWNER TO bukalaris_resolver;--> statement-breakpoint
ALTER FUNCTION resolve_cart_store(uuid) OWNER TO bukalaris_resolver;--> statement-breakpoint
ALTER FUNCTION resolve_channel_store(text, text) OWNER TO bukalaris_resolver;--> statement-breakpoint
ALTER FUNCTION resolve_feed_store(text, text) OWNER TO bukalaris_resolver;--> statement-breakpoint
ALTER FUNCTION resolve_handoff_store(text) OWNER TO bukalaris_resolver;--> statement-breakpoint
ALTER FUNCTION resolve_invitation_store(text) OWNER TO bukalaris_resolver;--> statement-breakpoint
ALTER FUNCTION resolve_order_store(bigint) OWNER TO bukalaris_resolver;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM bukalaris_resolver;--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_store_by_slug(text), resolve_member_stores(text), resolve_cart_store(uuid), resolve_channel_store(text, text), resolve_feed_store(text, text), resolve_handoff_store(text), resolve_invitation_store(text), resolve_order_store(bigint) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_store_by_slug(text), resolve_member_stores(text), resolve_cart_store(uuid), resolve_channel_store(text, text), resolve_feed_store(text, text), resolve_handoff_store(text), resolve_invitation_store(text), resolve_order_store(bigint) TO bukalaris_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_store_by_slug(text), resolve_member_stores(text), resolve_cart_store(uuid) TO bukalaris_platform;--> statement-breakpoint

-- ── bukalaris_platform: per table and operation (the `platform` column of the isolation registry) ──────
-- Added next to the table-wide grants of 0007, which stay until the contract step: the privileges are the
-- same bits today, so this changes nothing for the running version. It makes the narrow set explicit, and
-- the invariant test checks that every registry privilege is held.
GRANT SELECT, INSERT ON "audit_log" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, DELETE ON "cart" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "job" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "mail_outbox" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "membership" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "operator_grant" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "order" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "order_line" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "order_notification" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "order_redaction" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, DELETE ON "order_signal_context" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "order_status_history" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "platform_operator" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "product" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, DELETE ON "rate_limit" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, DELETE ON "session" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "shipment" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "shipping_margin_rule" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "signal_destination" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "signal_event" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "store" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "system_log" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "user" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "collection", "page", "media" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "variant" TO bukalaris_platform;--> statement-breakpoint

-- ===== T-74: platform job kinds, scheduler, retention functions (hand-written) =====
-- T-74 hand-written SQL (periodic enqueuer, job hardening, retention framework). Pending: the parent folds this
-- file and t74-jobs.generated.sql into the next numbered migration (docs/DECISIONS.md D-9). Every statement is
-- idempotent (IF NOT EXISTS / OR REPLACE / ON CONFLICT / DROP IF EXISTS) so a second apply is harmless.
--
-- FOLD ORDER (populated databases): the generated file replaces `job_status_chk` (it drops it at its statement 5
-- and re-adds it, with 'failed' replaced by 'dead' and 'unknown' added, at its last statement). Rows that are
-- still 'failed' must be rewritten between those two statements, or the re-add fails and the migration rolls
-- back: put the next statement immediately after `ALTER TABLE "job" DROP CONSTRAINT "job_status_chk"`.
-- Run after the generated statements it is a no-op.

-- ── Platform-wide job kinds: the only kinds that may have store_id NULL ────────────────────────────────────────
-- Written by migrations only (platform has SELECT). These registry/state tables are platform class like
-- platform_operator: no tenant policy and no grant to the app role (T-59 registers their class). The job policy
-- `store_id = app_store_id()` already hides NULL-store rows from the app role and refuses its inserts of them
-- (NULL = anything is never true).
REVOKE ALL ON "platform_job_kind" FROM PUBLIC, bukalaris_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "platform_job_kind" FROM bukalaris_platform;--> statement-breakpoint
INSERT INTO "platform_job_kind" ("kind") VALUES
  ('retention.signal_event'), ('retention.system_log'), ('retention.audit_log'), ('retention.job')
ON CONFLICT ("kind") DO NOTHING;--> statement-breakpoint

CREATE OR REPLACE FUNCTION job_platform_kind_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.store_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.platform_job_kind k WHERE k.kind = NEW.kind) THEN
      RAISE EXCEPTION 'job kind % is not a registered platform-wide kind: store_id is required', NEW.kind USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION job_platform_kind_guard() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS job_platform_kind_guard ON "job";--> statement-breakpoint
CREATE TRIGGER job_platform_kind_guard BEFORE INSERT OR UPDATE OF store_id, kind ON "job"
  FOR EACH ROW EXECUTE FUNCTION job_platform_kind_guard();--> statement-breakpoint

-- ── Scheduler heartbeat: platform only, single-row upserts, never deleted ──────────────────────────────────────
REVOKE ALL ON "scheduler_heartbeat" FROM PUBLIC, bukalaris_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "scheduler_heartbeat" FROM bukalaris_platform;--> statement-breakpoint
-- scheduler_cursor: the newest period enqueued per kind (state, not a log): never deleted, platform only.
REVOKE ALL ON "scheduler_cursor" FROM PUBLIC, bukalaris_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "scheduler_cursor" FROM bukalaris_platform;--> statement-breakpoint

-- ── Retention registry and policy ──────────────────────────────────────────────────────────────────────────────
-- retention_class: owner-written registry (platform SELECT). retention_policy: one row per class that the owner
-- enabled; NO row = purge disabled, and no period is seeded (D-22 item 3; the periods are an OPEN privacy decision).
REVOKE ALL ON "retention_class", "retention_policy" FROM PUBLIC, bukalaris_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "retention_class" FROM bukalaris_platform;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "retention_policy" FROM bukalaris_platform;--> statement-breakpoint
-- Review finding (T-74): a platform login that could write the period could also purge audit history without a trace.
-- Periods change only through retention_set_period() below, which checks the actor and writes an append-only event.
-- `job` (done) and `job_dead` are separate classes so a dead letter (kept for triage, OBS-7) is only ever purged
-- when the owner sets its own period. Never purged by any class: pending, running, unknown jobs and pending signals.
-- `personal_data_access_event` (T-62) registers its class and wrapper with the migration that creates the table.
INSERT INTO "retention_class" ("class", "table_name", "time_column", "row_filter") VALUES
  ('signal_event', 'signal_event', 'created_at', $f$status <> 'pending'$f$),
  ('system_log', 'system_log', 'time', 'true'),
  ('audit_log', 'audit_log', 'created_at', 'true'),
  ('job', 'job', 'updated_at', $f$status = 'done'$f$),
  ('job_dead', 'job', 'updated_at', $f$status = 'dead'$f$)
ON CONFLICT ("class") DO NOTHING;--> statement-breakpoint

-- Append-only history of every period change, in its own table so no purge class can ever delete it.
CREATE TABLE IF NOT EXISTS "retention_policy_event" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "class" text NOT NULL,
  "period_days" integer,
  "actor_user_id" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "retention_policy_event_period_chk" CHECK ("period_days" IS NULL OR "period_days" >= 1),
  CONSTRAINT "retention_policy_event_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);--> statement-breakpoint
REVOKE ALL ON "retention_policy_event" FROM PUBLIC, bukalaris_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "retention_policy_event" FROM bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "retention_policy_event" TO bukalaris_platform;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "append_only_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "retention_policy_event_append_only" ON "retention_policy_event";--> statement-breakpoint
CREATE TRIGGER "retention_policy_event_append_only" BEFORE UPDATE OR DELETE ON "retention_policy_event" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();--> statement-breakpoint

-- Set (days >= 1) or clear (NULL) the period of a class. Runs as the table owner; the actor must be an operator who
-- holds ops.jobs.manage now, the change is validated and recorded in the same statement. The platform login holds
-- EXECUTE on this and SELECT on the tables, nothing else.
CREATE OR REPLACE FUNCTION retention_set_period(p_class text, p_days integer, p_actor text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'retention: a reason is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_days IS NOT NULL AND p_days < 1 THEN
    RAISE EXCEPTION 'retention: the period must be a whole number of days >= 1' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.retention_class c WHERE c.class = p_class) THEN
    RAISE EXCEPTION 'retention: unknown class %', p_class USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Re-review (T-74): until operator identity lives in restricted tables (T-59b) the platform login can read the holders of
  -- ops.jobs.manage and name one of them as p_actor, so one forged call could start erasing audit history. The audit class
  -- therefore has no setter yet; it is enabled together with four-eyes on its period (TASKS T-59b, T-74 deferred).
  IF p_class = 'audit_log' THEN
    RAISE EXCEPTION 'retention: the audit_log period cannot be set until operator identity is restricted (T-59b)' USING ERRCODE = 'feature_not_supported';
  END IF;
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.operator_grant g
    WHERE g.user_id = p_actor AND g.capability = 'ops.jobs.manage' AND (g.expires_at IS NULL OR g.expires_at > pg_catalog.now())
  ) THEN
    RAISE EXCEPTION 'retention: the actor does not hold ops.jobs.manage' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_days IS NULL THEN
    DELETE FROM public.retention_policy WHERE class = p_class;
  ELSE
    INSERT INTO public.retention_policy (class, period_days) VALUES (p_class, p_days)
    ON CONFLICT (class) DO UPDATE SET period_days = EXCLUDED.period_days, updated_at = pg_catalog.now();
  END IF;
  INSERT INTO public.retention_policy_event (class, period_days, actor_user_id, reason)
  VALUES (p_class, p_days, p_actor, pg_catalog.left(pg_catalog.btrim(p_reason), 500));
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION retention_set_period(text, integer, text, text) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION retention_set_period(text, integer, text, text) TO bukalaris_platform;--> statement-breakpoint

-- The purge. Runs as the function owner (bukalaris_owner, the table owner) with a fixed search_path whose
-- pg_temp comes last, every catalog and table reference schema-qualified, and an explicit refusal when the caller
-- has put a relation named pg_* in its temporary schema (spoofed catalog, D-21). No period or clock argument: the
-- period is read from retention_policy and "older than" is the database clock. Rows are skipped when any foreign
-- key found in pg_constraint still references them (for every referencing table, whatever its ON DELETE action).
-- Returns the number of rows deleted (0 when the class is disabled).
CREATE OR REPLACE FUNCTION retention_purge(p_class text, p_batch integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_class public.retention_class%ROWTYPE;
  v_days integer;
  v_refs text := '';
  v_fk record;
  v_table text;
  v_deleted bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname LIKE 'pg\_%') THEN
    RAISE EXCEPTION 'retention purge refused: a temporary relation shadows a system catalog' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION 'retention purge: batch must be between 1 and 10000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_class FROM public.retention_class WHERE class = p_class;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention purge: unknown class %', p_class USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT period_days INTO v_days FROM public.retention_policy WHERE class = p_class;
  IF NOT FOUND THEN
    RETURN 0; -- no period configured: purge is off
  END IF;
  v_table := pg_catalog.format('public.%I', v_class.table_name);
  FOR v_fk IN
    SELECT con.conrelid::pg_catalog.regclass::text AS ref_table,
           (SELECT pg_catalog.string_agg(pg_catalog.format('r.%I = s.%I', ra.attname, pa.attname), ' AND ' ORDER BY k.ord)
              FROM unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(ref_attnum, pk_attnum, ord)
              JOIN pg_catalog.pg_attribute ra ON ra.attrelid = con.conrelid AND ra.attnum = k.ref_attnum
              JOIN pg_catalog.pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = k.pk_attnum) AS cond
      FROM pg_catalog.pg_constraint con
     WHERE con.contype = 'f' AND con.confrelid = v_table::pg_catalog.regclass
  LOOP
    v_refs := v_refs || pg_catalog.format(' AND NOT EXISTS (SELECT 1 FROM %s r WHERE %s)', v_fk.ref_table, v_fk.cond);
  END LOOP;
  EXECUTE pg_catalog.format(
    'DELETE FROM %1$s d WHERE d.ctid IN (SELECT s.ctid FROM %1$s s WHERE s.%2$I < pg_catalog.now() - pg_catalog.make_interval(days => $1) AND (%3$s)%4$s ORDER BY s.%2$I LIMIT $2 FOR UPDATE SKIP LOCKED)',
    v_table, v_class.time_column, v_class.row_filter, v_refs
  ) USING v_days, p_batch;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION retention_purge(text, integer) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint

-- One named function per class; EXECUTE for the platform role only (the web app role cannot call them).
CREATE OR REPLACE FUNCTION retention_purge_signal_event(p_batch integer) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT public.retention_purge('signal_event', p_batch) $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION retention_purge_system_log(p_batch integer) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT public.retention_purge('system_log', p_batch) $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION retention_purge_audit_log(p_batch integer) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT public.retention_purge('audit_log', p_batch) $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION retention_purge_job(p_batch integer) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT public.retention_purge('job', p_batch) $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION retention_purge_job_dead(p_batch integer) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT public.retention_purge('job_dead', p_batch) $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION retention_purge_signal_event(integer), retention_purge_system_log(integer), retention_purge_audit_log(integer), retention_purge_job(integer), retention_purge_job_dead(integer) FROM PUBLIC, bukalaris_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION retention_purge_signal_event(integer), retention_purge_system_log(integer), retention_purge_audit_log(integer), retention_purge_job(integer), retention_purge_job_dead(integer) TO bukalaris_platform;--> statement-breakpoint

-- ===== T-60: capability tables, four_eyes_rule seed, triggers (hand-written) =====
-- T-60 hand-written part of the capability migration (platform capability grants, IAM-8, IAM-15, DATA-14).
-- Applies AFTER drizzle-pending/t60-capabilities.generated.sql. Idempotent: a second apply changes nothing.
-- Statements are separated by the drizzle breakpoint marker so the parent can paste this file into a migration.

-- 1. The IAM-15 four-eyes matrix as data. 24h is a conservative placeholder validity, not an owner decision (D-22 item 3);
--    a migration changes it, there is no runtime write.
INSERT INTO "four_eyes_rule" ("action_key", "capability", "phase", "max_validity", "active") VALUES
  ('grant.sensitive', 'staff.manage', 'P1', interval '24 hours', true),
  ('breakglass.approve', 'break_glass.approve', 'P1', interval '24 hours', true),
  ('payout.approve_transfer', 'payouts.process', 'P1', interval '24 hours', true),
  ('refund.approve_transfer', 'refunds.process', 'P1', interval '24 hours', true),
  ('affiliate_payout.approve_transfer', 'affiliate.payout.process', 'P1', interval '24 hours', true),
  ('cod.manual_complete', 'payouts.process', 'P1', interval '24 hours', true),
  ('cod.reconcile_release', 'payouts.reconcile', 'P1', interval '24 hours', true),
  ('ledger.adjust', 'ledger.adjust', 'P1', interval '24 hours', true),
  ('billing.comp', 'billing.manage', 'P1', interval '24 hours', true),
  ('billing.mark_paid', 'billing.manage', 'P1', interval '24 hours', true),
  ('billing.plan_price', 'billing.manage', 'P1', interval '24 hours', true),
  ('shipping.margin', 'shipping.manage', 'P1', interval '24 hours', true),
  ('affiliate.rate_bounds', 'affiliate.policy.manage', 'P1', interval '24 hours', true),
  ('providers.rotate', 'providers.manage', 'P1', interval '24 hours', true),
  ('mfa.reset', 'accounts.support', 'P1', interval '24 hours', true),
  ('account.close', 'accounts.suspend', 'P1', interval '24 hours', true),
  ('merge.execute', 'accounts.identifiers.review', 'P1', interval '24 hours', false),
  ('ownership.recover', 'members.recover', 'P1', interval '24 hours', false),
  ('privacy.export', 'privacy.export.approve', 'P2', interval '24 hours', false),
  ('audit.export', 'audit.export', 'P2', interval '24 hours', false),
  ('tax.approve', 'tax.approve', 'P2', interval '24 hours', false),
  ('tax.remit', 'tax.remit', 'P2', interval '24 hours', false),
  ('tax.period_reopen', 'tax.period.close', 'P2', interval '24 hours', false),
  ('updates.publish', 'updates.publish', 'P2', interval '24 hours', false)
ON CONFLICT ("action_key") DO NOTHING;--> statement-breakpoint

-- 2. Operators that exist before T-60 could create stores, suspend them and change the shipping margin: keep exactly those
--    powers (and the store audit read) as explicit grants so no operator is locked out. staff.manage and break_glass.approve
--    are never backfilled: the bootstrap command creates the first holders (IAM-15).
INSERT INTO "operator_grant" ("user_id", "capability")
SELECT o."user_id", c.cap FROM "platform_operator" o CROSS JOIN (VALUES ('tenants.read'), ('tenants.manage'), ('shipping.manage'), ('audit.read')) AS c(cap)
ON CONFLICT ("user_id", "capability") DO NOTHING;--> statement-breakpoint
INSERT INTO "operator_grant_event" ("operator_user_id", "capability", "action", "source", "reason")
SELECT g."user_id", g."capability", 'grant', 'system_bootstrap', 'migration backfill: operator powers that existed before capability grants (T-60)'
FROM "operator_grant" g
WHERE g."capability" IN ('tenants.read', 'tenants.manage', 'shipping.manage', 'audit.read')
  AND NOT EXISTS (SELECT 1 FROM "operator_grant_event" e WHERE e."operator_user_id" = g."user_id" AND e."capability" = g."capability");--> statement-breakpoint

-- 3. The matrix and the append-only history are not writable by the runtime platform role (the table owner migrates them).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "four_eyes_rule" FROM "bukalaris_platform";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "operator_grant_event" FROM "bukalaris_platform";--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "approval_request", "break_glass_grant" FROM "bukalaris_platform";--> statement-breakpoint

-- 4. operator_grant_event is append-only (also against the table owner, who is not covered by the REVOKE above).
CREATE OR REPLACE FUNCTION "operator_grant_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operator_grant_event is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "operator_grant_event_append_only" ON "operator_grant_event";--> statement-breakpoint
CREATE TRIGGER "operator_grant_event_append_only" BEFORE UPDATE OR DELETE ON "operator_grant_event" FOR EACH ROW EXECUTE FUNCTION "operator_grant_event_append_only"();--> statement-breakpoint

-- 5. approval_request: identity fields are immutable, moves are pending -> approved|rejected|expired|cancelled and
--    approved -> executed|expired|cancelled, expiry is bounded by the rule, and the approver must hold the rule's capability
--    through a standing operator_grant (never break_glass_grant, which this function does not read) at decision and at execution.
CREATE OR REPLACE FUNCTION "approval_request_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r public."four_eyes_rule"%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public."four_eyes_rule" WHERE "action_key" = NEW."action_key";
  IF TG_OP = 'INSERT' THEN
    IF NOT r."active" THEN
      RAISE EXCEPTION 'four-eyes action % is not active', NEW."action_key" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'pending' THEN
      RAISE EXCEPTION 'an approval request starts pending' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."expires_at" > now() + r."max_validity" THEN
      RAISE EXCEPTION 'approval expiry exceeds the rule validity' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."action_key", NEW."target_kind", NEW."target_id", NEW."payload_sha256", NEW."payload_canonical", NEW."requested_by", NEW."reason", NEW."expires_at", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."action_key", OLD."target_kind", OLD."target_id", OLD."payload_sha256", OLD."payload_canonical", OLD."requested_by", OLD."reason", OLD."expires_at", OLD."created_at") THEN
    RAISE EXCEPTION 'an approval request is immutable except for its decision' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD."status" = 'pending' AND NEW."status" IN ('approved', 'rejected', 'expired', 'cancelled'))
       OR (OLD."status" = 'approved' AND NEW."status" IN ('executed', 'expired', 'cancelled'))) THEN
    RAISE EXCEPTION 'illegal approval transition % -> %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'pending' AND (NEW."decided_by", NEW."decided_at") IS DISTINCT FROM (OLD."decided_by", OLD."decided_at") THEN
    RAISE EXCEPTION 'the decision of an approval request cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('approved', 'rejected', 'executed') THEN
    IF NEW."status" <> 'rejected' AND NEW."expires_at" <= now() THEN
      RAISE EXCEPTION 'approval request expired' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."operator_grant" g WHERE g."user_id" = NEW."decided_by" AND g."capability" = r."capability" AND (g."expires_at" IS NULL OR g."expires_at" > now())) THEN
      RAISE EXCEPTION 'the approver does not hold %', r."capability" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "approval_request_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "approval_request_guard" ON "approval_request";--> statement-breakpoint
CREATE TRIGGER "approval_request_guard" BEFORE INSERT OR UPDATE ON "approval_request" FOR EACH ROW EXECUTE FUNCTION "approval_request_guard"();--> statement-breakpoint

-- 6. break_glass_grant: only the revoke and review fields change, once; never deleted.
CREATE OR REPLACE FUNCTION "break_glass_grant_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'break_glass_grant rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Review finding (T-60): the approver of a break-glass grant must be an operator who holds break_glass.approve now.
    IF NOT EXISTS (SELECT 1 FROM public."operator_grant" g WHERE g."user_id" = NEW."approved_by" AND g."capability" = 'break_glass.approve' AND (g."expires_at" IS NULL OR g."expires_at" > pg_catalog.now())) THEN
      RAISE EXCEPTION 'the approver does not hold break_glass.approve' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."requested_by", NEW."approved_by", NEW."capabilities", NEW."target_kind", NEW."target_id", NEW."case_id", NEW."reason", NEW."starts_at", NEW."expires_at")
     IS DISTINCT FROM (OLD."id", OLD."requested_by", OLD."approved_by", OLD."capabilities", OLD."target_kind", OLD."target_id", OLD."case_id", OLD."reason", OLD."starts_at", OLD."expires_at") THEN
    RAISE EXCEPTION 'only the revoke and review fields of a break-glass grant can change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION 'a break-glass grant is revoked once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."reviewed_at" IS NOT NULL AND (NEW."reviewed_by", NEW."reviewed_at") IS DISTINCT FROM (OLD."reviewed_by", OLD."reviewed_at") THEN
    RAISE EXCEPTION 'a break-glass grant is reviewed once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "break_glass_grant_guard" ON "break_glass_grant";--> statement-breakpoint
REVOKE ALL ON FUNCTION "break_glass_grant_guard"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "break_glass_grant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "break_glass_grant" FOR EACH ROW EXECUTE FUNCTION "break_glass_grant_guard"();--> statement-breakpoint
