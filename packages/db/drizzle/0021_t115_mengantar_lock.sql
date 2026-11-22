CREATE TABLE "shipment_status_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "shipment_status_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"shipment_id" bigint NOT NULL,
	"provider_order_id" text NOT NULL,
	"category" text NOT NULL,
	"parcel_state" text,
	"source" text NOT NULL,
	"provider_changed_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_status_event_chk" CHECK (length("shipment_status_event"."category") between 1 and 60 and length("shipment_status_event"."provider_order_id") between 1 and 64 and "shipment_status_event"."source" in ('booking', 'read')
      and ("shipment_status_event"."parcel_state" is null or "shipment_status_event"."parcel_state" in ('created', 'waiting_pickup', 'pickup_failed', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'returning', 'returned', 'cancelled', 'error')))
);
--> statement-breakpoint
CREATE TABLE "shipping_foreign_parcel" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "shipping_foreign_parcel_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"provider_order_id" text NOT NULL,
	"tracking_number" text,
	"provider_status" text,
	"provider_created_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text,
	CONSTRAINT "shipping_foreign_parcel_uq" UNIQUE("store_id","provider_order_id"),
	CONSTRAINT "shipping_foreign_parcel_chk" CHECK (length("shipping_foreign_parcel"."provider_order_id") between 1 and 64 and coalesce(length("shipping_foreign_parcel"."tracking_number"), 0) <= 64 and coalesce(length("shipping_foreign_parcel"."provider_status"), 0) <= 60
      and ("shipping_foreign_parcel"."resolved_at" is null) = ("shipping_foreign_parcel"."resolved_by" is null) and ("shipping_foreign_parcel"."resolved_at" is null) = ("shipping_foreign_parcel"."resolution_note" is null) and coalesce(length("shipping_foreign_parcel"."resolution_note"), 0) <= 300)
);
--> statement-breakpoint
CREATE TABLE "shipping_webhook_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "shipping_webhook_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"signature" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_order_id" text,
	"tracking_number" text,
	"courier" text,
	"status_category" text,
	"outcome" text NOT NULL,
	CONSTRAINT "shipping_webhook_event_signature_uq" UNIQUE("store_id","signature"),
	CONSTRAINT "shipping_webhook_event_chk" CHECK ("shipping_webhook_event"."signature" ~ '^[a-f0-9]{64}$' and "shipping_webhook_event"."outcome" in ('read_enqueued', 'no_parcel', 'parcel_final')
      and coalesce(length("shipping_webhook_event"."provider_order_id"), 0) <= 64 and coalesce(length("shipping_webhook_event"."tracking_number"), 0) <= 64 and coalesce(length("shipping_webhook_event"."courier"), 0) <= 40 and coalesce(length("shipping_webhook_event"."status_category"), 0) <= 60)
);
--> statement-breakpoint
CREATE TABLE "store_shipping_sync" (
	"store_id" bigint PRIMARY KEY NOT NULL,
	"hook_id" text NOT NULL,
	"dedicated_confirmed_at" timestamp with time zone,
	"dedicated_confirmed_by" text,
	"dedicated_fingerprint" text,
	"dedicated_environment" text,
	"sealed_webhook_secret" text,
	"webhook_key_id" text,
	"webhook_sealed_at" timestamp with time zone,
	"webhook_fingerprint" text,
	"webhook_environment" text,
	"step_up_ref" uuid,
	"last_webhook_at" timestamp with time zone,
	"account_read_at" timestamp with time zone,
	"balance_idr" bigint,
	"invoices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_scan_at" timestamp with time zone,
	"scan_error" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_shipping_sync_hook_uq" UNIQUE("hook_id"),
	CONSTRAINT "store_shipping_sync_hook_chk" CHECK ("store_shipping_sync"."hook_id" ~ '^[a-f0-9]{32}$'),
	CONSTRAINT "store_shipping_sync_dedicated_chk" CHECK (("store_shipping_sync"."dedicated_confirmed_at" is null) = ("store_shipping_sync"."dedicated_confirmed_by" is null) and ("store_shipping_sync"."dedicated_confirmed_at" is null) = ("store_shipping_sync"."dedicated_fingerprint" is null)
      and ("store_shipping_sync"."dedicated_confirmed_at" is null) = ("store_shipping_sync"."dedicated_environment" is null) and ("store_shipping_sync"."dedicated_environment" is null or "store_shipping_sync"."dedicated_environment" in ('sandbox', 'production'))),
	CONSTRAINT "store_shipping_sync_secret_chk" CHECK (("store_shipping_sync"."sealed_webhook_secret" is null) = ("store_shipping_sync"."webhook_key_id" is null) and ("store_shipping_sync"."sealed_webhook_secret" is null) = ("store_shipping_sync"."webhook_sealed_at" is null)
      and ("store_shipping_sync"."sealed_webhook_secret" is null) = ("store_shipping_sync"."webhook_fingerprint" is null) and ("store_shipping_sync"."sealed_webhook_secret" is null) = ("store_shipping_sync"."webhook_environment" is null) and ("store_shipping_sync"."webhook_environment" is null or "store_shipping_sync"."webhook_environment" in ('sandbox', 'production'))),
	CONSTRAINT "store_shipping_sync_mirror_chk" CHECK (jsonb_typeof("store_shipping_sync"."invoices") = 'array' and octet_length("store_shipping_sync"."invoices"::text) <= 16384 and ("store_shipping_sync"."balance_idr" is null or "store_shipping_sync"."account_read_at" is not null) and coalesce(length("store_shipping_sync"."scan_error"), 0) <= 300)
);
--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "provider_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "provider_figures" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "provider_figures_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipment_status_event" ADD CONSTRAINT "shipment_status_event_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_status_event" ADD CONSTRAINT "shipment_status_event_shipment_id_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_foreign_parcel" ADD CONSTRAINT "shipping_foreign_parcel_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_webhook_event" ADD CONSTRAINT "shipping_webhook_event_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_shipping_sync" ADD CONSTRAINT "store_shipping_sync_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipment_status_event_shipment_idx" ON "shipment_status_event" USING btree ("store_id","shipment_id","id");--> statement-breakpoint
CREATE INDEX "shipment_status_event_order_idx" ON "shipment_status_event" USING btree ("store_id","provider_order_id");--> statement-breakpoint
CREATE INDEX "shipping_webhook_event_store_idx" ON "shipping_webhook_event" USING btree ("store_id","received_at");--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_figures_chk" CHECK (jsonb_typeof("shipment"."provider_figures") = 'object' and octet_length("shipment"."provider_figures"::text) <= 1024 and ("shipment"."provider_figures_at" is not null or "shipment"."provider_figures" = '{}'::jsonb));--> statement-breakpoint

-- ===== T-115 (ADR-0013 section 11, decisions 40 to 45; decisions 30, 31; C-P1, C-P3; D-32 item 7, D-33) =====
-- Hand-written: grants, policies, guards, the webhook resolver, the webhook-secret envelope and the release move (drizzle-kit models none of
-- them). The generated statements above are untouched. Every new table starts empty, so nothing is backfilled; the three new `shipment`
-- columns are nullable or carry a constant default (metadata-only on PostgreSQL 11+) and `shipment_figures_chk` holds on every existing row
-- (`'{}'` with no read time). bukalaris_platform keeps the table-wide default privileges of migration 0007 until the T-59 contract step (expand
-- rule); the registry lists what it needs afterwards.

-- 1. Four tenant tables under FORCE RLS. The app role (seller request, webhook route) reads the parcel records and writes only what its
--    requests own; the worker (platform pool) writes status events, foreign parcels and the account mirror.
REVOKE ALL ON public.shipment_status_event FROM PUBLIC, bukalaris_app;--> statement-breakpoint
ALTER TABLE public.shipment_status_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.shipment_status_event FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.shipment_status_event USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT ON public.shipment_status_event TO bukalaris_app;--> statement-breakpoint
REVOKE ALL ON public.shipping_webhook_event FROM PUBLIC, bukalaris_app;--> statement-breakpoint
ALTER TABLE public.shipping_webhook_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.shipping_webhook_event FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.shipping_webhook_event USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT ON public.shipping_webhook_event TO bukalaris_app;--> statement-breakpoint
REVOKE ALL ON public.shipping_foreign_parcel FROM PUBLIC, bukalaris_app;--> statement-breakpoint
ALTER TABLE public.shipping_foreign_parcel ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.shipping_foreign_parcel FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.shipping_foreign_parcel USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT ON public.shipping_foreign_parcel TO bukalaris_app;--> statement-breakpoint
GRANT UPDATE (resolved_at, resolved_by, resolution_note) ON public.shipping_foreign_parcel TO bukalaris_app;--> statement-breakpoint
REVOKE ALL ON public.store_shipping_sync FROM PUBLIC, bukalaris_app;--> statement-breakpoint
ALTER TABLE public.store_shipping_sync ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.store_shipping_sync FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.store_shipping_sync USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
-- The app role never reads the sealed Webhook Secret (no SELECT on it, its key id or the step-up reference); it opens it only through
-- provider_key_envelope(store, 'mengantar_webhook') below.
GRANT SELECT (store_id, hook_id, dedicated_confirmed_at, dedicated_confirmed_by, dedicated_fingerprint, dedicated_environment, webhook_sealed_at, webhook_fingerprint, webhook_environment, last_webhook_at, account_read_at, balance_idr, invoices, last_scan_at, scan_error, revision, updated_at) ON public.store_shipping_sync TO bukalaris_app;--> statement-breakpoint
GRANT INSERT (store_id, hook_id) ON public.store_shipping_sync TO bukalaris_app;--> statement-breakpoint
GRANT UPDATE (dedicated_confirmed_at, dedicated_confirmed_by, dedicated_fingerprint, dedicated_environment, sealed_webhook_secret, webhook_key_id, webhook_sealed_at, webhook_fingerprint, webhook_environment, step_up_ref, last_webhook_at, revision, updated_at) ON public.store_shipping_sync TO bukalaris_app;--> statement-breakpoint

-- 2. Seller-side write rules of store_shipping_sync (an invoker trigger, like provider_account_guard: it reads only the store's own step-up
--    proofs). The hook id never changes (every role). For the app role: the Webhook Secret is sealed like the API key (ADR-0013 section 2),
--    so a change needs a step-up proof of this store for the subject `mengantar_webhook` consumed in the same transaction; the step-up
--    reference moves only with it; a dedicated-account confirmation carries the time of the statement that wrote it.
CREATE FUNCTION public.store_shipping_sync_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_app boolean := NOT (pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER'));
  v_secret_changed boolean := CASE WHEN TG_OP = 'INSERT' THEN NEW.sealed_webhook_secret IS NOT NULL
    ELSE (NEW.sealed_webhook_secret, NEW.webhook_key_id) IS DISTINCT FROM (OLD.sealed_webhook_secret, OLD.webhook_key_id) END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.hook_id IS DISTINCT FROM OLD.hook_id THEN
    RAISE EXCEPTION 'the webhook address of a store never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT v_app THEN RETURN NEW; END IF;
  IF v_secret_changed THEN
    IF NOT EXISTS (SELECT 1 FROM public.store_step_up_proof pr WHERE pr.id = NEW.step_up_ref AND pr.store_id = NEW.store_id
                   AND pr.action_key = 'integrations.provider_key' AND pr.subject_kind = 'store' AND pr.subject_id = 'mengantar_webhook' AND pr.consumed_at = pg_catalog.now()) THEN
      RAISE EXCEPTION 'a webhook secret change needs a step-up proof consumed in this transaction' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.step_up_ref IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.step_up_ref ELSE NULL END) THEN
    RAISE EXCEPTION 'the step-up reference moves only with a webhook secret change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.dedicated_confirmed_at IS NOT NULL AND NEW.dedicated_confirmed_at IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.dedicated_confirmed_at ELSE NULL END)
     AND NEW.dedicated_confirmed_at <> pg_catalog.now() THEN
    RAISE EXCEPTION 'a dedicated-account confirmation is recorded at the time it was given' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.store_shipping_sync_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER store_shipping_sync_guard BEFORE INSERT OR UPDATE ON public.store_shipping_sync FOR EACH ROW EXECUTE FUNCTION public.store_shipping_sync_guard();--> statement-breakpoint

-- 3. The envelope reader gains the Webhook Secret (subject `mengantar_webhook`): returned only while it belongs to the connected key and
--    environment of the store's own account (a key regenerated in Mengantar replaces the secret too). Body identical to 0018 apart from the
--    marked T-115 branch; same signature, owner and grants (T-106's EXECUTE for bukalaris_platform in 0020 is kept by CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public.provider_key_envelope(p_store_id bigint, p_provider text) RETURNS TABLE (account_id bigint, key_id text, sealed_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_store_id IS NULL OR p_store_id IS DISTINCT FROM public.app_store_id() THEN
    RAISE EXCEPTION 'provider key of another store' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_provider = 'mengantar' THEN
    RETURN QUERY SELECT a.id, a.key_id, a.sealed_key FROM public.store_shipping_account a WHERE a.store_id = p_store_id AND a.kind = 'seller_owned' AND a.sealed_key IS NOT NULL;
  ELSIF p_provider = 'autolaris' THEN
    RETURN QUERY SELECT a.id, a.key_id, a.sealed_key FROM public.store_payment_account a WHERE a.store_id = p_store_id AND a.sealed_key IS NOT NULL;
  ELSIF p_provider = 'mengantar_webhook' THEN -- T-115
    RETURN QUERY SELECT a.id, s.webhook_key_id, s.sealed_webhook_secret FROM public.store_shipping_sync s
      JOIN public.store_shipping_account a ON a.store_id = s.store_id AND a.kind = 'seller_owned'
      WHERE s.store_id = p_store_id AND s.sealed_webhook_secret IS NOT NULL AND a.status = 'active'
        AND a.key_fingerprint = s.webhook_fingerprint AND a.environment = s.webhook_environment;
  ELSE
    RAISE EXCEPTION 'unknown provider' USING ERRCODE = 'invalid_parameter_value';
  END IF;
END $$;--> statement-breakpoint

-- 4. The opaque webhook id of the address the seller set in Mengantar -> its store. Owned by the table owner (BYPASSRLS, like
--    resolve_user_suspended), fixed search_path, one statement, the store id only, EXECUTE for the app role only. Review minor 8: not owned by
--    bukalaris_resolver, so no role but the owner ever holds SELECT on the table that carries the sealed Webhook Secret.
CREATE FUNCTION public.resolve_mengantar_webhook_store(p_hook_id text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT s.store_id FROM public.store_shipping_sync s WHERE s.hook_id = p_hook_id $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_mengantar_webhook_store(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_mengantar_webhook_store(text) TO bukalaris_app;--> statement-breakpoint

-- 5. ADR-0013 decision 44 "cancel releases the booking": a parcel cancelled in the store's OWN Mengantar account moves the shipped order back
--    to `processing` (the resi is cleared, nothing is restocked, the seller may book again). Only for a `seller_owned` order and only by the
--    courier writer (platform or owner session). Body identical to 0014 apart from the marked T-115 line.
CREATE OR REPLACE FUNCTION "order_status_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD."status" = 'awaiting_confirmation' AND NEW."status" IN ('on_hold', 'placed', 'cancelled')) OR
    (OLD."status" = 'on_hold' AND NEW."status" IN ('placed', 'cancelled')) OR
    (OLD."status" = 'awaiting_payment' AND NEW."status" IN ('placed', 'cancelled')) OR
    (OLD."status" = 'placed' AND NEW."status" IN ('processing', 'shipped', 'completed', 'cancelled')) OR
    (OLD."status" = 'processing' AND NEW."status" IN ('shipped', 'completed', 'cancelled')) OR
    (OLD."status" = 'shipped' AND NEW."status" IN ('completed', 'returned', 'cancelled')) OR
    (OLD."status" = 'shipped' AND NEW."status" = 'processing' AND NEW."shipping_account_kind" = 'seller_owned' AND NEW."tracking_number" IS NULL -- T-115
      AND (pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER')))
  ) THEN
    RAISE EXCEPTION 'order status % -> % is not a legal move', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('completed', 'returned') AND NOT (pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER')) THEN
    RAISE EXCEPTION 'only the courier writer or an approved manual completion moves an order to % (the seller login cannot)', NEW."status" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 6. The two scheduled reads (decisions 41 and 43): every non-final parcel on a store's own account, and each store's account scan
--    (foreign parcels, balance and invoices).
INSERT INTO public.platform_job_kind (kind) VALUES ('shipping.parcel_sweep'), ('shipping.account_scan_sweep') ON CONFLICT (kind) DO NOTHING;
