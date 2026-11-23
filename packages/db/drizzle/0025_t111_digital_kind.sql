ALTER TABLE "order" DROP CONSTRAINT "order_shipping_fee_chk";--> statement-breakpoint
ALTER TABLE "order" DROP CONSTRAINT "order_area_chk";--> statement-breakpoint
ALTER TABLE "order" DROP CONSTRAINT "order_shipped_chk";--> statement-breakpoint
ALTER TABLE "order_line" DROP CONSTRAINT "order_line_chk";--> statement-breakpoint
ALTER TABLE "variant" DROP CONSTRAINT "variant_weight_chk";--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "shipping_address" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "shipping_account_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "shipping_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "shipping_account_kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "shipping_account_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "courier_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "courier" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "origin_area_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "destination_area_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "destination_area_label" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "weight_kg" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "shipping_provider_cost" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "shipping_margin" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "shipping_fee" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "variant" ALTER COLUMN "weight_grams" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_financials" ALTER COLUMN "shipping_account_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "order_financials" ALTER COLUMN "shipping_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_financials" ALTER COLUMN "shipping_account_kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "order_financials" ALTER COLUMN "shipping_account_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "has_physical" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "has_digital" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "product_kind" text DEFAULT 'physical' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "track_stock" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "kind" text DEFAULT 'physical' NOT NULL;--> statement-breakpoint
ALTER TABLE "variant" ADD COLUMN "track_stock" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_kind_chk" CHECK ("order"."has_physical" or "order"."has_digital");--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_shipping_presence_chk" CHECK (("order"."has_physical" and "order"."shipping_address" is not null and "order"."shipping_account_id" is not null and "order"."shipping_account_kind" is not null and "order"."courier_code" is not null and "order"."courier" is not null and "order"."origin_area_id" is not null and "order"."destination_area_id" is not null and "order"."destination_area_label" is not null and "order"."weight_kg" is not null)
        or (not "order"."has_physical" and "order"."shipping_address" is null and "order"."shipping_account_id" is null and "order"."shipping_account_kind" is null and "order"."courier_code" is null and "order"."courier" is null and "order"."origin_area_id" is null and "order"."destination_area_id" is null and "order"."destination_area_label" is null and "order"."weight_kg" is null and "order"."tracking_number" is null and "order"."shipping_provider_cost" = 0 and "order"."shipping_margin" = 0 and "order"."shipping_fee" = 0 and "order"."shipping_discount" = 0));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_digital_rules_chk" CHECK (not "order"."has_digital" or ("order"."payment_method" <> 'cod' and ("order"."buyer_email" is not null or "order"."buyer_name" = '[dihapus]')));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_shipping_fee_chk" CHECK ("order"."shipping_fee" + "order"."shipping_discount" = "order"."shipping_provider_cost" + "order"."shipping_margin" and "order"."shipping_discount" >= 0 and "order"."shipping_discount" <= "order"."shipping_provider_cost" and "order"."shipping_provider_cost" >= 0 and "order"."shipping_margin" >= 0 and (not "order"."has_physical" or "order"."weight_kg" >= 1));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_area_chk" CHECK (not "order"."has_physical" or ("order"."origin_area_id" ~ '^[a-f0-9]{24}$' and "order"."destination_area_id" ~ '^[a-f0-9]{24}$'));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_shipped_chk" CHECK (("order"."status" <> 'shipped' or ("order"."has_physical" and "order"."tracking_number" is not null)) and ("order"."status" <> 'completed' or not "order"."has_physical" or "order"."tracking_number" is not null));--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_chk" CHECK ("order_line"."quantity" > 0 and "order_line"."line_total" = "order_line"."unit_price" * "order_line"."quantity" and "order_line"."product_kind" in ('physical', 'digital') and ("order_line"."product_kind" <> 'physical' or "order_line"."track_stock"));--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_account_pair_chk" CHECK (("order_financials"."shipping_account_id" is null) = ("order_financials"."shipping_account_kind" is null));--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_kind_chk" CHECK ("product"."kind" in ('physical', 'digital'));--> statement-breakpoint
ALTER TABLE "variant" ADD CONSTRAINT "variant_weight_chk" CHECK ("variant"."weight_grams" is null or "variant"."weight_grams" > 0);--> statement-breakpoint

-- ===== T-111 product kind and checkout rules for digital and mixed orders (ADR-0016 sections 1-3, 5, decisions 19-22) =====

-- 1. Product kind is immutable once any order line refers to any variant of the product (ADR-0016 decision 1).
CREATE FUNCTION public.product_kind_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS (
    SELECT 1 FROM public.order_line ol
    JOIN public.variant v ON v.store_id = ol.store_id AND v.id = ol.variant_id
    WHERE ol.store_id = NEW.store_id AND v.product_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'product_kind_locked: product kind cannot change after a sale' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.product_kind_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER product_kind_guard BEFORE UPDATE OF kind ON public.product FOR EACH ROW EXECUTE FUNCTION public.product_kind_guard();--> statement-breakpoint

-- 2. Variant weight and stock tracking follow the product's kind (ADR-0016 decision 2):
--    physical -> weight_grams > 0 AND track_stock = true; digital -> weight_grams IS NULL.
--    Checked immediately on variant writes, and deferred on product kind changes so a transaction can switch kind and update variants atomically.
CREATE FUNCTION public.variant_kind_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_kind text;
BEGIN
  IF TG_TABLE_NAME = 'product' THEN
    IF NEW.kind = 'physical' AND EXISTS (SELECT 1 FROM public.variant v WHERE v.store_id = NEW.store_id AND v.product_id = NEW.id AND (v.weight_grams IS NULL OR v.weight_grams <= 0 OR NOT v.track_stock)) THEN
      RAISE EXCEPTION 'physical variants require positive weight_grams and tracked stock' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'digital' AND EXISTS (SELECT 1 FROM public.variant v WHERE v.store_id = NEW.store_id AND v.product_id = NEW.id AND v.weight_grams IS NOT NULL) THEN
      RAISE EXCEPTION 'digital variants must not carry weight_grams' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.kind INTO v_kind FROM public.product p WHERE p.store_id = NEW.store_id AND p.id = NEW.product_id FOR SHARE;
  IF v_kind = 'physical' AND (NEW.weight_grams IS NULL OR NEW.weight_grams <= 0 OR NOT NEW.track_stock) THEN
    RAISE EXCEPTION 'physical variants require positive weight_grams and tracked stock' USING ERRCODE = 'check_violation';
  END IF;
  IF v_kind = 'digital' AND NEW.weight_grams IS NOT NULL THEN
    RAISE EXCEPTION 'digital variants must not carry weight_grams' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.variant_kind_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER variant_kind_guard AFTER INSERT OR UPDATE OF weight_grams, track_stock, product_id, store_id ON public.variant FOR EACH ROW EXECUTE FUNCTION public.variant_kind_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER product_variants_kind_guard AFTER UPDATE OF kind ON public.product DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.variant_kind_guard();--> statement-breakpoint

-- 3. Shipping snapshot guard: digital-only orders (`not has_physical`) carry no shipping account; order_financials mirrors NULL; shipment_cost is refused for them.
--    On INSERT, a digital order always requires buyer_email (redaction may clear buyer_email only on a later UPDATE).
CREATE OR REPLACE FUNCTION public.shipping_snapshot_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a public.store_shipping_account%ROWTYPE; o public."order"%ROWTYPE; f public.order_financials%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.shipping_account_id, NEW.shipping_account_kind) IS DISTINCT FROM (OLD.shipping_account_id, OLD.shipping_account_kind) THEN
      RAISE EXCEPTION 'the shipping account snapshot is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'order' THEN
    IF NEW.has_digital AND NEW.buyer_email IS NULL THEN
      RAISE EXCEPTION 'buyer_email is required for an order with a digital line' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT NEW.has_physical THEN
      IF NEW.shipping_account_id IS NOT NULL OR NEW.shipping_account_kind IS NOT NULL THEN
        RAISE EXCEPTION 'a digital-only order carries no shipping account' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.shipping_account_id IS NULL OR NEW.shipping_account_id = 0 THEN
      SELECT * INTO a FROM public.store_shipping_account
      WHERE store_id = NEW.store_id AND status = 'active'
        AND (kind = 'platform_master' OR (kind = 'partner_managed' AND EXISTS (SELECT 1 FROM public.shipping_control c WHERE c.key = 'default' AND c.prefer_partner)))
      ORDER BY CASE WHEN kind = 'partner_managed' THEN 0 ELSE 1 END LIMIT 1 FOR SHARE;
      NEW.shipping_account_id := a.id; NEW.shipping_account_kind := a.kind;
    ELSE
      SELECT * INTO a FROM public.store_shipping_account WHERE store_id = NEW.store_id AND id = NEW.shipping_account_id AND kind = NEW.shipping_account_kind FOR SHARE;
    END IF;
    IF a.id IS NULL OR a.status <> 'active' THEN RAISE EXCEPTION 'awaiting_account' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    SELECT * INTO o FROM public."order" WHERE store_id = NEW.store_id AND id = NEW.order_id;
    IF o.id IS NULL THEN
      RAISE EXCEPTION 'financial and booking accounts equal the frozen order account' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_TABLE_NAME = 'shipment_cost' AND NOT o.has_physical THEN
      RAISE EXCEPTION 'a digital-only order has no shipment cost' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.shipping_account_id IS NULL OR NEW.shipping_account_id = 0 THEN NEW.shipping_account_id := o.shipping_account_id; NEW.shipping_account_kind := o.shipping_account_kind; END IF;
    IF (NEW.shipping_account_id, NEW.shipping_account_kind) IS DISTINCT FROM (o.shipping_account_id, o.shipping_account_kind) THEN
      RAISE EXCEPTION 'financial and booking accounts equal the frozen order account' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_TABLE_NAME = 'shipment_cost' THEN
      SELECT * INTO f FROM public.order_financials WHERE store_id = NEW.store_id AND order_id = NEW.order_id;
      IF f.order_id IS NULL OR NEW.shipping_discount_idr <> f.shipping_discount_idr OR NEW.platform_shipping_discount_idr <> f.platform_shipping_discount_idr THEN
        RAISE EXCEPTION 'booking discounts equal frozen financial discounts' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 4. Order lifecycle (ADR-0016 section 5): a digital-only order moves directly from awaiting_payment -> completed when paid;
--    mixed and physical-only orders keep awaiting_payment -> placed -> processing -> shipped -> completed.
CREATE OR REPLACE FUNCTION "order_status_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD."status" = 'awaiting_confirmation' AND NEW."status" IN ('on_hold', 'placed', 'cancelled')) OR
    (OLD."status" = 'on_hold' AND NEW."status" IN ('placed', 'cancelled')) OR
    (OLD."status" = 'awaiting_payment' AND ((NEW."status" = 'placed' AND NEW."has_physical") OR NEW."status" = 'cancelled')) OR
    (OLD."status" = 'awaiting_payment' AND NEW."status" = 'completed' AND NOT NEW."has_physical") OR
    (OLD."status" = 'placed' AND ((NEW."status" IN ('processing', 'shipped', 'completed') AND NEW."has_physical") OR NEW."status" = 'cancelled')) OR
    (OLD."status" = 'processing' AND NEW."status" IN ('shipped', 'completed', 'cancelled')) OR
    (OLD."status" = 'shipped' AND NEW."status" IN ('completed', 'returned', 'cancelled')) OR
    (OLD."status" = 'shipped' AND NEW."status" = 'processing' AND NEW."shipping_account_kind" = 'seller_owned' AND NEW."tracking_number" IS NULL
      AND (pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER')))
  ) THEN
    RAISE EXCEPTION 'order status % -> % is not a legal move', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('completed', 'returned')
     AND NOT (NOT NEW."has_physical" AND OLD."status" = 'awaiting_payment' AND NEW."status" = 'completed')
     AND NOT (pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER')) THEN
    RAISE EXCEPTION 'only the courier writer or an approved manual completion moves an order to % (the seller login cannot)', NEW."status" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 5. Seller payment guard (T-106): also cover awaiting_payment -> completed (digital-only orders on AutoLaris).
DROP TRIGGER IF EXISTS order_seller_payment_guard ON public."order";--> statement-breakpoint
CREATE TRIGGER order_seller_payment_guard BEFORE UPDATE OF status ON public."order" FOR EACH ROW
  WHEN (OLD.status = 'awaiting_payment' AND NEW.status IN ('placed', 'completed')) EXECUTE FUNCTION public.order_seller_payment_guard();