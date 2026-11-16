CREATE TABLE "provider_live_setting" (
	"provider" text PRIMARY KEY NOT NULL,
	"sandbox_passed_at" timestamp with time zone,
	"sandbox_pass_note" text,
	"sandbox_pass_by" text,
	"production_enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_live_setting_provider_chk" CHECK ("provider_live_setting"."provider" in ('mengantar', 'autolaris')),
	CONSTRAINT "provider_live_setting_pass_chk" CHECK (("provider_live_setting"."sandbox_passed_at" is null) = ("provider_live_setting"."sandbox_pass_note" is null) and ("provider_live_setting"."sandbox_passed_at" is null) = ("provider_live_setting"."sandbox_pass_by" is null)),
	CONSTRAINT "provider_live_setting_switch_chk" CHECK (not "provider_live_setting"."production_enabled" or "provider_live_setting"."sandbox_passed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "shipping_area" (
	"area_id" text NOT NULL,
	"environment" text NOT NULL,
	"province_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_area_pk" PRIMARY KEY("area_id","environment"),
	CONSTRAINT "shipping_area_id_chk" CHECK ("shipping_area"."area_id" ~ '^[a-f0-9]{24}$' and "shipping_area"."environment" in ('sandbox', 'production') and ("shipping_area"."province_name" is null or length("shipping_area"."province_name") <= 80))
);
--> statement-breakpoint
CREATE TABLE "store_courier_rule" (
	"store_id" bigint NOT NULL,
	"courier_code" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cod_enabled" boolean DEFAULT false NOT NULL,
	"cod_refused_at" timestamp with time zone,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_courier_rule_pk" PRIMARY KEY("store_id","courier_code"),
	CONSTRAINT "store_courier_rule_code_chk" CHECK ("store_courier_rule"."courier_code" ~ '^[A-Za-z0-9_-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "store_shipping_setting" (
	"store_id" bigint PRIMARY KEY NOT NULL,
	"cod_enabled" boolean DEFAULT true NOT NULL,
	"cod_fee_bearer" text DEFAULT 'buyer' NOT NULL,
	"cod_blocked_provinces" text[] DEFAULT '{}'::text[] NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_shipping_setting_bearer_chk" CHECK ("store_shipping_setting"."cod_fee_bearer" in ('buyer', 'seller')),
	CONSTRAINT "store_shipping_setting_provinces_chk" CHECK ("store_shipping_setting"."cod_blocked_provinces" <@ array['aceh', 'sumatera-utara', 'sumatera-barat', 'riau', 'jambi', 'sumatera-selatan', 'bengkulu', 'lampung', 'kepulauan-bangka-belitung', 'kepulauan-riau', 'dki-jakarta', 'jawa-barat', 'jawa-tengah', 'di-yogyakarta', 'jawa-timur', 'banten', 'bali', 'nusa-tenggara-barat', 'nusa-tenggara-timur', 'kalimantan-barat', 'kalimantan-tengah', 'kalimantan-selatan', 'kalimantan-timur', 'kalimantan-utara', 'sulawesi-utara', 'sulawesi-tengah', 'sulawesi-selatan', 'sulawesi-tenggara', 'gorontalo', 'sulawesi-barat', 'maluku', 'maluku-utara', 'papua', 'papua-barat', 'papua-selatan', 'papua-tengah', 'papua-pegunungan', 'papua-barat-daya']::text[])
);
--> statement-breakpoint
ALTER TABLE "shipment" DROP CONSTRAINT "shipment_status_chk";--> statement-breakpoint
ALTER TABLE "shipment" DROP CONSTRAINT "shipment_booked_chk";--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "test_order" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "pickup_type" text DEFAULT 'scheduled_pickup' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD COLUMN "pickup_address_id" text;--> statement-breakpoint
ALTER TABLE "store_courier_rule" ADD CONSTRAINT "store_courier_rule_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_shipping_setting" ADD CONSTRAINT "store_shipping_setting_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_provider_order_uq" ON "shipment" USING btree ("store_id","provider_order_id") WHERE "shipment"."provider_order_id" is not null;--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_pickup_type_chk" CHECK ("shipment"."pickup_type" in ('scheduled_pickup', 'drop_off'));--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_status_chk" CHECK ("shipment"."status" in ('queued', 'booking', 'unknown', 'awaiting_account', 'awaiting_balance', 'booked', 'in_transit', 'delivered', 'returned', 'problem', 'cancelled', 'failed'));--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_booked_chk" CHECK ("shipment"."status" in ('queued', 'booking', 'unknown', 'awaiting_account', 'failed') or "shipment"."provider_order_id" is not null);--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD CONSTRAINT "shipping_account_pickup_chk" CHECK (("store_shipping_account"."pickup_registered_at" is null) = ("store_shipping_account"."pickup_address_id" is null) and ("store_shipping_account"."pickup_address_id" is null or "store_shipping_account"."pickup_address_id" ~ '^[A-Za-z0-9_-]{1,64}$'));--> statement-breakpoint

-- ===== T-105 (ADR-0013 sections 4, 7 and 9; C-P2, C-P4, C-P10; D-31) =====
-- Hand-written: grants, policies and guards (drizzle-kit models none of them). The generated statements above are untouched. Every new table
-- starts empty, so nothing is backfilled; the new columns are nullable or carry a constant default (metadata-only on PostgreSQL 11+). The new
-- `shipping_account_pickup_chk` holds on existing rows: no code path wrote `pickup_registered_at` before this task (T-104 only cleared it).
-- bukalaris_platform keeps the table-wide default privileges of migration 0007 until the T-59 contract step (expand rule); the registry lists what
-- it needs afterwards.

-- 1. The seller's courier rules and COD settings: tenant tables under FORCE RLS. The app role writes them for its own store (capability
--    `shipping.manage` in the service); the worker turns a courier's COD off after a provider refusal (UPDATE on the rules only).
REVOKE ALL ON public.store_courier_rule FROM PUBLIC, bukalaris_app;--> statement-breakpoint
ALTER TABLE public.store_courier_rule ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.store_courier_rule FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.store_courier_rule USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.store_courier_rule TO bukalaris_app;--> statement-breakpoint
REVOKE ALL ON public.store_shipping_setting FROM PUBLIC, bukalaris_app;--> statement-breakpoint
ALTER TABLE public.store_shipping_setting ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.store_shipping_setting FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.store_shipping_setting USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.store_shipping_setting TO bukalaris_app;--> statement-breakpoint

-- 2. Platform rows without a tenant key. The province of a provider area is written by the app role from a provider answer (area search) and
--    read at quote and submit; the production switch is read by the app role and written only by the Owner console (platform pool).
REVOKE ALL ON public.shipping_area FROM PUBLIC, bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.shipping_area TO bukalaris_app;--> statement-breakpoint
REVOKE ALL ON public.provider_live_setting FROM PUBLIC, bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.provider_live_setting TO bukalaris_app;--> statement-breakpoint

-- 3. The registered pickup address id of the store's own Mengantar account (read for readiness and the seller screen, written with a registration).
GRANT SELECT (pickup_address_id), UPDATE (pickup_address_id) ON public.store_shipping_account TO bukalaris_app;--> statement-breakpoint

-- 4. The T-104 known gap (track report "Open points"): the app role could set the readiness columns of its own `seller_owned` row freely. They stay
--    app-written (the provider call runs in the request), but bounded: a check time and a pickup registration carry the statement's own time, a
--    passed check carries its check time, a registration needs a connected key that passed its check, and neither survives a change of key or
--    environment (the registration belongs to one provider account). Body identical to 0018 apart from the marked T-105 blocks.
CREATE OR REPLACE FUNCTION public.provider_account_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_app boolean := NOT (pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER'));
  v_new jsonb := pg_catalog.to_jsonb(NEW);
  v_old jsonb := CASE WHEN TG_OP = 'UPDATE' THEN pg_catalog.to_jsonb(OLD) ELSE NULL END;
  v_provider text := CASE WHEN TG_TABLE_NAME = 'store_shipping_account' THEN 'mengantar' ELSE 'autolaris' END;
BEGIN
  -- T-105: a pickup registration belongs to one provider account; a key or environment change of a seller row drops it (every role).
  IF TG_OP = 'UPDATE' AND v_provider = 'mengantar' AND v_old->>'kind' = 'seller_owned'
     AND (v_new->>'key_fingerprint', v_new->>'environment') IS DISTINCT FROM (v_old->>'key_fingerprint', v_old->>'environment') THEN
    NEW.pickup_registered_at := NULL;
    NEW.pickup_address_id := NULL;
    v_new := pg_catalog.to_jsonb(NEW);
  END IF;
  IF NOT v_app THEN RETURN NEW; END IF;
  IF v_provider = 'mengantar' AND (v_new->>'kind' IS DISTINCT FROM 'seller_owned' OR (TG_OP = 'UPDATE' AND v_old->>'kind' IS DISTINCT FROM 'seller_owned')) THEN
    RAISE EXCEPTION 'a seller writes only its own provider account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_new->>'sealed_key' IS NOT NULL OR v_new->>'status' <> 'needs_key' OR v_new->>'last_result' IS NOT NULL OR v_new->>'step_up_ref' IS NOT NULL THEN
      RAISE EXCEPTION 'a provider account starts empty; its key is written with a step-up' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (v_new->>'sealed_key', v_new->>'key_id', v_new->>'key_fingerprint', v_new->>'environment') IS DISTINCT FROM (v_old->>'sealed_key', v_old->>'key_id', v_old->>'key_fingerprint', v_old->>'environment') THEN
    IF NOT EXISTS (SELECT 1 FROM public.store_step_up_proof pr WHERE pr.id = (v_new->>'step_up_ref')::uuid AND pr.store_id = (v_new->>'store_id')::bigint
                   AND pr.action_key = 'integrations.provider_key' AND pr.subject_kind = 'store' AND pr.subject_id = v_provider AND pr.consumed_at = pg_catalog.now()) THEN
      RAISE EXCEPTION 'a provider key change needs a step-up proof consumed in this transaction' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF v_new->>'step_up_ref' IS DISTINCT FROM v_old->>'step_up_ref' THEN
    RAISE EXCEPTION 'the step-up reference moves only with a key change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- T-105: the readiness columns (ADR-0013 decision 12) carry the time of the statement that wrote them.
  IF v_new->>'last_checked_at' IS DISTINCT FROM v_old->>'last_checked_at' AND v_new->>'last_checked_at' IS NOT NULL
     AND (v_new->>'last_checked_at')::timestamptz <> pg_catalog.now() THEN
    RAISE EXCEPTION 'a connection check is recorded at the time it ran' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_new->>'last_result' = 'ready' AND v_new->>'last_result' IS DISTINCT FROM v_old->>'last_result'
     AND (v_new->>'last_checked_at' IS NULL OR (v_new->>'last_checked_at')::timestamptz <> pg_catalog.now()) THEN
    RAISE EXCEPTION 'a passed check is recorded with its check time' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_provider = 'mengantar' AND v_new->>'pickup_registered_at' IS NOT NULL
     AND (v_new->>'pickup_registered_at', v_new->>'pickup_address_id') IS DISTINCT FROM (v_old->>'pickup_registered_at', v_old->>'pickup_address_id')
     AND ((v_new->>'pickup_registered_at')::timestamptz <> pg_catalog.now() OR v_new->>'status' <> 'active' OR v_new->>'last_result' IS DISTINCT FROM 'ready') THEN
    RAISE EXCEPTION 'a pickup registration is recorded at the time it ran, on a connected key that passed its check' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 5. The test-order marker (decision 11) is set once at submit: no role changes it afterwards.
CREATE FUNCTION public.order_test_marker_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.test_order IS DISTINCT FROM OLD.test_order THEN
    RAISE EXCEPTION 'the test-order marker is set once at submit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.order_test_marker_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER order_test_marker_guard BEFORE UPDATE OF test_order ON public."order" FOR EACH ROW EXECUTE FUNCTION public.order_test_marker_guard();
--> statement-breakpoint

-- 6. Review minor 1 (aligned with T-106): switching production calls on seller provider keys ON is four-eyes (requested, approved by a second
--    operator, consumed once by the requester); switching OFF stays immediate. One row serves both providers (target id = the provider); T-106's
--    identical seed is dropped at integration. A migration is the only writer of the matrix.
INSERT INTO public.four_eyes_rule (action_key, capability, phase, max_validity, active) VALUES ('providers.production_on', 'providers.manage', 'P1', interval '24 hours', true)
ON CONFLICT (action_key) DO NOTHING;
