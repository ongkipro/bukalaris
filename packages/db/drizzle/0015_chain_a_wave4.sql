CREATE TABLE "issue_notification" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "issue_notification_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"report_id" bigint NOT NULL,
	"urgency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_notification_urgency_chk" CHECK ("issue_notification"."urgency" in ('immediate','digest'))
);
--> statement-breakpoint
CREATE TABLE "discount" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "discount_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"code" text NOT NULL,
	"code_sha256" text NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"product_id" bigint,
	"collection_id" bigint,
	"value" bigint NOT NULL,
	"min_purchase_idr" bigint DEFAULT 0 NOT NULL,
	"max_discount_idr" bigint,
	"usage_limit" integer,
	"buyer_usage_limit" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"public" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "discount_code_uq" UNIQUE("store_id","code_sha256"),
	CONSTRAINT "discount_scope_chk" CHECK (("discount"."scope" = 'all' and "discount"."product_id" is null and "discount"."collection_id" is null) or ("discount"."scope" = 'product' and "discount"."product_id" is not null and "discount"."collection_id" is null) or ("discount"."scope" = 'collection' and "discount"."product_id" is null and "discount"."collection_id" is not null)),
	CONSTRAINT "discount_value_chk" CHECK (("discount"."kind" = 'percent' and "discount"."value" between 1 and 10000) or ("discount"."kind" = 'fixed' and "discount"."value" > 0) or ("discount"."kind" = 'free_shipping' and "discount"."value" = 0)),
	CONSTRAINT "discount_limits_chk" CHECK ("discount"."min_purchase_idr" >= 0 and ("discount"."max_discount_idr" is null or "discount"."max_discount_idr" >= 0) and ("discount"."usage_limit" is null or "discount"."usage_limit" >= 1) and ("discount"."buyer_usage_limit" is null or "discount"."buyer_usage_limit" >= 1) and "discount"."used_count" >= 0 and ("discount"."usage_limit" is null or "discount"."used_count" <= "discount"."usage_limit")),
	CONSTRAINT "discount_window_chk" CHECK ("discount"."ends_at" > "discount"."starts_at" and "discount"."status" in ('active', 'disabled')),
	CONSTRAINT "discount_code_chk" CHECK ("discount"."code" ~ '^[A-F0-9]{24}$' and "discount"."code_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "discount_buyer_usage" (
	"store_id" bigint NOT NULL,
	"discount_id" bigint NOT NULL,
	"phone_fingerprint" text NOT NULL,
	"used_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "discount_buyer_usage_store_id_discount_id_phone_fingerprint_pk" PRIMARY KEY("store_id","discount_id","phone_fingerprint"),
	CONSTRAINT "discount_buyer_count_chk" CHECK ("discount_buyer_usage"."used_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "discount_redemption" (
	"store_id" bigint NOT NULL,
	"order_id" bigint PRIMARY KEY NOT NULL,
	"discount_id" bigint NOT NULL,
	"goods_discount_idr" bigint NOT NULL,
	"shipping_discount_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_redemption_amount_chk" CHECK ("discount_redemption"."goods_discount_idr" >= 0 and "discount_redemption"."shipping_discount_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "flash_sale" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "flash_sale_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flash_sale_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "flash_sale_window_chk" CHECK ("flash_sale"."ends_at" > "flash_sale"."starts_at" and "flash_sale"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "flash_sale_item" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "flash_sale_item_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"flash_sale_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"variant_id" bigint NOT NULL,
	"sale_price_idr" bigint NOT NULL,
	"stock_cap" integer,
	"sold_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "flash_sale_item_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "flash_sale_variant_uq" UNIQUE("flash_sale_id","variant_id"),
	CONSTRAINT "flash_sale_item_stock_chk" CHECK ("flash_sale_item"."sale_price_idr" >= 0 and "flash_sale_item"."sold_count" >= 0 and ("flash_sale_item"."stock_cap" is null or ("flash_sale_item"."stock_cap" >= 1 and "flash_sale_item"."sold_count" <= "flash_sale_item"."stock_cap")))
);
--> statement-breakpoint
CREATE TABLE "flash_sale_redemption" (
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"goods_discount_idr" bigint NOT NULL,
	CONSTRAINT "flash_sale_redemption_order_id_item_id_pk" PRIMARY KEY("order_id","item_id"),
	CONSTRAINT "flash_redemption_amount_chk" CHECK ("flash_sale_redemption"."quantity" >= 1 and "flash_sale_redemption"."goods_discount_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promo_hub" (
	"store_id" bigint PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"title" text DEFAULT 'Promo toko' NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"banner_media_id" bigint,
	"banner_cta_label" text DEFAULT '' NOT NULL,
	"banner_cta_href" text DEFAULT '' NOT NULL,
	"free_ship_enabled" boolean DEFAULT false NOT NULL,
	"free_ship_threshold_idr" bigint DEFAULT 0 NOT NULL,
	"percent_rounding" text DEFAULT 'floor' NOT NULL,
	CONSTRAINT "promo_hub_settings_chk" CHECK ("promo_hub"."free_ship_threshold_idr" >= 0 and "promo_hub"."percent_rounding" in ('floor', 'half_up', 'ceil'))
);
--> statement-breakpoint
CREATE TABLE "promo_hub_collection" (
	"store_id" bigint NOT NULL,
	"collection_id" bigint NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "promo_hub_collection_store_id_collection_id_pk" PRIMARY KEY("store_id","collection_id")
);
--> statement-breakpoint
CREATE TABLE "cashback_rule" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cashback_rule_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"courier_code" text DEFAULT '' NOT NULL,
	"service_code" text DEFAULT '' NOT NULL,
	"seller_share_bps" integer DEFAULT 0 NOT NULL,
	"fixed_seller_bonus_idr" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'disabled' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cashback_rule_service_uq" UNIQUE("courier_code","service_code"),
	CONSTRAINT "cashback_rule_values_chk" CHECK ("cashback_rule"."seller_share_bps" between 0 and 10000 and "cashback_rule"."fixed_seller_bonus_idr" >= 0),
	CONSTRAINT "cashback_rule_status_chk" CHECK ("cashback_rule"."status" in ('disabled', 'active'))
);
--> statement-breakpoint
CREATE TABLE "shipping_control" (
	"key" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"prefer_partner" boolean DEFAULT false NOT NULL,
	"discount_idr" bigint DEFAULT 0 NOT NULL,
	"discount_bps" integer DEFAULT 0 NOT NULL,
	"cashback_enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"approval_request_id" bigint,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_control_key_chk" CHECK ("shipping_control"."key" = 'default'),
	CONSTRAINT "shipping_discount_chk" CHECK ("shipping_control"."discount_idr" >= 0 and "shipping_control"."discount_bps" between 0 and 10000),
	CONSTRAINT "shipping_cashback_dormant_chk" CHECK (not "shipping_control"."cashback_enabled")
);
--> statement-breakpoint
CREATE TABLE "shipping_dispatch_lease" (
	"key" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_partner_budget" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" integer NOT NULL,
	"refilled_at" timestamp with time zone NOT NULL,
	"day_start" timestamp with time zone NOT NULL,
	"registrations" integer DEFAULT 0 NOT NULL,
	"blocked_until" timestamp with time zone,
	CONSTRAINT "shipping_partner_budget_chk" CHECK ("shipping_partner_budget"."key" = 'partner:mengantar' and "shipping_partner_budget"."tokens" between 0 and 60 and "shipping_partner_budget"."registrations" between 0 and 1000)
);
--> statement-breakpoint
CREATE TABLE "store_shipping_account" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "store_shipping_account_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_user_id" text NOT NULL,
	"mengantar_seller_id" text,
	"registered_email" text,
	"sealed_key" text,
	"key_id" text,
	"sealed_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_result" text,
	"provisioning_until" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_account_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "shipping_account_store_kind_uq" UNIQUE("store_id","kind"),
	CONSTRAINT "shipping_account_identity_uq" UNIQUE("store_id","id","kind"),
	CONSTRAINT "shipping_account_kind_chk" CHECK ("store_shipping_account"."kind" in ('partner_managed', 'platform_master')),
	CONSTRAINT "shipping_account_status_chk" CHECK ("store_shipping_account"."status" in ('pending', 'active', 'needs_key', 'disabled')),
	CONSTRAINT "shipping_account_external_chk" CHECK ("store_shipping_account"."external_user_id" = 'store:' || "store_shipping_account"."store_id"::text),
	CONSTRAINT "shipping_account_sealed_chk" CHECK (("store_shipping_account"."sealed_key" is null and "store_shipping_account"."key_id" is null and "store_shipping_account"."sealed_at" is null) or ("store_shipping_account"."sealed_key" is not null and "store_shipping_account"."key_id" is not null and "store_shipping_account"."sealed_at" is not null and "store_shipping_account"."kind" = 'partner_managed')),
	CONSTRAINT "shipping_account_active_chk" CHECK ("store_shipping_account"."status" <> 'active' or "store_shipping_account"."kind" = 'platform_master' or ("store_shipping_account"."sealed_key" is not null and "store_shipping_account"."mengantar_seller_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "order" DROP CONSTRAINT "order_total_chk";--> statement-breakpoint
ALTER TABLE "order" DROP CONSTRAINT "order_shipping_fee_chk";--> statement-breakpoint
ALTER TABLE "shipment" DROP CONSTRAINT "shipment_status_chk";--> statement-breakpoint
ALTER TABLE "shipment" DROP CONSTRAINT "shipment_booked_chk";--> statement-breakpoint
ALTER TABLE "shipment_cost" DROP CONSTRAINT "shipment_cost_one_side_chk";--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "shipping_account_id" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "shipping_account_kind" text DEFAULT 'platform_master' NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "goods_discount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "shipping_discount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_margin_rule" ADD COLUMN "approval_request_id" bigint;--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN "shipping_account_id" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN "shipping_account_kind" text DEFAULT 'platform_master' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_line_financials" ADD COLUMN "shipping_discount_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_batch" ADD COLUMN "shipping_account_id" bigint;--> statement-breakpoint
ALTER TABLE "shipment_cost" ADD COLUMN "shipping_account_id" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shipment_cost" ADD COLUMN "shipping_account_kind" text DEFAULT 'platform_master' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipment_cost" ADD COLUMN "shipping_discount_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_notification" ADD CONSTRAINT "issue_notification_report_id_issue_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."issue_report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount" ADD CONSTRAINT "discount_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount" ADD CONSTRAINT "discount_product_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount" ADD CONSTRAINT "discount_collection_fk" FOREIGN KEY ("store_id","collection_id") REFERENCES "public"."collection"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_buyer_usage" ADD CONSTRAINT "discount_buyer_usage_fk" FOREIGN KEY ("store_id","discount_id") REFERENCES "public"."discount"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemption" ADD CONSTRAINT "discount_redemption_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemption" ADD CONSTRAINT "discount_redemption_discount_fk" FOREIGN KEY ("store_id","discount_id") REFERENCES "public"."discount"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flash_sale" ADD CONSTRAINT "flash_sale_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flash_sale_item" ADD CONSTRAINT "flash_sale_item_sale_fk" FOREIGN KEY ("store_id","flash_sale_id") REFERENCES "public"."flash_sale"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flash_sale_item" ADD CONSTRAINT "flash_sale_item_product_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flash_sale_item" ADD CONSTRAINT "flash_sale_item_variant_fk" FOREIGN KEY ("store_id","variant_id") REFERENCES "public"."variant"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flash_sale_redemption" ADD CONSTRAINT "flash_redemption_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flash_sale_redemption" ADD CONSTRAINT "flash_redemption_item_fk" FOREIGN KEY ("store_id","item_id") REFERENCES "public"."flash_sale_item"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_hub" ADD CONSTRAINT "promo_hub_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_hub" ADD CONSTRAINT "promo_hub_banner_fk" FOREIGN KEY ("store_id","banner_media_id") REFERENCES "public"."media"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_hub_collection" ADD CONSTRAINT "promo_hub_collection_store_id_promo_hub_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."promo_hub"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_hub_collection" ADD CONSTRAINT "promo_hub_collection_fk" FOREIGN KEY ("store_id","collection_id") REFERENCES "public"."collection"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD CONSTRAINT "store_shipping_account_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_notification_report_uq" ON "issue_notification" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "flash_sale_variant_idx" ON "flash_sale_item" USING btree ("store_id","variant_id");--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_shipping_account_fk" FOREIGN KEY ("store_id","shipping_account_id","shipping_account_kind") REFERENCES "public"."store_shipping_account"("store_id","id","kind") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_account_fk" FOREIGN KEY ("store_id","shipping_account_id","shipping_account_kind") REFERENCES "public"."store_shipping_account"("store_id","id","kind") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "reconciliation_batch" ADD CONSTRAINT "reconciliation_batch_shipping_account_id_store_shipping_account_id_fk" FOREIGN KEY ("shipping_account_id") REFERENCES "public"."store_shipping_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cost" ADD CONSTRAINT "shipment_cost_account_fk" FOREIGN KEY ("store_id","shipping_account_id","shipping_account_kind") REFERENCES "public"."store_shipping_account"("store_id","id","kind") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_total_chk" CHECK ("order"."total" = "order"."subtotal" - "order"."goods_discount" + "order"."shipping_fee" and "order"."subtotal" >= 0 and "order"."shipping_fee" >= 0 and "order"."goods_discount" >= 0 and "order"."goods_discount" <= "order"."subtotal");--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_shipping_fee_chk" CHECK ("order"."shipping_fee" + "order"."shipping_discount" = "order"."shipping_provider_cost" + "order"."shipping_margin" and "order"."shipping_discount" >= 0 and "order"."shipping_discount" <= "order"."shipping_provider_cost" and "order"."shipping_provider_cost" >= 0 and "order"."shipping_margin" >= 0 and "order"."weight_kg" >= 1);--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_status_chk" CHECK ("shipment"."status" in ('queued', 'booking', 'awaiting_account', 'awaiting_balance', 'booked', 'in_transit', 'delivered', 'returned', 'problem', 'cancelled', 'failed'));--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_booked_chk" CHECK ("shipment"."status" in ('queued', 'booking', 'awaiting_account', 'failed') or "shipment"."provider_order_id" is not null);--> statement-breakpoint
ALTER TABLE "order_line_financials" ADD CONSTRAINT "order_line_shipping_discount_chk" CHECK ("order_line_financials"."shipping_discount_idr" >= 0);--> statement-breakpoint
ALTER TABLE "shipment_cost" ADD CONSTRAINT "shipment_cost_discount_chk" CHECK ("shipment_cost"."shipping_discount_idr" >= 0 and "shipment_cost"."seller_shipping_debit_idr" >= "shipment_cost"."shipping_discount_idr" and ("shipment_cost"."seller_shipping_debit_idr" = "shipment_cost"."shipping_discount_idr" or "shipment_cost"."platform_shipping_margin_idr" = 0));--> statement-breakpoint

-- ===== T-46 store-funded promotions, exact allocations and atomic counter backstops =====
ALTER TABLE public.discount ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.discount FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.discount USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.discount_buyer_usage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.discount_buyer_usage FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.discount_buyer_usage USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.discount_redemption ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.discount_redemption FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.discount_redemption USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.flash_sale ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.flash_sale FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.flash_sale USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.flash_sale_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.flash_sale_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.flash_sale_item USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.flash_sale_redemption ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.flash_sale_redemption FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.flash_sale_redemption USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.promo_hub ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.promo_hub FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.promo_hub USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.promo_hub_collection ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.promo_hub_collection FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.promo_hub_collection USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
REVOKE ALL ON public.discount, public.discount_buyer_usage, public.discount_redemption, public.flash_sale, public.flash_sale_item, public.flash_sale_redemption, public.promo_hub, public.promo_hub_collection FROM bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.discount, public.discount_buyer_usage, public.flash_sale, public.flash_sale_item, public.promo_hub TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.discount_redemption, public.flash_sale_redemption TO bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.promo_hub_collection TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, UPDATE ON public.discount, public.discount_buyer_usage, public.flash_sale_item TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON public.flash_sale, public.promo_hub, public.promo_hub_collection TO bukalaris_platform;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE public.discount_id_seq, public.flash_sale_id_seq, public.flash_sale_item_id_seq TO bukalaris_app;--> statement-breakpoint

-- No login can invoke a guard directly. Triggers always run with the pinned owner and qualified relations.
CREATE FUNCTION public.promotion_counter_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v public.discount%ROWTYPE; s public.flash_sale%ROWTYPE; p public.variant%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.promotion_reset', true) = 'demo' THEN RETURN OLD; END IF; -- the owner-only demo reset below, nothing else
    RAISE EXCEPTION 'promotion counters and evidence are not deleted' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'discount' THEN
    IF TG_OP = 'UPDATE' AND (NEW.store_id <> OLD.store_id OR NEW.code <> OLD.code OR NEW.code_sha256 <> OLD.code_sha256 OR NEW.created_at <> OLD.created_at OR NEW.used_count < OLD.used_count) THEN
      RAISE EXCEPTION 'voucher identity and consumed quota are immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.used_count > OLD.used_count AND (NEW.used_count <> OLD.used_count + 1 OR NEW.status <> 'active' OR pg_catalog.clock_timestamp() NOT BETWEEN NEW.starts_at AND NEW.ends_at) THEN
      RAISE EXCEPTION 'voucher reservation outside its window' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'discount_buyer_usage' THEN
    SELECT * INTO v FROM public.discount WHERE store_id = NEW.store_id AND id = NEW.discount_id;
    IF NOT FOUND OR (v.buyer_usage_limit IS NOT NULL AND NEW.used_count > v.buyer_usage_limit) THEN RAISE EXCEPTION 'buyer voucher quota exhausted' USING ERRCODE = '23514'; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.store_id <> OLD.store_id OR NEW.discount_id <> OLD.discount_id OR NEW.phone_fingerprint <> OLD.phone_fingerprint OR NEW.used_count <> OLD.used_count + 1) THEN
      RAISE EXCEPTION 'buyer counter can only increment once' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'flash_sale_item' THEN
    SELECT * INTO p FROM public.variant WHERE store_id = NEW.store_id AND id = NEW.variant_id;
    IF NOT FOUND OR p.product_id <> NEW.product_id OR NEW.sale_price_idr >= p.price THEN RAISE EXCEPTION 'flash variant and product must match and price must decrease' USING ERRCODE = '23514'; END IF;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.store_id <> OLD.store_id OR NEW.flash_sale_id <> OLD.flash_sale_id OR NEW.variant_id <> OLD.variant_id OR NEW.product_id <> OLD.product_id OR NEW.sold_count < OLD.sold_count THEN RAISE EXCEPTION 'flash identity and sold stock are immutable' USING ERRCODE = '23514'; END IF;
      IF NEW.sold_count > OLD.sold_count THEN
        SELECT * INTO s FROM public.flash_sale WHERE store_id = NEW.store_id AND id = NEW.flash_sale_id;
        IF s.status <> 'active' OR pg_catalog.clock_timestamp() NOT BETWEEN s.starts_at AND s.ends_at THEN RAISE EXCEPTION 'flash reservation outside its window' USING ERRCODE = '23514'; END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.promotion_counter_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER promotion_counter_guard BEFORE INSERT OR UPDATE OR DELETE ON public.discount FOR EACH ROW EXECUTE FUNCTION public.promotion_counter_guard();--> statement-breakpoint
CREATE TRIGGER promotion_counter_guard BEFORE INSERT OR UPDATE OR DELETE ON public.discount_buyer_usage FOR EACH ROW EXECUTE FUNCTION public.promotion_counter_guard();--> statement-breakpoint
CREATE TRIGGER promotion_counter_guard BEFORE INSERT OR UPDATE OR DELETE ON public.flash_sale_item FOR EACH ROW EXECUTE FUNCTION public.promotion_counter_guard();--> statement-breakpoint
CREATE FUNCTION public.promotion_evidence_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.current_setting('bukalaris.promotion_reset', true) = 'demo' THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.promotion_evidence_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER promotion_redemption_append_only BEFORE UPDATE OR DELETE ON public.discount_redemption FOR EACH ROW EXECUTE FUNCTION public.promotion_evidence_guard();--> statement-breakpoint
CREATE TRIGGER promotion_flash_redemption_append_only BEFORE UPDATE OR DELETE ON public.flash_sale_redemption FOR EACH ROW EXECUTE FUNCTION public.promotion_evidence_guard();--> statement-breakpoint

CREATE FUNCTION public.promotion_financial_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public."order"%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public."order" WHERE store_id = NEW.store_id AND id = NEW.order_id;
  -- NULL-safe: an unknown order, or any comparison that cannot be evaluated, is a refusal (a NULL in a CHECK-like test would pass silently).
  IF NOT FOUND OR NOT COALESCE(NEW.shipping_discount_idr = o.shipping_discount AND NEW.goods_discount_idr = o.goods_discount AND NEW.shipping_discount_idr <= o.shipping_provider_cost AND o.shipping_fee >= o.shipping_margin AND NEW.sale_amount_idr >= NEW.shipping_discount_idr, false) THEN
    RAISE EXCEPTION 'promotion cannot spend platform margin or make seller proceeds negative' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.promotion_financial_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER promotion_financial_guard BEFORE INSERT ON public.order_financials FOR EACH ROW EXECUTE FUNCTION public.promotion_financial_guard();--> statement-breakpoint

-- Replacement of the 0013 guard: the pre-existing goods/tax proof plus the new shipping-discount sum, checked at COMMIT.
CREATE OR REPLACE FUNCTION public.financial_lines_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n_fin integer; n_order integer; s_gross bigint; s_disc bigint; s_ship bigint; s_inc bigint; s_add bigint; s_proceeds bigint; s_order bigint;
BEGIN
  SELECT count(*), COALESCE(sum(line_gross_idr), 0), COALESCE(sum(discount_alloc_idr), 0), COALESCE(sum(shipping_discount_idr), 0), COALESCE(sum(included_tax_idr), 0), COALESCE(sum(added_tax_idr), 0), COALESCE(sum(commission_base_idr), 0)
    INTO n_fin, s_gross, s_disc, s_ship, s_inc, s_add, s_proceeds FROM public.order_line_financials WHERE store_id = NEW.store_id AND order_id = NEW.order_id;
  SELECT count(*), COALESCE(sum(line_total), 0) INTO n_order, s_order FROM public.order_line WHERE store_id = NEW.store_id AND order_id = NEW.order_id;
  IF n_fin <> n_order OR n_fin = 0 OR s_gross <> NEW.subtotal_idr OR s_order <> NEW.subtotal_idr OR s_disc <> NEW.goods_discount_idr OR s_ship <> NEW.shipping_discount_idr
     OR s_inc <> NEW.included_sales_tax_idr OR s_add <> NEW.added_sales_tax_idr OR s_proceeds <> NEW.goods_proceeds_idr THEN
    RAISE EXCEPTION 'the line allocations of order % do not add up to its financial snapshot', NEW.order_id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.financial_lines_check() FROM PUBLIC, bukalaris_app, bukalaris_platform;
--> statement-breakpoint

-- Local demo reset (packages/db/src/demo/seed-demo.ts): deletes the promotion rows of stores whose slug starts with 'demo-' and nothing else. Owner connection
-- only: no login role may call it (the platform login can write store.slug, so a slug guard alone would not be enough).
CREATE FUNCTION public.reset_demo_promotions(p_store_ids bigint[]) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_ids bigint[]; v_total bigint := 0; v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname LIKE 'pg\_%') THEN
    RAISE EXCEPTION 'reset refused: a temporary relation shadows a system catalog' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT pg_catalog.array_agg(s.id) INTO v_ids FROM public.store s WHERE s.id = ANY (p_store_ids) AND s.slug LIKE 'demo-%';
  IF v_ids IS NULL THEN RETURN 0; END IF;
  PERFORM pg_catalog.set_config('bukalaris.promotion_reset', 'demo', true);
  DELETE FROM public.discount_redemption WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.flash_sale_redemption WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.discount_buyer_usage WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.promo_hub_collection WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.promo_hub WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.flash_sale_item WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.flash_sale WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.discount WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  PERFORM pg_catalog.set_config('bukalaris.promotion_reset', '', true);
  RETURN v_total;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reset_demo_promotions(bigint[]) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint

-- ===== T-48 Unified Partner accounts: local/fake only, provider rotation and live settlement gates unchanged =====
REVOKE ALL ON public.store_shipping_account, public.cashback_rule, public.shipping_control, public.shipping_partner_budget, public.shipping_dispatch_lease FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
ALTER TABLE public.store_shipping_account ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.store_shipping_account FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.store_shipping_account USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT (id, store_id, kind, status, last_checked_at, last_result, revision) ON public.store_shipping_account TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, UPDATE ON public.store_shipping_account TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON public.shipping_control TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, UPDATE ON public.shipping_control TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.cashback_rule, public.shipping_partner_budget, public.shipping_dispatch_lease TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON public.store_pickup_area TO bukalaris_platform;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE public.cashback_rule_id_seq TO bukalaris_platform;--> statement-breakpoint
INSERT INTO public.shipping_control (key) VALUES ('default');--> statement-breakpoint
INSERT INTO public.platform_job_kind (kind) VALUES ('shipping.account.sync'), ('shipping.account.sweep'), ('shipping.credentials.reseal') ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Every creation path receives the two store-bound identities. Partner provisioning is an automatic, bounded worker operation.
CREATE FUNCTION public.shipping_store_bootstrap() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.store_shipping_account (store_id, kind, status, external_user_id)
  VALUES (NEW.id, 'platform_master', 'active', 'store:' || NEW.id::text), (NEW.id, 'partner_managed', 'pending', 'store:' || NEW.id::text)
  ON CONFLICT (store_id, kind) DO NOTHING;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.shipping_store_bootstrap() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER shipping_store_bootstrap AFTER INSERT ON public.store FOR EACH ROW EXECUTE FUNCTION public.shipping_store_bootstrap();--> statement-breakpoint
INSERT INTO public.store_shipping_account (store_id, kind, status, external_user_id)
SELECT s.id, k.kind, CASE WHEN k.kind = 'platform_master' THEN 'active' ELSE 'pending' END, 'store:' || s.id::text
FROM public.store s CROSS JOIN (VALUES ('platform_master'), ('partner_managed')) k(kind);--> statement-breakpoint

-- Existing fake/master orders retain their original execution identity; no historical snapshot is silently moved to a new partner account.
UPDATE public."order" o SET shipping_account_id = a.id, shipping_account_kind = a.kind FROM public.store_shipping_account a WHERE a.store_id = o.store_id AND a.kind = 'platform_master';--> statement-breakpoint
ALTER TABLE public.order_financials DISABLE TRIGGER order_financials_guard;--> statement-breakpoint
UPDATE public.order_financials f SET shipping_account_id = o.shipping_account_id, shipping_account_kind = o.shipping_account_kind FROM public."order" o WHERE o.store_id = f.store_id AND o.id = f.order_id;--> statement-breakpoint
ALTER TABLE public.order_financials ENABLE TRIGGER order_financials_guard;--> statement-breakpoint
ALTER TABLE public.shipment_cost DISABLE TRIGGER shipment_cost_guard;--> statement-breakpoint
UPDATE public.shipment_cost c SET shipping_account_id = f.shipping_account_id, shipping_account_kind = f.shipping_account_kind, shipping_discount_idr = f.shipping_discount_idr FROM public.order_financials f WHERE f.store_id = c.store_id AND f.order_id = c.order_id;--> statement-breakpoint
ALTER TABLE public.shipment_cost ENABLE TRIGGER shipment_cost_guard;--> statement-breakpoint
ALTER TABLE public."order" VALIDATE CONSTRAINT order_shipping_account_fk;--> statement-breakpoint
ALTER TABLE public.order_financials VALIDATE CONSTRAINT order_financials_account_fk;--> statement-breakpoint
ALTER TABLE public.shipment_cost VALIDATE CONSTRAINT shipment_cost_account_fk;--> statement-breakpoint

CREATE FUNCTION public.shipping_account_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
  IF NEW.last_result IS NOT NULL AND NEW.last_result NOT IN ('ready', 'EMAIL_ALREADY_REGISTERED', 'SELLER_DEACTIVATED', 'API_KEY_DISABLED', 'RATE_LIMITED', 'INVALID_RESPONSE', 'PROVIDER_UNAVAILABLE') THEN
    RAISE EXCEPTION 'health stores codes only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.shipping_account_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER shipping_account_guard BEFORE UPDATE OR DELETE ON public.store_shipping_account FOR EACH ROW EXECUTE FUNCTION public.shipping_account_guard();--> statement-breakpoint

-- A zero default is an instruction to derive the account INSIDE the writer transaction, not a stored or client-selectable identity.
CREATE FUNCTION public.shipping_snapshot_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a public.store_shipping_account%ROWTYPE; o public."order"%ROWTYPE; f public.order_financials%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.shipping_account_id, NEW.shipping_account_kind) IS DISTINCT FROM (OLD.shipping_account_id, OLD.shipping_account_kind) THEN
      RAISE EXCEPTION 'the shipping account snapshot is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'order' THEN
    IF NEW.shipping_account_id = 0 THEN
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
    IF NEW.shipping_account_id = 0 THEN NEW.shipping_account_id := o.shipping_account_id; NEW.shipping_account_kind := o.shipping_account_kind; END IF;
    IF o.id IS NULL OR (NEW.shipping_account_id, NEW.shipping_account_kind) IS DISTINCT FROM (o.shipping_account_id, o.shipping_account_kind) THEN
      RAISE EXCEPTION 'financial and booking accounts equal the frozen order account' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_TABLE_NAME = 'shipment_cost' THEN
      SELECT * INTO f FROM public.order_financials WHERE store_id = NEW.store_id AND order_id = NEW.order_id;
      IF f.order_id IS NULL OR NEW.shipping_discount_idr <> f.shipping_discount_idr THEN
        RAISE EXCEPTION 'booking discounts equal frozen financial discounts' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.shipping_snapshot_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER a_shipping_snapshot_guard BEFORE INSERT OR UPDATE ON public."order" FOR EACH ROW EXECUTE FUNCTION public.shipping_snapshot_guard();--> statement-breakpoint
CREATE TRIGGER a_shipping_snapshot_guard BEFORE INSERT ON public.order_financials FOR EACH ROW EXECUTE FUNCTION public.shipping_snapshot_guard();--> statement-breakpoint
CREATE TRIGGER a_shipping_snapshot_guard BEFORE INSERT ON public.shipment_cost FOR EACH ROW EXECUTE FUNCTION public.shipping_snapshot_guard();--> statement-breakpoint

CREATE FUNCTION public.shipping_reconciliation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b public.reconciliation_batch%ROWTYPE; a bigint;
BEGIN
  IF TG_TABLE_NAME = 'reconciliation_batch_item' THEN
    SELECT shipping_account_id INTO a FROM public."order" WHERE store_id = NEW.store_id AND id = NEW.order_id;
    SELECT * INTO b FROM public.reconciliation_batch WHERE id = NEW.batch_id FOR UPDATE;
    IF a IS NULL OR b.shipping_account_id IS NULL OR a <> b.shipping_account_id THEN
      RAISE EXCEPTION 'reconciliation evidence belongs to the batch account' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF TG_OP = 'INSERT' AND NEW.shipping_account_id IS NULL THEN RAISE EXCEPTION 'a new batch names its provider account' USING ERRCODE = 'check_violation'; END IF;
    IF TG_OP = 'UPDATE' AND NEW.shipping_account_id IS DISTINCT FROM OLD.shipping_account_id THEN RAISE EXCEPTION 'batch account is immutable' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF NEW.status = 'applied' THEN
      IF NOT public.approval_binds(NEW.approval_request_id, 'cod.reconcile_release', 'reconciliation_batch', NEW.id::text,
        jsonb_build_object('batchId', NEW.id, 'shippingAccountId', NEW.shipping_account_id, 'payloadSha256', NEW.payload_sha256, 'itemCount', NEW.item_count, 'evidenceRef', NEW.evidence_ref)) THEN
        RAISE EXCEPTION 'account-bound four-eyes reconciliation required' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.shipping_reconciliation_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER z_shipping_reconciliation_guard BEFORE INSERT OR UPDATE ON public.reconciliation_batch FOR EACH ROW EXECUTE FUNCTION public.shipping_reconciliation_guard();--> statement-breakpoint
CREATE TRIGGER z_shipping_reconciliation_guard BEFORE INSERT ON public.reconciliation_batch_item FOR EACH ROW EXECUTE FUNCTION public.shipping_reconciliation_guard();--> statement-breakpoint

CREATE FUNCTION public.shipping_policy_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p jsonb; target text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'shipping policy is retained' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF TG_TABLE_NAME = 'shipping_control' THEN
    p := jsonb_build_object('revision', OLD.revision, 'preferPartner', NEW.prefer_partner, 'discountIdr', NEW.discount_idr, 'discountBps', NEW.discount_bps); target := 'shipping_policy';
    IF NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'stale shipping settings' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    p := jsonb_build_object('fixedIdr', NEW.fixed_idr, 'percentBps', NEW.percent_bps, 'roundTo', NEW.round_to); target := 'shipping_margin_rule';
  END IF;
  IF NOT public.approval_binds(NEW.approval_request_id, 'shipping.margin', target, 'default', p)
     OR NOT EXISTS (SELECT 1 FROM public.approval_request ar WHERE ar.id = NEW.approval_request_id AND ar.requested_by = NEW.updated_by AND ar.status = 'executed' AND ar.executed_at = now()) THEN
    RAISE EXCEPTION 'shipping pricing requires the executed approval of this exact change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.shipping_policy_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER shipping_policy_guard BEFORE UPDATE OR DELETE ON public.shipping_control FOR EACH ROW EXECUTE FUNCTION public.shipping_policy_guard();--> statement-breakpoint
CREATE TRIGGER shipping_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON public.shipping_margin_rule FOR EACH ROW EXECUTE FUNCTION public.shipping_policy_guard();--> statement-breakpoint
ALTER TABLE public.cashback_rule ADD CONSTRAINT cashback_rule_dormant_chk CHECK (status = 'disabled' AND seller_share_bps >= 0);--> statement-breakpoint
-- Nothing here activates shipping cashback: OPEN-F9 (provider rebate evidence) and the owner's split rule are both missing (D-22).
-- A courier code differs only by case from an existing policy row: two rows would let a COD-allowed spelling shadow a refusal (the reader lower-cases).
CREATE UNIQUE INDEX courier_service_policy_ci_uq ON public.courier_service_policy (lower(courier_code), lower(service_code));--> statement-breakpoint

-- Local demo reset only: owner connection only (no login role may execute it), demo-% stores only. Accounts of a store with an order, a batch or a
-- recorded provider call stay protected by their foreign keys; the demo sweep removes orders first and calls this last.
CREATE FUNCTION public.reset_demo_shipping(p_store_ids bigint[]) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_ids bigint[]; v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname LIKE 'pg\_%') THEN
    RAISE EXCEPTION 'reset refused: a temporary relation shadows a system catalog' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT pg_catalog.array_agg(s.id) INTO v_ids FROM public.store s WHERE s.id = ANY (p_store_ids) AND s.slug LIKE 'demo-%';
  IF v_ids IS NULL THEN RETURN 0; END IF;
  PERFORM pg_catalog.set_config('bukalaris.shipping_reset', 'demo', true);
  DELETE FROM public.store_shipping_account WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reset_demo_shipping(bigint[]) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint

-- ===== T-68: platform issue queue, OBS-6 durable notifications, JOB-13 anonymisation (OFF by default).
REVOKE ALL ON public.issue_notification FROM PUBLIC, bukalaris_app, bukalaris_platform;
GRANT SELECT, INSERT ON public.issue_notification TO bukalaris_platform;
GRANT USAGE ON SEQUENCE public.issue_notification_id_seq TO bukalaris_platform;
GRANT UPDATE ON public.issue_report TO bukalaris_platform;
CREATE TRIGGER issue_notification_append_only BEFORE UPDATE OR DELETE ON public.issue_notification FOR EACH ROW EXECUTE FUNCTION public.append_only_guard();
--> statement-breakpoint
CREATE FUNCTION public.issue_report_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Wave 4 review: INSERT is covered too (a platform-login insert could create a resolved report without a note, a duplicate of a duplicate or an assignee
  -- without the grant), and what identifies a report never changes afterwards (the reporter, the clock the retention sweep reads, the page, the dedupe key).
  IF TG_OP = 'INSERT' THEN
    IF NOT pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER')
       AND (NEW.status <> 'new' OR NEW.assignee_id IS NOT NULL OR NEW.duplicate_of IS NOT NULL OR NEW.resolution_note IS NOT NULL OR NEW.resolved_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a new issue report starts as new, unassigned and unresolved' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.reporter_id, NEW.created_at, NEW.page_id, NEW.route, NEW.dedupe_key, NEW.client_request_id, NEW.category, NEW.severity)
     IS DISTINCT FROM (OLD.reporter_id, OLD.created_at, OLD.page_id, OLD.route, OLD.dedupe_key, OLD.client_request_id, OLD.category, OLD.severity) THEN
    RAISE EXCEPTION 'the identity of an issue report is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.description IS DISTINCT FROM OLD.description OR NEW.context IS DISTINCT FROM OLD.context) AND NOT (NEW.scrubbed AND NOT OLD.scrubbed) THEN
    RAISE EXCEPTION 'description and context change only through the retention anonymisation' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'new' AND NEW.status IN ('triaged','duplicate','wont_fix'))
      OR (OLD.status = 'triaged' AND NEW.status IN ('in_progress','resolved','duplicate','wont_fix'))
      OR (OLD.status = 'in_progress' AND NEW.status IN ('triaged','resolved','wont_fix'))
      OR (OLD.status IN ('resolved','wont_fix','duplicate') AND NEW.status = 'triaged')) THEN
      RAISE EXCEPTION 'illegal issue transition' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('resolved','wont_fix','duplicate') AND coalesce(length(btrim(NEW.resolution_note)),0) = 0 THEN
      RAISE EXCEPTION 'resolution note required' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status = 'duplicate' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.duplicate_of IS DISTINCT FROM OLD.duplicate_of) THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(680068);
    IF NEW.duplicate_of = NEW.id OR NOT EXISTS (SELECT 1 FROM public.issue_report r WHERE r.id = NEW.duplicate_of AND r.status <> 'duplicate')
      OR EXISTS (SELECT 1 FROM public.issue_report r WHERE r.duplicate_of = NEW.id) THEN
      RAISE EXCEPTION 'invalid duplicate target' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.assignee_id IS DISTINCT FROM OLD.assignee_id AND NEW.assignee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.operator_grant g JOIN public.platform_operator o ON o.user_id = g.user_id
    WHERE g.user_id = NEW.assignee_id AND g.capability = 'ops.issues.manage' AND (g.expires_at IS NULL OR g.expires_at > now()) AND o.deactivated_at IS NULL
  ) THEN RAISE EXCEPTION 'invalid issue assignee' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.issue_report_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;
CREATE TRIGGER issue_report_guard BEFORE INSERT OR UPDATE ON public.issue_report FOR EACH ROW EXECUTE FUNCTION public.issue_report_guard();
--> statement-breakpoint
INSERT INTO public.retention_class (class, table_name, time_column, row_filter) VALUES ('issue_report','issue_report','created_at','false');
INSERT INTO public.platform_job_kind (kind) VALUES ('retention.issue_report');
-- No policy row: the privacy owner has not selected a period. Only context is anonymised; immutable decision evidence survives.
CREATE FUNCTION public.retention_anonymize_issues(p_batch integer, p_now timestamptz) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE days integer; n bigint;
BEGIN
  SELECT p.period_days INTO days FROM public.retention_policy p WHERE p.class = 'issue_report';
  IF days IS NULL THEN RETURN 0; END IF;
  IF p_batch < 1 OR p_batch > 10000 THEN RAISE EXCEPTION 'invalid batch' USING ERRCODE = 'invalid_parameter_value'; END IF;
  UPDATE public.issue_report r SET context = '{}'::jsonb, description = '[retained metadata only]', resolution_note = NULL, scrubbed = true
  WHERE r.id IN (
    SELECT i.id FROM public.issue_report i WHERE i.created_at < p_now - make_interval(days => days)
      AND (i.context <> '{}'::jsonb OR i.description <> '[retained metadata only]' OR i.resolution_note IS NOT NULL)
    ORDER BY i.id LIMIT p_batch FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.retention_anonymize_issues(integer,timestamptz) FROM PUBLIC, bukalaris_app, bukalaris_platform;
--> statement-breakpoint
CREATE FUNCTION public.retention_purge_issue_report(p_batch integer) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT public.retention_anonymize_issues(p_batch, now()) $$;
REVOKE ALL ON FUNCTION public.retention_purge_issue_report(integer) FROM PUBLIC, bukalaris_app;
GRANT EXECUTE ON FUNCTION public.retention_purge_issue_report(integer) TO bukalaris_platform;
