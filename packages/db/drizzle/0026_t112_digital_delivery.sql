CREATE TABLE "digital_grant" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "digital_grant_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"variant_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"is_test" boolean DEFAULT false NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digital_grant_order_line_uq" UNIQUE("store_id","order_id","variant_id"),
	CONSTRAINT "digital_grant_state_chk" CHECK (("digital_grant"."state" = 'active' and "digital_grant"."revoked_at" is null and "digital_grant"."revoked_by" is null and "digital_grant"."revoked_reason" is null)
        or ("digital_grant"."state" = 'revoked' and "digital_grant"."revoked_at" is not null and length(btrim(coalesce("digital_grant"."revoked_by", ''))) >= 1 and length(btrim(coalesce("digital_grant"."revoked_reason", ''))) >= 3))
);
--> statement-breakpoint
CREATE TABLE "product_access_item" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_access_item_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"item_type" text DEFAULT 'link' NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_access_item_type_chk" CHECK ("product_access_item"."item_type" = 'link'),
	CONSTRAINT "product_access_item_fields_chk" CHECK (length(btrim("product_access_item"."label")) between 1 and 120 and length("product_access_item"."url") between 10 and 2000 and "product_access_item"."url" ~ '^https://[^/\s@]+(:[0-9]+)?(/[^\s]*)?$' and "product_access_item"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_access_note" (
	"store_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"note" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_access_note_pk" PRIMARY KEY("store_id","product_id"),
	CONSTRAINT "product_access_note_len_chk" CHECK (length("product_access_note"."note") <= 5000)
);
--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "digital_grant_expiry_days" integer;--> statement-breakpoint
ALTER TABLE "digital_grant" ADD CONSTRAINT "digital_grant_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_grant" ADD CONSTRAINT "digital_grant_variant_fk" FOREIGN KEY ("store_id","variant_id") REFERENCES "public"."variant"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_grant" ADD CONSTRAINT "digital_grant_product_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_grant" ADD CONSTRAINT "digital_grant_line_fk" FOREIGN KEY ("order_id","variant_id") REFERENCES "public"."order_line"("order_id","variant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_access_item" ADD CONSTRAINT "product_access_item_product_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_access_note" ADD CONSTRAINT "product_access_note_product_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digital_grant_store_order_idx" ON "digital_grant" USING btree ("store_id","order_id");--> statement-breakpoint
CREATE INDEX "product_access_item_product_idx" ON "product_access_item" USING btree ("store_id","product_id","position","id");--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_digital_expiry_chk" CHECK ("store"."digital_grant_expiry_days" is null or "store"."digital_grant_expiry_days" between 1 and 3650);--> statement-breakpoint

-- ===== T-112 access links, grants and digital delivery (PR-2, ADR-0016 section 4 & 7, C-G1..C-G3) =====

-- 1. FORCE RLS and least-privilege grants on all three digital tables.
REVOKE ALL ON public.product_access_item, public.product_access_note, public.digital_grant FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
ALTER TABLE public.product_access_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.product_access_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.product_access_item USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_access_item TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.product_access_item TO bukalaris_platform;--> statement-breakpoint

ALTER TABLE public.product_access_note ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.product_access_note FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.product_access_note USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_access_note TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.product_access_note TO bukalaris_platform;--> statement-breakpoint

ALTER TABLE public.digital_grant ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.digital_grant FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.digital_grant USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.digital_grant TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.digital_grant TO bukalaris_platform;--> statement-breakpoint

-- 2. Access-item / access-note guard: only digital products may hold delivery content, and at most 10 links per product (D-31 OPEN-G1).
CREATE FUNCTION public.product_access_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_kind text;
  v_count integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.store_id, NEW.product_id) IS DISTINCT FROM (OLD.store_id, OLD.product_id) THEN
    RAISE EXCEPTION 'access content cannot be moved to another product or store' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.kind INTO v_kind FROM public.product p WHERE p.store_id = NEW.store_id AND p.id = NEW.product_id FOR UPDATE;
  IF v_kind IS DISTINCT FROM 'digital' THEN
    RAISE EXCEPTION 'access content belongs to digital products only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'product_access_item' AND TG_OP = 'INSERT' THEN
    SELECT count(*) INTO v_count FROM public.product_access_item i WHERE i.store_id = NEW.store_id AND i.product_id = NEW.product_id;
    IF v_count >= 10 THEN
      RAISE EXCEPTION 'access_link_limit: at most 10 access links per product' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.product_access_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER product_access_item_guard BEFORE INSERT OR UPDATE ON public.product_access_item FOR EACH ROW EXECUTE FUNCTION public.product_access_guard();--> statement-breakpoint
CREATE TRIGGER product_access_note_guard BEFORE INSERT OR UPDATE ON public.product_access_note FOR EACH ROW EXECUTE FUNCTION public.product_access_guard();--> statement-breakpoint

-- 3. Digital grant guard: no grant before paid or on cancelled/returned order, only for digital order lines, immutable identity,
--    revoked rows frozen forever, never deleted except demo reset on demo-% stores.
CREATE FUNCTION public.digital_grant_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_paid timestamptz;
  v_status text;
  v_test boolean;
  v_line_kind text;
  v_product_id bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.payment_evidence_reset', true) = 'demo'
       AND EXISTS (SELECT 1 FROM public.store s WHERE s.id = OLD.store_id AND s.slug LIKE 'demo-%') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'digital_grant cannot be deleted; revoke it instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state = 'revoked' THEN
      RAISE EXCEPTION 'a revoked digital_grant is immutable and cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.store_id, NEW.order_id, NEW.variant_id, NEW.product_id, NEW.is_test, NEW.granted_at)
       IS DISTINCT FROM (OLD.store_id, OLD.order_id, OLD.variant_id, OLD.product_id, OLD.is_test, OLD.granted_at) THEN
      RAISE EXCEPTION 'digital_grant identity fields are immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state <> 'active' THEN
    RAISE EXCEPTION 'a new digital_grant must start active' USING ERRCODE = 'check_violation';
  END IF;
  SELECT o.paid_at, o.status, o.test_order INTO v_paid, v_status, v_test FROM public."order" o WHERE o.store_id = NEW.store_id AND o.id = NEW.order_id;
  IF v_paid IS NULL OR v_status IN ('cancelled', 'returned') THEN
    RAISE EXCEPTION 'digital_grant requires a paid active order' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.is_test <> v_test THEN
    RAISE EXCEPTION 'digital_grant is_test must match the order test_order flag' USING ERRCODE = 'check_violation';
  END IF;
  SELECT ol.product_kind, v.product_id INTO v_line_kind, v_product_id
  FROM public.order_line ol
  JOIN public.variant v ON v.store_id = ol.store_id AND v.id = ol.variant_id
  WHERE ol.store_id = NEW.store_id AND ol.order_id = NEW.order_id AND ol.variant_id = NEW.variant_id;
  IF v_line_kind IS DISTINCT FROM 'digital' OR v_product_id IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION 'digital_grant must match a digital order line and its product' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.digital_grant_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER digital_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON public.digital_grant FOR EACH ROW EXECUTE FUNCTION public.digital_grant_guard();--> statement-breakpoint

-- 3b. ADR-0016 decision 20 (AFTER trigger, so ON CONFLICT DO NOTHING never fires side effects):
--     on digital-only orders, affiliate hold starts at grant issuance; revoking the last active grant inside hold voids pending commission.
CREATE FUNCTION public.digital_grant_affiliate_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.affiliate_attribution a
    SET eligible_at = now() + make_interval(days => a.hold_days)
    FROM public."order" o
    WHERE a.store_id = NEW.store_id AND a.order_id = NEW.order_id AND a.status = 'pending' AND a.eligible_at IS NULL
      AND o.store_id = a.store_id AND o.id = a.order_id AND NOT o.has_physical;
  ELSIF TG_OP = 'UPDATE' AND OLD.state = 'active' AND NEW.state = 'revoked' THEN
    IF NOT EXISTS (SELECT 1 FROM public.digital_grant g WHERE g.store_id = NEW.store_id AND g.order_id = NEW.order_id AND g.state = 'active') THEN
      UPDATE public.affiliate_attribution a
      SET status = 'void', void_reason = left('digital_grant_revoked: ' || coalesce(NEW.revoked_reason, 'revoked'), 200)
      FROM public."order" o
      WHERE a.store_id = NEW.store_id AND a.order_id = NEW.order_id AND a.status = 'pending' AND (a.eligible_at IS NULL OR a.eligible_at > now())
        AND o.store_id = a.store_id AND o.id = a.order_id AND NOT o.has_physical;
    END IF;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.digital_grant_affiliate_sync() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER digital_grant_affiliate_sync AFTER INSERT OR UPDATE OF state ON public.digital_grant FOR EACH ROW EXECUTE FUNCTION public.digital_grant_affiliate_sync();--> statement-breakpoint

-- 4. Retention class & demo reset update.
INSERT INTO public.retention_class (class, table_name, time_column, row_filter) VALUES
  ('digital_grant', 'digital_grant', 'granted_at', 'false')
ON CONFLICT (class) DO NOTHING;--> statement-breakpoint

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
  DELETE FROM public.digital_grant WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.product_access_item WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.product_access_note WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.store_terms_acceptance WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.bank_transfer_confirmation WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.payment_proof WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.order_bank_transfer WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.store_bank_account WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.store_bank_transfer WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.order_seller_refund WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.payment_manual_confirmation WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.payment_anomaly WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.late_payment_obligation WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.payment_callback WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.payment_observation WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.payment_attempt_event WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.payment_attempt WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  PERFORM pg_catalog.set_config('bukalaris.payment_evidence_reset', '', true);
  RETURN v_total;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reset_demo_payments(bigint[]) FROM PUBLIC, bukalaris_app, bukalaris_platform;