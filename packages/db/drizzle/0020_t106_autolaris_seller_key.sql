CREATE TABLE "payment_anomaly" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_anomaly_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"attempt_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_anomaly_uq" UNIQUE("attempt_id","kind"),
	CONSTRAINT "payment_anomaly_kind_chk" CHECK ("payment_anomaly"."kind" in ('second_settled', 'paid_after_close'))
);
--> statement-breakpoint
CREATE TABLE "payment_channel_lock" (
	"channel_code" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"locked_by" text NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_channel_lock_chk" CHECK ("payment_channel_lock"."channel_code" ~ '^[A-Z0-9_-]{1,40}$' and length("payment_channel_lock"."reason") between 3 and 500)
);
--> statement-breakpoint
CREATE TABLE "payment_fee_rate" (
	"version" integer NOT NULL,
	"channel_code" text NOT NULL,
	"base" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"fixed_idr" bigint NOT NULL,
	"created_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_fee_rate_pk" PRIMARY KEY("version","channel_code"),
	CONSTRAINT "payment_fee_rate_chk" CHECK ("payment_fee_rate"."version" >= 1 and "payment_fee_rate"."channel_code" ~ '^[A-Z0-9_-]{1,40}$' and "payment_fee_rate"."base" in ('goods_omset', 'payable', 'flat') and "payment_fee_rate"."rate_bps" between 0 and 10000
    and "payment_fee_rate"."fixed_idr" between 0 and 1000000 and ("payment_fee_rate"."base" <> 'flat' or "payment_fee_rate"."rate_bps" = 0) and length("payment_fee_rate"."reason") between 3 and 500)
);
--> statement-breakpoint
CREATE TABLE "payment_manual_confirmation" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_manual_confirmation_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"attempt_id" uuid NOT NULL,
	"order_id" bigint NOT NULL,
	"confirmed_by" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_manual_attempt_uq" UNIQUE("attempt_id"),
	CONSTRAINT "payment_manual_text_chk" CHECK (length("payment_manual_confirmation"."reason") between 5 and 500 and length("payment_manual_confirmation"."evidence") between 3 and 500)
);
--> statement-breakpoint
CREATE TABLE "payment_production_switch" (
	"provider" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"sandbox_pass_at" timestamp with time zone,
	"sandbox_pass_evidence" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "payment_production_switch_chk" CHECK ("payment_production_switch"."provider" = 'autolaris' and (not "payment_production_switch"."enabled" or "payment_production_switch"."sandbox_pass_at" is not null)
  and (("payment_production_switch"."sandbox_pass_at" is null) = ("payment_production_switch"."sandbox_pass_evidence" is null)) and ("payment_production_switch"."sandbox_pass_evidence" is null or length("payment_production_switch"."sandbox_pass_evidence") between 3 and 500))
);
--> statement-breakpoint
ALTER TABLE "payment_attempt" DROP CONSTRAINT "payment_attempt_order_uq";--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "attempt_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "payment_account_id" bigint;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "fee_bearer" text DEFAULT 'buyer' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "fee_rate_version" integer;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "expected_fee_idr" bigint;--> statement-breakpoint
ALTER TABLE "payment_observation" ADD COLUMN "status_word" text;--> statement-breakpoint
ALTER TABLE "store_payment_account" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "store_payment_account" ADD COLUMN "excluded_channels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "store_payment_account" ADD COLUMN "fee_bearer" text DEFAULT 'buyer' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_anomaly" ADD CONSTRAINT "payment_anomaly_attempt_fk" FOREIGN KEY ("store_id","attempt_id") REFERENCES "public"."payment_attempt"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_manual_confirmation" ADD CONSTRAINT "payment_manual_attempt_fk" FOREIGN KEY ("store_id","attempt_id") REFERENCES "public"."payment_attempt"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_manual_confirmation" ADD CONSTRAINT "payment_manual_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_account_fk" FOREIGN KEY ("store_id","payment_account_id") REFERENCES "public"."store_payment_account"("store_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "payment_attempt_check_idx" ON "payment_attempt" USING btree ("payment_account_id","next_advice_at");--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_order_no_uq" UNIQUE("store_id","order_id","attempt_no");--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_account_chk" CHECK ("payment_attempt"."attempt_no" >= 1 and ("payment_attempt"."payment_account_id" is null) = ("payment_attempt"."environment" is null) and ("payment_attempt"."payment_account_id" is not null or "payment_attempt"."attempt_no" = 1)
    and "payment_attempt"."fee_bearer" in ('buyer', 'seller') and ("payment_attempt"."expected_fee_idr" is null or "payment_attempt"."expected_fee_idr" >= 0) and ("payment_attempt"."fee_bearer" = 'buyer' or "payment_attempt"."admin_fee_idr" = 0));--> statement-breakpoint
ALTER TABLE "payment_observation" ADD CONSTRAINT "payment_observation_word_chk" CHECK ("payment_observation"."status_word" is null or "payment_observation"."status_word" ~ '^[A-Za-z0-9 _.-]{1,64}$');--> statement-breakpoint
ALTER TABLE "store_payment_account" ADD CONSTRAINT "payment_account_prefs_chk" CHECK ("store_payment_account"."fee_bearer" in ('buyer', 'seller') and cardinality("store_payment_account"."excluded_channels") <= 40);--> statement-breakpoint
-- ===== T-106 AutoLaris on the seller's key (ADR-0013 sections 3 to 6, decision 34, D-21, D-27, D-33) ===============================================
-- Hand-written; everything of T-106 that drizzle-kit does not generate sits in this one section, so the generated part above can be regenerated
-- mechanically when this migration is renumbered at integration. Order: grants and policies, seeds, guards, functions, job kinds, demo reset.

-- 1. store_payment_account: the seller's preferences (master switch, excluded channels, fee bearer) are read and written by the application role
--    for its own store (FORCE RLS, owner capability in the service); the platform pool gains column UPDATE on the four envelope columns only, to
--    re-seal a key under the leading ring key (JOB-23 for the payment ring; provider_account_guard restricts the application role only).
GRANT SELECT (enabled, excluded_channels, fee_bearer), UPDATE (enabled, excluded_channels, fee_bearer) ON public.store_payment_account TO bukalaris_app;--> statement-breakpoint
GRANT UPDATE (sealed_key, key_id, sealed_at, key_fingerprint) ON public.store_payment_account TO bukalaris_platform;--> statement-breakpoint

-- 2. New store-owned tables: FORCE RLS on the store key; append-only (no UPDATE or DELETE grant, and a trigger for every role).
REVOKE ALL ON public.payment_manual_confirmation, public.payment_anomaly FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
ALTER TABLE public.payment_manual_confirmation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.payment_manual_confirmation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.payment_manual_confirmation USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.payment_anomaly ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.payment_anomaly FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.payment_anomaly USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT ON public.payment_manual_confirmation TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.payment_manual_confirmation TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON public.payment_anomaly TO bukalaris_app, bukalaris_platform;--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_manual_confirmation_append_only ON public.payment_manual_confirmation;--> statement-breakpoint
CREATE TRIGGER payment_manual_confirmation_append_only BEFORE UPDATE OR DELETE ON public.payment_manual_confirmation FOR EACH ROW EXECUTE FUNCTION public.payment_evidence_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_anomaly_append_only ON public.payment_anomaly;--> statement-breakpoint
CREATE TRIGGER payment_anomaly_append_only BEFORE UPDATE OR DELETE ON public.payment_anomaly FOR EACH ROW EXECUTE FUNCTION public.payment_evidence_guard();--> statement-breakpoint

-- 3. Platform settings (shared-read): every store reads them at checkout; only the Owner console (platform pool) writes. The fee schedule is
--    append-only (a new version, never an edit).
REVOKE ALL ON public.payment_channel_lock, public.payment_fee_rate, public.payment_production_switch FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON public.payment_channel_lock, public.payment_fee_rate, public.payment_production_switch TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.payment_channel_lock TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON public.payment_fee_rate TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON public.payment_production_switch TO bukalaris_platform;--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_fee_rate_append_only ON public.payment_fee_rate;--> statement-breakpoint
CREATE TRIGGER payment_fee_rate_append_only BEFORE UPDATE OR DELETE ON public.payment_fee_rate FOR EACH ROW EXECUTE FUNCTION public.payment_evidence_guard();--> statement-breakpoint

-- 4. Seeds. Fee schedule version 1 = the starting data of the reference system (decision 19), UNVERIFIED with AutoLaris; the production switch
--    of decision 34 starts OFF with no recorded sandbox pass.
INSERT INTO public.payment_fee_rate (version, channel_code, base, rate_bps, fixed_idr, created_by, reason) VALUES
  (1, 'QRIS', 'goods_omset', 70, 0, 'migration:T-106', 'starting data from the reference system; UNVERIFIED with AutoLaris (ADR-0013 decision 19)'),
  (1, 'VABCA', 'flat', 0, 6500, 'migration:T-106', 'starting data from the reference system; UNVERIFIED with AutoLaris (ADR-0013 decision 19)'),
  (1, 'VABNI', 'flat', 0, 3000, 'migration:T-106', 'starting data from the reference system; UNVERIFIED with AutoLaris (ADR-0013 decision 19)'),
  (1, 'VABRI', 'flat', 0, 3000, 'migration:T-106', 'starting data from the reference system; UNVERIFIED with AutoLaris (ADR-0013 decision 19)'),
  (1, 'VAMANDIRI', 'flat', 0, 3000, 'migration:T-106', 'starting data from the reference system; UNVERIFIED with AutoLaris (ADR-0013 decision 19)'),
  (1, 'VAPERMATA', 'flat', 0, 3000, 'migration:T-106', 'starting data from the reference system; UNVERIFIED with AutoLaris (ADR-0013 decision 19)'),
  (1, 'OVO', 'payable', 300, 0, 'migration:T-106', 'starting data from the reference system; UNVERIFIED with AutoLaris (ADR-0013 decision 19)')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO public.payment_production_switch (provider, enabled) VALUES ('autolaris', false) ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 5. payment_attempt: the T-106 columns are part of the immutable identity and money of an attempt.
CREATE OR REPLACE FUNCTION public.payment_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."store_id", NEW."order_id", NEW."owner_kind", NEW."owner_id", NEW."request_key", NEW."reff_id", NEW."channel_code", NEW."customer", NEW."amount_idr", NEW."admin_fee_idr", NEW."total_idr", NEW."expires_at", NEW."created_at",
      NEW."attempt_no", NEW."payment_account_id", NEW."environment", NEW."fee_bearer", NEW."fee_rate_version", NEW."expected_fee_idr")
     IS DISTINCT FROM (OLD."id", OLD."store_id", OLD."order_id", OLD."owner_kind", OLD."owner_id", OLD."request_key", OLD."reff_id", OLD."channel_code", OLD."customer", OLD."amount_idr", OLD."admin_fee_idr", OLD."total_idr", OLD."expires_at", OLD."created_at",
      OLD."attempt_no", OLD."payment_account_id", OLD."environment", OLD."fee_bearer", OLD."fee_rate_version", OLD."expected_fee_idr") THEN
    RAISE EXCEPTION 'the identity and amounts of a payment attempt are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'paid' AND NEW."status" <> 'paid' THEN
    RAISE EXCEPTION 'a paid payment is never regressed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."paid_at" IS NOT NULL AND NEW."paid_at" IS DISTINCT FROM OLD."paid_at" THEN
    RAISE EXCEPTION 'paid_at is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."transaction_id" IS NOT NULL AND NEW."transaction_id" IS DISTINCT FROM OLD."transaction_id" THEN
    RAISE EXCEPTION 'the provider transaction id is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."instruction" IS NOT NULL AND NEW."instruction" IS DISTINCT FROM OLD."instruction" THEN
    RAISE EXCEPTION 'the payment instruction is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."request_state" IN ('accepted', 'failed') AND NEW."request_state" <> OLD."request_state" THEN
    RAISE EXCEPTION 'a resolved creation outcome does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revision" < OLD."revision" THEN
    RAISE EXCEPTION 'the revision only moves forward' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 6. An attempt starts pending and empty (T-49). T-106 adds: an attempt on the store's own account carries that account's environment; the
--    first attempt of an order is number 1; a retry (number n > 1) exists only on the store's own account, as the next number, while the order
--    still awaits payment, no attempt of it is paid and the previous attempt failed or expired. The platform account keeps one attempt per order.
CREATE OR REPLACE FUNCTION public.payment_attempt_insert_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_prev public.payment_attempt%ROWTYPE;
BEGIN
  IF NEW."status" <> 'pending' OR NEW."request_state" <> 'in_progress' OR NEW."transaction_id" IS NOT NULL OR NEW."instruction" IS NOT NULL
     OR NEW."paid_at" IS NOT NULL OR NEW."revision" <> 1 OR NEW."advice_polls" <> 0 OR NEW."provider_fee_idr" IS NOT NULL THEN
    RAISE EXCEPTION 'a payment attempt starts pending and empty' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."order" o WHERE o."store_id" = NEW."store_id" AND o."id" = NEW."order_id" AND o."payment_method" <> 'cod' AND o."total" = NEW."amount_idr") THEN
    RAISE EXCEPTION 'a payment attempt needs a non-COD order of the same store with the same total' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."payment_account_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.store_payment_account p WHERE p.store_id = NEW."store_id" AND p.id = NEW."payment_account_id" AND p.environment = NEW."environment") THEN
    RAISE EXCEPTION 'an attempt on the store''s own account carries that account''s environment' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_prev FROM public.payment_attempt a WHERE a.store_id = NEW."store_id" AND a.order_id = NEW."order_id" ORDER BY a.attempt_no DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW."attempt_no" <> 1 THEN
      RAISE EXCEPTION 'the first attempt of an order is number 1' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."payment_account_id" IS NULL OR v_prev.payment_account_id IS NULL OR NEW."attempt_no" <> v_prev.attempt_no + 1 THEN
    RAISE EXCEPTION 'a retry is the next attempt on the store''s own account' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (v_prev.request_state = 'failed' OR (v_prev.request_state = 'accepted' AND v_prev.expires_at <= pg_catalog.now()))
     OR EXISTS (SELECT 1 FROM public.payment_attempt a WHERE a.store_id = NEW."store_id" AND a.order_id = NEW."order_id" AND a.status = 'paid')
     OR NOT EXISTS (SELECT 1 FROM public."order" o WHERE o."store_id" = NEW."store_id" AND o."id" = NEW."order_id" AND o."status" = 'awaiting_payment') THEN
    RAISE EXCEPTION 'a retry needs an unpaid order awaiting payment whose last attempt failed or expired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 7. A manual confirmation names an attempt of that order of the same store, on the store's own account, that is not already paid by the provider
--    (definer: reads the attempt as the owner; the app role holds SELECT on it anyway).
CREATE FUNCTION public.payment_manual_confirmation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.payment_attempt a WHERE a.store_id = NEW.store_id AND a.id = NEW.attempt_id AND a.order_id = NEW.order_id AND a.payment_account_id IS NOT NULL AND a.status <> 'paid') THEN
    RAISE EXCEPTION 'a manual confirmation names an unpaid attempt of that order on the store''s own account' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.payment_manual_confirmation_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER payment_manual_confirmation_guard BEFORE INSERT ON public.payment_manual_confirmation FOR EACH ROW EXECUTE FUNCTION public.payment_manual_confirmation_guard();--> statement-breakpoint

-- 8. The worker opens a store's key through the same function as the web app (bound to app_store_id(), set by withStore).
GRANT EXECUTE ON FUNCTION public.provider_key_envelope(bigint, text) TO bukalaris_platform;--> statement-breakpoint

-- 9. Platform job kinds: the scheduled status check on the stores' own keys (decision 23) and the payment-ring re-seal (JOB-23).
INSERT INTO public.platform_job_kind (kind) VALUES ('payment.status_check'), ('payment.credentials.reseal') ON CONFLICT (kind) DO NOTHING;--> statement-breakpoint

-- 9a. The account FK above was added NOT VALID (AGENTS.md: a foreign key on a populated table); every existing attempt has no account, so it validates at once.
ALTER TABLE public.payment_attempt VALIDATE CONSTRAINT payment_attempt_account_fk;--> statement-breakpoint

-- 9b. Decision 24 / review finding 2: the application role moves an order of the store's own AutoLaris account from awaiting payment to placed only
--     with a manual confirmation recorded for it (`confirmPaymentByHand`); the bare seller "pay" action is refused. The worker's verified status
--     check (platform role) and the owner are not restricted. Invoker trigger: it reads only the store's own rows, which RLS allows.
CREATE FUNCTION public.order_seller_payment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER') THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.payment_attempt a WHERE a.store_id = NEW.store_id AND a.order_id = NEW.id AND a.payment_account_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.payment_manual_confirmation m WHERE m.store_id = NEW.store_id AND m.order_id = NEW.id) THEN
    RAISE EXCEPTION 'a payment on the store''s own AutoLaris account is confirmed with a manual confirmation record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.order_seller_payment_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER order_seller_payment_guard BEFORE UPDATE OF status ON public."order" FOR EACH ROW
  WHEN (OLD.status = 'awaiting_payment' AND NEW.status = 'placed') EXECUTE FUNCTION public.order_seller_payment_guard();--> statement-breakpoint

-- 9c. The four-eyes row `providers.production_on` (production ON for seller provider keys) is seeded by migration 0019 (T-105) and shared.

-- 9d. Retention classes (C-P10, T-74 framework): the manual confirmations and the anomalies are financial records kept with the order. Registered so a
--     period can be held by the audited setter; the generic purge can never delete them (row_filter false), like `payment_callback` (the AutoLaris callback
--     evidence of seller attempts lives in that table and class: raw body redacted once the owner records a period, digest kept).
INSERT INTO public.retention_class (class, table_name, time_column, row_filter) VALUES
  ('payment_manual_confirmation', 'payment_manual_confirmation', 'created_at', 'false'),
  ('payment_anomaly', 'payment_anomaly', 'created_at', 'false')
ON CONFLICT (class) DO NOTHING;--> statement-breakpoint

-- 10. Local demo reset: the new append-only rows of demo stores go with their payment evidence.
CREATE OR REPLACE FUNCTION public.reset_demo_payments(p_store_ids bigint[]) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ids bigint[];
  v_total bigint := 0;
  v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname LIKE 'pg\_%') THEN
    RAISE EXCEPTION 'reset refused: a temporary relation shadows a system catalog' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT pg_catalog.array_agg(s.id) INTO v_ids FROM public.store s WHERE s.id = ANY (p_store_ids) AND s.slug LIKE 'demo-%';
  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM pg_catalog.set_config('bukalaris.payment_evidence_reset', 'demo', true);
  DELETE FROM public.payment_manual_confirmation WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_anomaly WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.late_payment_obligation WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_callback WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_observation WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_attempt_event WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_attempt WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  PERFORM pg_catalog.set_config('bukalaris.payment_evidence_reset', '', true);
  RETURN v_total;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reset_demo_payments(bigint[]) FROM PUBLIC, bukalaris_app, bukalaris_platform;
