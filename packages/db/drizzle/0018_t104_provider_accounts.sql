CREATE TABLE "store_payment_account" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "store_payment_account_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"environment" text NOT NULL,
	"status" text DEFAULT 'needs_key' NOT NULL,
	"sealed_key" text,
	"key_id" text,
	"sealed_at" timestamp with time zone,
	"key_fingerprint" text,
	"key_hint" text,
	"last_checked_at" timestamp with time zone,
	"last_result" text,
	"origin_area_id" text,
	"destination_area_id" text,
	"shipper_email" text,
	"sender_address" text,
	"payment_only_confirmed_at" timestamp with time zone,
	"payment_only_confirmed_by" text,
	"step_up_ref" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_account_store_uq" UNIQUE("store_id"),
	CONSTRAINT "payment_account_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "payment_account_env_chk" CHECK ("store_payment_account"."environment" in ('sandbox', 'production') and "store_payment_account"."status" in ('active', 'needs_key')),
	CONSTRAINT "payment_account_sealed_chk" CHECK (("store_payment_account"."status" = 'active') = ("store_payment_account"."sealed_key" is not null)
    and (("store_payment_account"."sealed_key" is null and "store_payment_account"."key_id" is null and "store_payment_account"."sealed_at" is null and "store_payment_account"."key_fingerprint" is null and "store_payment_account"."key_hint" is null)
      or ("store_payment_account"."sealed_key" is not null and "store_payment_account"."key_id" is not null and "store_payment_account"."sealed_at" is not null and "store_payment_account"."key_fingerprint" is not null and "store_payment_account"."key_hint" is not null))),
	CONSTRAINT "payment_account_result_chk" CHECK ("store_payment_account"."last_result" is null or "store_payment_account"."last_result" in ('ready', 'AUTH_FAILED', 'PROVIDER_UNAVAILABLE', 'INVALID_RESPONSE')),
	CONSTRAINT "payment_account_fields_chk" CHECK (("store_payment_account"."origin_area_id" is null or "store_payment_account"."origin_area_id" ~ '^[A-Za-z0-9_-]{1,64}$') and ("store_payment_account"."destination_area_id" is null or "store_payment_account"."destination_area_id" ~ '^[A-Za-z0-9_-]{1,64}$')
    and ("store_payment_account"."shipper_email" is null or length("store_payment_account"."shipper_email") between 3 and 254) and ("store_payment_account"."sender_address" is null or length("store_payment_account"."sender_address") between 10 and 500)
    and (("store_payment_account"."payment_only_confirmed_at" is null) = ("store_payment_account"."payment_only_confirmed_by" is null)))
);
--> statement-breakpoint
ALTER TABLE "store_shipping_account" DROP CONSTRAINT "shipping_account_kind_chk";--> statement-breakpoint
ALTER TABLE "store_shipping_account" DROP CONSTRAINT "shipping_account_sealed_chk";--> statement-breakpoint
ALTER TABLE "store_shipping_account" DROP CONSTRAINT "shipping_account_active_chk";--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD COLUMN "key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD COLUMN "key_hint" text;--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD COLUMN "pickup_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD COLUMN "step_up_ref" uuid;--> statement-breakpoint
ALTER TABLE "store_payment_account" ADD CONSTRAINT "store_payment_account_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD CONSTRAINT "shipping_account_seller_chk" CHECK (("store_shipping_account"."kind" = 'seller_owned') = ("store_shipping_account"."environment" is not null) and ("store_shipping_account"."environment" is null or "store_shipping_account"."environment" in ('sandbox', 'production'))
    and ("store_shipping_account"."kind" <> 'seller_owned' or ("store_shipping_account"."status" in ('active', 'needs_key') and ("store_shipping_account"."status" = 'active') = ("store_shipping_account"."sealed_key" is not null)))
    and ("store_shipping_account"."sealed_key" is null or "store_shipping_account"."kind" <> 'seller_owned' or ("store_shipping_account"."key_fingerprint" is not null and "store_shipping_account"."key_hint" is not null))
    and ("store_shipping_account"."sealed_key" is not null or ("store_shipping_account"."key_fingerprint" is null and "store_shipping_account"."key_hint" is null and "store_shipping_account"."pickup_registered_at" is null)));--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD CONSTRAINT "shipping_account_kind_chk" CHECK ("store_shipping_account"."kind" in ('partner_managed', 'platform_master', 'seller_owned'));--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD CONSTRAINT "shipping_account_sealed_chk" CHECK (("store_shipping_account"."sealed_key" is null and "store_shipping_account"."key_id" is null and "store_shipping_account"."sealed_at" is null) or ("store_shipping_account"."sealed_key" is not null and "store_shipping_account"."key_id" is not null and "store_shipping_account"."sealed_at" is not null and "store_shipping_account"."kind" in ('partner_managed', 'seller_owned')));--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD CONSTRAINT "shipping_account_active_chk" CHECK ("store_shipping_account"."status" <> 'active' or "store_shipping_account"."kind" = 'platform_master' or ("store_shipping_account"."sealed_key" is not null and ("store_shipping_account"."mengantar_seller_id" is not null or "store_shipping_account"."kind" = 'seller_owned')));--> statement-breakpoint
-- ===== T-104 seller provider accounts (ADR-0013 sections 1 to 3, D-27) ==================================================================
-- The store's own Mengantar account (`store_shipping_account`, kind `seller_owned`) and AutoLaris account (`store_payment_account`). The
-- application role writes them for its own store only (FORCE RLS), never reads a sealed column (no SELECT grant), and opens an envelope only
-- through provider_key_envelope(), which refuses every store but app_store_id(). A key or environment change by the application role needs
-- a step-up proof of the store consumed in the same transaction (provider_account_guard).

-- 1. store_payment_account: tenant table under FORCE RLS. bukalaris_platform reads only (the T-106 worker opens keys like the T-48 worker does);
--    nothing deletes a row but the owner-side demo reset below.
REVOKE ALL ON public.store_payment_account FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON public.store_payment_account TO bukalaris_platform;--> statement-breakpoint
ALTER TABLE public.store_payment_account ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.store_payment_account FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.store_payment_account USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT INSERT (store_id, environment, status) ON public.store_payment_account TO bukalaris_app;--> statement-breakpoint
GRANT SELECT (id, store_id, environment, status, key_hint, key_fingerprint, last_checked_at, last_result, origin_area_id, destination_area_id, shipper_email, sender_address, payment_only_confirmed_at, revision) ON public.store_payment_account TO bukalaris_app;--> statement-breakpoint
GRANT UPDATE (environment, status, sealed_key, key_id, sealed_at, key_fingerprint, key_hint, last_checked_at, last_result, origin_area_id, destination_area_id, shipper_email, sender_address, payment_only_confirmed_at, payment_only_confirmed_by, step_up_ref, revision, updated_at) ON public.store_payment_account TO bukalaris_app;--> statement-breakpoint

-- 2. store_shipping_account: the application role may insert (only the five columns of an empty row) and update its own `seller_owned` row
--    (guarded below), and reads the non-secret columns. The Partner and master rows stay platform-written (T-48).
GRANT INSERT (store_id, kind, status, external_user_id, environment) ON public.store_shipping_account TO bukalaris_app;--> statement-breakpoint
GRANT SELECT (environment, key_hint, key_fingerprint, pickup_registered_at) ON public.store_shipping_account TO bukalaris_app;--> statement-breakpoint
GRANT UPDATE (environment, status, sealed_key, key_id, sealed_at, key_fingerprint, key_hint, last_checked_at, last_result, pickup_registered_at, step_up_ref, revision, updated_at) ON public.store_shipping_account TO bukalaris_app;--> statement-breakpoint

-- 3. Connection-check results are codes (the existing guard keeps refusing free text); AUTH_FAILED joins the list.
CREATE OR REPLACE FUNCTION public.shipping_account_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.shipping_reset', true) = 'demo' THEN RETURN OLD; END IF; -- reset_demo_shipping() below is the only deleter
    RAISE EXCEPTION 'shipping account identities are retained' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.store_id, NEW.kind, NEW.external_user_id) IS DISTINCT FROM (OLD.id, OLD.store_id, OLD.kind, OLD.external_user_id) THEN
    RAISE EXCEPTION 'shipping account identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.mengantar_seller_id IS NOT NULL AND NEW.mengantar_seller_id IS DISTINCT FROM OLD.mengantar_seller_id THEN
    RAISE EXCEPTION 'remote seller identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'disabled' AND NEW.status <> 'disabled' THEN
    RAISE EXCEPTION 'provider disablement cannot be bypassed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.last_result IS NOT NULL AND NEW.last_result NOT IN ('ready', 'EMAIL_ALREADY_REGISTERED', 'SELLER_DEACTIVATED', 'API_KEY_DISABLED', 'RATE_LIMITED', 'INVALID_RESPONSE', 'PROVIDER_UNAVAILABLE', 'AUTH_FAILED') THEN
    RAISE EXCEPTION 'health stores codes only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 4. The seller-side write rules of both tables (an invoker trigger: it reads only the store's own step-up proofs, which RLS already allows).
--    Login roles other than bukalaris_app (the worker re-seal, the owner) are not restricted here.
CREATE FUNCTION public.provider_account_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_app boolean := NOT (pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER'));
  v_new jsonb := pg_catalog.to_jsonb(NEW);
  v_old jsonb := CASE WHEN TG_OP = 'UPDATE' THEN pg_catalog.to_jsonb(OLD) ELSE NULL END;
  v_provider text := CASE WHEN TG_TABLE_NAME = 'store_shipping_account' THEN 'mengantar' ELSE 'autolaris' END;
BEGIN
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
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.provider_account_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER provider_account_guard BEFORE INSERT OR UPDATE ON public.store_shipping_account FOR EACH ROW EXECUTE FUNCTION public.provider_account_guard();--> statement-breakpoint
CREATE TRIGGER provider_account_guard BEFORE INSERT OR UPDATE ON public.store_payment_account FOR EACH ROW EXECUTE FUNCTION public.provider_account_guard();--> statement-breakpoint

-- 5. The only read of a sealed envelope by the application role: its own store's, for the server-side provider client.
CREATE FUNCTION public.provider_key_envelope(p_store_id bigint, p_provider text) RETURNS TABLE (account_id bigint, key_id text, sealed_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_store_id IS NULL OR p_store_id IS DISTINCT FROM public.app_store_id() THEN
    RAISE EXCEPTION 'provider key of another store' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_provider = 'mengantar' THEN
    RETURN QUERY SELECT a.id, a.key_id, a.sealed_key FROM public.store_shipping_account a WHERE a.store_id = p_store_id AND a.kind = 'seller_owned' AND a.sealed_key IS NOT NULL;
  ELSIF p_provider = 'autolaris' THEN
    RETURN QUERY SELECT a.id, a.key_id, a.sealed_key FROM public.store_payment_account a WHERE a.store_id = p_store_id AND a.sealed_key IS NOT NULL;
  ELSE
    RAISE EXCEPTION 'unknown provider' USING ERRCODE = 'invalid_parameter_value';
  END IF;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.provider_key_envelope(bigint, text) FROM PUBLIC, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.provider_key_envelope(bigint, text) TO bukalaris_app;--> statement-breakpoint

-- 6. Local demo reset (owner connection only): a demo store's own AutoLaris account row goes with its shipping accounts.
CREATE OR REPLACE FUNCTION public.reset_demo_shipping(p_store_ids bigint[]) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_ids bigint[]; v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname LIKE 'pg\_%') THEN
    RAISE EXCEPTION 'reset refused: a temporary relation shadows a system catalog' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT pg_catalog.array_agg(s.id) INTO v_ids FROM public.store s WHERE s.id = ANY (p_store_ids) AND s.slug LIKE 'demo-%';
  IF v_ids IS NULL THEN RETURN 0; END IF;
  SELECT pg_catalog.count(DISTINCT b.id) INTO v_n FROM public.reconciliation_batch b JOIN public.store_shipping_account a ON a.id = b.shipping_account_id WHERE a.store_id = ANY (v_ids);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'demo reset refused: % reconciliation batch(es) reference the shipping accounts of these demo stores and batches are never deleted; drop and recreate the local demo database instead', v_n USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public."order" o WHERE o.store_id = ANY (v_ids)) THEN
    RAISE EXCEPTION 'demo reset refused: orders of these demo stores still reference their shipping accounts; delete the orders first' USING ERRCODE = 'restrict_violation';
  END IF;
  DELETE FROM public.store_payment_account WHERE store_id = ANY (v_ids);
  PERFORM pg_catalog.set_config('bukalaris.shipping_reset', 'demo', true);
  DELETE FROM public.store_shipping_account WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
