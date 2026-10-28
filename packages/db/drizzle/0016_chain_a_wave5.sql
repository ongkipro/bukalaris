CREATE TABLE "checkout_session" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checkout_session_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"cart_id" uuid NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"buyer_name" text,
	"buyer_phone" text,
	"buyer_email" text,
	"shipping_address" text,
	"subtotal_idr" bigint DEFAULT 0 NOT NULL,
	"abandoned_at" timestamp with time zone,
	"recovered_at" timestamp with time zone,
	"wa_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_session_cart_uq" UNIQUE("store_id","cart_id"),
	CONSTRAINT "checkout_session_public_uq" UNIQUE("public_id"),
	CONSTRAINT "checkout_session_status_chk" CHECK ("checkout_session"."status" in ('active', 'abandoned', 'recovered')),
	CONSTRAINT "checkout_session_stamps_chk" CHECK (("checkout_session"."status" <> 'abandoned' or "checkout_session"."abandoned_at" is not null) and (("checkout_session"."status" = 'recovered') = ("checkout_session"."recovered_at" is not null))),
	CONSTRAINT "checkout_session_amount_chk" CHECK ("checkout_session"."subtotal_idr" >= 0),
	CONSTRAINT "checkout_session_text_chk" CHECK (char_length("checkout_session"."buyer_name") <= 120 and char_length("checkout_session"."buyer_phone") <= 32 and char_length("checkout_session"."buyer_email") <= 254 and char_length("checkout_session"."shipping_address") <= 500)
);
--> statement-breakpoint
CREATE TABLE "affiliate" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "affiliate_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"contact_phone" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "affiliate_status_chk" CHECK ("affiliate"."status" in ('pending', 'active', 'rejected', 'suspended', 'closed')),
	CONSTRAINT "affiliate_phone_chk" CHECK ("affiliate"."contact_phone" ~ '^628[0-9]{7,12}$'),
	CONSTRAINT "affiliate_name_chk" CHECK (char_length(btrim("affiliate"."display_name")) between 2 and 80),
	CONSTRAINT "affiliate_reason_chk" CHECK ("affiliate"."status" not in ('rejected', 'suspended', 'closed') or char_length(btrim(coalesce("affiliate"."status_reason", ''))) between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "affiliate_attribution" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "affiliate_attribution_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"store_id" bigint NOT NULL,
	"affiliate_id" bigint NOT NULL,
	"source" text DEFAULT 'bukalaris' NOT NULL,
	"method" text NOT NULL,
	"code_id" bigint,
	"click_id" text,
	"click_detached_at" timestamp with time zone,
	"window_days" integer NOT NULL,
	"hold_days" integer NOT NULL,
	"policy_revision" integer NOT NULL,
	"seller_policy_revision" integer NOT NULL,
	"commission_base_idr" bigint NOT NULL,
	"commission_idr" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"eligible_at" timestamp with time zone,
	"credit_ref" text,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_attribution_order_uq" UNIQUE("order_id"),
	CONSTRAINT "affiliate_attribution_source_chk" CHECK ("affiliate_attribution"."source" = 'bukalaris'),
	CONSTRAINT "affiliate_attribution_method_chk" CHECK ("affiliate_attribution"."method" in ('code', 'link') and (("affiliate_attribution"."method" = 'code') = ("affiliate_attribution"."code_id" is not null))),
	CONSTRAINT "affiliate_attribution_click_chk" CHECK ("affiliate_attribution"."click_id" is null or "affiliate_attribution"."click_detached_at" is null),
	CONSTRAINT "affiliate_attribution_amounts_chk" CHECK ("affiliate_attribution"."commission_idr" > 0 and "affiliate_attribution"."commission_base_idr" >= "affiliate_attribution"."commission_idr" and "affiliate_attribution"."window_days" >= 1 and "affiliate_attribution"."hold_days" >= 0 and "affiliate_attribution"."policy_revision" >= 1 and "affiliate_attribution"."seller_policy_revision" >= 1),
	CONSTRAINT "affiliate_attribution_status_chk" CHECK ("affiliate_attribution"."status" in ('pending', 'credited', 'paid_out', 'void') and ("affiliate_attribution"."status" <> 'void' or "affiliate_attribution"."void_reason" is not null) and ("affiliate_attribution"."status" in ('pending', 'void') or "affiliate_attribution"."eligible_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "affiliate_block" (
	"store_id" bigint NOT NULL,
	"affiliate_id" bigint NOT NULL,
	"reason" text NOT NULL,
	"blocked_by" text NOT NULL,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_block_pk" PRIMARY KEY("store_id","affiliate_id"),
	CONSTRAINT "affiliate_block_reason_chk" CHECK (char_length(btrim("affiliate_block"."reason")) between 1 and 300)
);
--> statement-breakpoint
CREATE TABLE "affiliate_catalog" (
	"source" text DEFAULT 'bukalaris' NOT NULL,
	"offer_id" bigint NOT NULL,
	"store_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"store_slug" text NOT NULL,
	"store_name" text NOT NULL,
	"product_title" text NOT NULL,
	"product_path" text NOT NULL,
	"price_from_idr" bigint,
	"in_stock" boolean DEFAULT false NOT NULL,
	"image_media_id" bigint,
	"rate_bps" integer,
	"active" boolean DEFAULT false NOT NULL,
	"source_revision" integer NOT NULL,
	"seller_policy_revision" integer DEFAULT 0 NOT NULL,
	"projected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_catalog_offer_pk" UNIQUE("source","offer_id"),
	CONSTRAINT "affiliate_catalog_product_uq" UNIQUE("source","store_id","product_id"),
	CONSTRAINT "affiliate_catalog_source_chk" CHECK ("affiliate_catalog"."source" = 'bukalaris'),
	CONSTRAINT "affiliate_catalog_active_chk" CHECK (not "affiliate_catalog"."active" or ("affiliate_catalog"."rate_bps" is not null and "affiliate_catalog"."price_from_idr" is not null))
);
--> statement-breakpoint
CREATE TABLE "affiliate_click" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" bigint NOT NULL,
	"affiliate_id" bigint NOT NULL,
	"store_id" bigint NOT NULL,
	"offer_id" bigint,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "affiliate_click_target_uq" UNIQUE("id","affiliate_id","store_id"),
	CONSTRAINT "affiliate_click_id_chk" CHECK ("affiliate_click"."id" ~ '^c[0-9a-f]{32}$'),
	CONSTRAINT "affiliate_click_window_chk" CHECK ("affiliate_click"."expires_at" > "affiliate_click"."captured_at")
);
--> statement-breakpoint
CREATE TABLE "affiliate_code" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "affiliate_code_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"affiliate_id" bigint NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "affiliate_code_code_unique" UNIQUE("code"),
	CONSTRAINT "affiliate_code_owner_uq" UNIQUE("affiliate_id","id"),
	CONSTRAINT "affiliate_code_form_chk" CHECK ("affiliate_code"."code" ~ '^[A-Z0-9]{4,24}$'),
	CONSTRAINT "affiliate_code_status_chk" CHECK ("affiliate_code"."status" in ('active', 'revoked') and ("affiliate_code"."status" = 'revoked') = ("affiliate_code"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "affiliate_counter" (
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"affiliate_id" bigint,
	"n" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "affiliate_counter_kind_chk" CHECK ("affiliate_counter"."kind" in ('click_captured', 'self_referral_suppressed', 'click_refused_rate', 'click_non_navigation', 'code_failure') and "affiliate_counter"."n" >= 0)
);
--> statement-breakpoint
CREATE TABLE "affiliate_link" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "affiliate_link_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"affiliate_id" bigint NOT NULL,
	"token" text NOT NULL,
	"store_id" bigint NOT NULL,
	"offer_id" bigint,
	"source" text DEFAULT 'bukalaris' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "affiliate_link_token_unique" UNIQUE("token"),
	CONSTRAINT "affiliate_link_owner_uq" UNIQUE("affiliate_id","id"),
	CONSTRAINT "affiliate_link_target_uq" UNIQUE("id","affiliate_id","store_id"),
	CONSTRAINT "affiliate_link_token_chk" CHECK ("affiliate_link"."token" ~ '^[A-Za-z0-9_-]{16,64}$'),
	CONSTRAINT "affiliate_link_source_chk" CHECK ("affiliate_link"."source" = 'bukalaris'),
	CONSTRAINT "affiliate_link_status_chk" CHECK ("affiliate_link"."status" in ('active', 'revoked') and ("affiliate_link"."status" = 'revoked') = ("affiliate_link"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "affiliate_offer" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "affiliate_offer_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"source" text DEFAULT 'bukalaris' NOT NULL,
	"product_id" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rate_bps" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_offer_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "affiliate_offer_product_uq" UNIQUE("store_id","source","product_id"),
	CONSTRAINT "affiliate_offer_source_chk" CHECK ("affiliate_offer"."source" = 'bukalaris'),
	CONSTRAINT "affiliate_offer_status_chk" CHECK ("affiliate_offer"."status" in ('active', 'paused', 'withdrawn')),
	CONSTRAINT "affiliate_offer_rate_chk" CHECK ("affiliate_offer"."rate_bps" is null or "affiliate_offer"."rate_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "affiliate_policy" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"min_rate_bps" integer NOT NULL,
	"max_rate_bps" integer NOT NULL,
	"attribution_window_days" integer NOT NULL,
	"hold_days" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_policy_singleton_chk" CHECK ("affiliate_policy"."id" = 1),
	CONSTRAINT "affiliate_policy_rate_chk" CHECK ("affiliate_policy"."min_rate_bps" >= 0 and "affiliate_policy"."min_rate_bps" <= "affiliate_policy"."max_rate_bps" and "affiliate_policy"."max_rate_bps" <= 10000),
	CONSTRAINT "affiliate_policy_window_chk" CHECK ("affiliate_policy"."attribution_window_days" between 1 and 365 and "affiliate_policy"."hold_days" between 0 and 90)
);
--> statement-breakpoint
CREATE TABLE "affiliate_seller_policy" (
	"store_id" bigint PRIMARY KEY NOT NULL,
	"participation" text DEFAULT 'closed' NOT NULL,
	"default_rate_bps" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_seller_policy_state_chk" CHECK ("affiliate_seller_policy"."participation" in ('closed', 'open')),
	CONSTRAINT "affiliate_seller_policy_rate_chk" CHECK ("affiliate_seller_policy"."default_rate_bps" is null or "affiliate_seller_policy"."default_rate_bps" between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "order_financials" DROP CONSTRAINT "order_financials_amounts_chk";--> statement-breakpoint
ALTER TABLE "shipment_cost" DROP CONSTRAINT "shipment_cost_amounts_chk";--> statement-breakpoint
ALTER TABLE "shipment_cost" DROP CONSTRAINT "shipment_cost_identity_chk";--> statement-breakpoint
ALTER TABLE "shipping_margin_rule" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN "platform_shipping_discount_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN "affiliate_id" bigint;--> statement-breakpoint
ALTER TABLE "shipment_cost" ADD COLUMN "platform_shipping_discount_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD COLUMN "registration_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_session" ADD CONSTRAINT "checkout_session_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_session" ADD CONSTRAINT "checkout_session_cart_fk" FOREIGN KEY ("store_id","cart_id") REFERENCES "public"."cart"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate" ADD CONSTRAINT "affiliate_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_attribution" ADD CONSTRAINT "affiliate_attribution_affiliate_id_affiliate_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_attribution" ADD CONSTRAINT "affiliate_attribution_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order_financials"("store_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_attribution" ADD CONSTRAINT "affiliate_attribution_code_fk" FOREIGN KEY ("affiliate_id","code_id") REFERENCES "public"."affiliate_code"("affiliate_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_attribution" ADD CONSTRAINT "affiliate_attribution_click_fk" FOREIGN KEY ("click_id","affiliate_id","store_id") REFERENCES "public"."affiliate_click"("id","affiliate_id","store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_block" ADD CONSTRAINT "affiliate_block_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_block" ADD CONSTRAINT "affiliate_block_affiliate_id_affiliate_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_catalog" ADD CONSTRAINT "affiliate_catalog_offer_fk" FOREIGN KEY ("store_id","offer_id") REFERENCES "public"."affiliate_offer"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_click" ADD CONSTRAINT "affiliate_click_link_fk" FOREIGN KEY ("link_id","affiliate_id","store_id") REFERENCES "public"."affiliate_link"("id","affiliate_id","store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_code" ADD CONSTRAINT "affiliate_code_affiliate_id_affiliate_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_counter" ADD CONSTRAINT "affiliate_counter_affiliate_id_affiliate_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_link" ADD CONSTRAINT "affiliate_link_affiliate_id_affiliate_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_link" ADD CONSTRAINT "affiliate_link_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_link" ADD CONSTRAINT "affiliate_link_offer_fk" FOREIGN KEY ("store_id","offer_id") REFERENCES "public"."affiliate_offer"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_offer" ADD CONSTRAINT "affiliate_offer_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_offer" ADD CONSTRAINT "affiliate_offer_product_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_seller_policy" ADD CONSTRAINT "affiliate_seller_policy_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkout_session_status_idx" ON "checkout_session" USING btree ("store_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "checkout_session_created_idx" ON "checkout_session" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "affiliate_attribution_affiliate_idx" ON "affiliate_attribution" USING btree ("affiliate_id","id");--> statement-breakpoint
CREATE INDEX "affiliate_catalog_active_idx" ON "affiliate_catalog" USING btree ("active","store_id","product_id");--> statement-breakpoint
CREATE INDEX "affiliate_click_affiliate_idx" ON "affiliate_click" USING btree ("affiliate_id","captured_at");--> statement-breakpoint
CREATE INDEX "affiliate_click_captured_idx" ON "affiliate_click" USING btree ("captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_counter_uq" ON "affiliate_counter" USING btree ("day","kind",coalesce("affiliate_id", 0));--> statement-breakpoint
CREATE INDEX "affiliate_link_affiliate_idx" ON "affiliate_link" USING btree ("affiliate_id","id");--> statement-breakpoint
CREATE INDEX "affiliate_offer_product_idx" ON "affiliate_offer" USING btree ("store_id","product_id");--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_affiliate_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_affiliate_chk" CHECK ("order_financials"."affiliate_commission_idr" = 0 or "order_financials"."affiliate_id" is not null);--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_amounts_chk" CHECK ("order_financials"."subtotal_idr" >= 0 and "order_financials"."goods_discount_idr" >= 0 and "order_financials"."shipping_discount_idr" >= 0 and "order_financials"."platform_shipping_discount_idr" >= 0 and "order_financials"."included_sales_tax_idr" >= 0 and "order_financials"."added_sales_tax_idr" >= 0 and "order_financials"."goods_proceeds_idr" >= 0 and "order_financials"."shipping_charged_idr" >= 0 and "order_financials"."shipping_cashback_gross_idr" >= 0 and "order_financials"."platform_cashback_idr" >= 0 and "order_financials"."seller_cashback_idr" >= 0 and "order_financials"."affiliate_commission_idr" >= 0 and "order_financials"."cod_fee_idr" >= 0 and "order_financials"."cod_fee_vat_idr" >= 0 and "order_financials"."payable_idr" >= 0 and "order_financials"."sale_amount_idr" >= 0 and "order_financials"."expected_gateway_fee_idr" >= 0);--> statement-breakpoint
ALTER TABLE "order_line_financials" ADD CONSTRAINT "order_line_commission_rate_chk" CHECK ("order_line_financials"."commission_rate_bps" is null or "order_line_financials"."commission_rate_bps" between 0 and 10000);--> statement-breakpoint
ALTER TABLE "shipment_cost" ADD CONSTRAINT "shipment_cost_amounts_chk" CHECK ("shipment_cost"."booked_shipping_idr" >= 0 and "shipment_cost"."shipping_charged_idr" >= 0 and "shipment_cost"."platform_shipping_discount_idr" >= 0 and "shipment_cost"."seller_shipping_debit_idr" >= 0 and "shipment_cost"."platform_shipping_margin_idr" >= 0 and "shipment_cost"."provider_cod_fee_idr" >= 0 and ("shipment_cost"."cod_amount_sent_idr" is null or "shipment_cost"."cod_amount_sent_idr" > 0));--> statement-breakpoint
ALTER TABLE "shipment_cost" ADD CONSTRAINT "shipment_cost_identity_chk" CHECK ("shipment_cost"."shipping_charged_idr" + "shipment_cost"."platform_shipping_discount_idr" + "shipment_cost"."seller_shipping_debit_idr" = "shipment_cost"."booked_shipping_idr" + "shipment_cost"."platform_shipping_margin_idr");--> statement-breakpoint
ALTER TABLE "store_shipping_account" ADD CONSTRAINT "shipping_account_attempts_chk" CHECK ("store_shipping_account"."registration_attempts" >= 0);--> statement-breakpoint

-- ===== T-45 abandoned checkout capture and 1-click WhatsApp recovery (PR-25, DATA-8, PRIV-1, TEN-1) =====
-- checkout_session is a tenant table: FORCE RLS on the store key. The app role (hosted checkout capture, the order transaction that marks a
-- recovery, the seller's "WA dibuka" stamp, the T-43 redaction) can read, insert and update but never delete; the platform role (cleanup.ts) sweeps
-- idle sessions to abandoned and purges rows older than 30 days. Nothing in it is evidence: it is short-lived buyer data, so it has no append-only rule.
ALTER TABLE public.checkout_session ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.checkout_session FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.checkout_session USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
REVOKE ALL ON public.checkout_session FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.checkout_session TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON public.checkout_session TO bukalaris_platform;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE public.checkout_session_id_seq TO bukalaris_app;--> statement-breakpoint

-- One guard for every write path. A new session starts active and unstamped. After that: identity never changes; `recovered` is final; both stamps are
-- monotonic (a recovery never erases `abandoned_at`), and both are written by the database clock, never by the caller. A session becomes abandoned only
-- after 60 minutes without a capture (the sweep's rule, enforced here so no caller can inflate the Abandon Rate), without touching `updated_at`. A returning
-- buyer (a capture that moves `updated_at`) takes an abandoned session back to active. "WA dibuka" is recorded only on an abandoned session.
CREATE FUNCTION public.checkout_session_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_owner boolean := pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER'); -- the table owner / superuser (fixtures, repairs) keeps full control
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.abandoned_at IS NOT NULL OR NEW.recovered_at IS NOT NULL OR NEW.wa_opened_at IS NOT NULL THEN
      RAISE EXCEPTION 'a checkout session starts active and unstamped' USING ERRCODE = '23514';
    END IF;
    -- Wave 5 review: the idle clock and the purge clock are the database's, never the caller's (a pre-aged row could be abandoned at once, a future one never purged).
    IF NOT v_owner THEN NEW.created_at := pg_catalog.clock_timestamp(); NEW.updated_at := pg_catalog.clock_timestamp(); END IF;
    RETURN NEW;
  END IF;
  IF NOT v_owner THEN
    IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN NEW.updated_at := pg_catalog.clock_timestamp(); END IF; -- buyer activity stamps "now", whatever the caller wrote
    IF NEW.wa_opened_at IS DISTINCT FROM OLD.wa_opened_at THEN NEW.wa_opened_at := pg_catalog.clock_timestamp(); END IF;
    IF NEW.status = 'recovered' AND OLD.status <> 'recovered'
       AND NOT EXISTS (SELECT 1 FROM public."order" o WHERE o.store_id = NEW.store_id AND o.cart_id = NEW.cart_id) THEN
      RAISE EXCEPTION 'a checkout session is recovered only by an order of its own cart' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (NEW.id, NEW.store_id, NEW.cart_id, NEW.public_id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.store_id, OLD.cart_id, OLD.public_id, OLD.created_at) THEN
    RAISE EXCEPTION 'checkout session identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'recovered' AND NEW.status <> 'recovered' THEN
    RAISE EXCEPTION 'a recovered checkout session is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'abandoned' AND OLD.status = 'active' THEN
    IF OLD.updated_at > pg_catalog.clock_timestamp() - interval '60 minutes' THEN
      RAISE EXCEPTION 'a checkout session is abandoned only after 60 idle minutes' USING ERRCODE = '23514';
    END IF;
    IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
      RAISE EXCEPTION 'the abandonment sweep does not count as buyer activity' USING ERRCODE = '23514';
    END IF;
    NEW.abandoned_at := COALESCE(OLD.abandoned_at, pg_catalog.clock_timestamp());
  ELSIF NEW.abandoned_at IS DISTINCT FROM OLD.abandoned_at THEN
    RAISE EXCEPTION 'the abandonment stamp is written once by the sweep and never moved' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'recovered' AND OLD.status <> 'recovered' THEN
    NEW.recovered_at := pg_catalog.clock_timestamp();
  ELSIF NEW.recovered_at IS DISTINCT FROM OLD.recovered_at THEN
    RAISE EXCEPTION 'the recovery stamp is written once with the recovery and never moved' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'abandoned' AND NEW.status = 'active' AND NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'only new buyer activity reopens an abandoned checkout session' USING ERRCODE = '23514';
  END IF;
  IF NEW.wa_opened_at IS DISTINCT FROM OLD.wa_opened_at AND NEW.status <> 'abandoned' THEN
    RAISE EXCEPTION 'WA dibuka is recorded only on an abandoned checkout session' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.checkout_session_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER checkout_session_guard BEFORE INSERT OR UPDATE ON public.checkout_session FOR EACH ROW EXECUTE FUNCTION public.checkout_session_guard();--> statement-breakpoint

-- ===== T-52 platform affiliate programme: isolation, grants, guards, resolver, click capture, projection triggers, retention (hand-written) =====
-- Three classes (isolation-registry.ts): seller opt-in tables keep the store policy; the affiliate's own records carry the own-affiliate policy on
-- app.affiliate_id; the catalog, the programme limits and the counters are platform / shared-read records. The app role holds NO INSERT on any
-- affiliate-class table that checkout or the click entry point writes: those writes are the SECURITY DEFINER functions below, which derive every id
-- they write from the database (the order, the link token, the committed financial snapshot) and re-check the caller's store context themselves.
-- Function bodies keep to the invariant test: pinned search_path, every relation schema-qualified, no dynamic SQL.

ALTER TABLE public.affiliate ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.affiliate FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY affiliate_isolation ON public.affiliate USING (id = public.app_affiliate_id()) WITH CHECK (id = public.app_affiliate_id());--> statement-breakpoint
ALTER TABLE public.affiliate_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.affiliate_link FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY affiliate_isolation ON public.affiliate_link USING (affiliate_id = public.app_affiliate_id()) WITH CHECK (affiliate_id = public.app_affiliate_id());--> statement-breakpoint
ALTER TABLE public.affiliate_code ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.affiliate_code FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY affiliate_isolation ON public.affiliate_code USING (affiliate_id = public.app_affiliate_id()) WITH CHECK (affiliate_id = public.app_affiliate_id());--> statement-breakpoint
ALTER TABLE public.affiliate_click ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.affiliate_click FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY affiliate_isolation ON public.affiliate_click USING (affiliate_id = public.app_affiliate_id()) WITH CHECK (affiliate_id = public.app_affiliate_id());--> statement-breakpoint
ALTER TABLE public.affiliate_attribution ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.affiliate_attribution FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY affiliate_isolation ON public.affiliate_attribution USING (affiliate_id = public.app_affiliate_id()) WITH CHECK (affiliate_id = public.app_affiliate_id());--> statement-breakpoint
ALTER TABLE public.affiliate_seller_policy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.affiliate_seller_policy FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.affiliate_seller_policy USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.affiliate_offer ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.affiliate_offer FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.affiliate_offer USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.affiliate_block ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.affiliate_block FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.affiliate_block USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint

-- Grants: exactly the registry. The affiliate's raw click log is not readable by the app role at all (PRIV-2: aggregates only), and its attribution
-- rows are readable without the order id, the click reference and the code reference (column grant): an affiliate-facing response cannot carry an order identifier.
REVOKE ALL ON public.affiliate, public.affiliate_link, public.affiliate_code, public.affiliate_click, public.affiliate_attribution, public.affiliate_catalog, public.affiliate_policy, public.affiliate_counter, public.affiliate_seller_policy, public.affiliate_offer, public.affiliate_block FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON public.affiliate TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.affiliate TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.affiliate_link, public.affiliate_code TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.affiliate_link, public.affiliate_code, public.affiliate_click, public.affiliate_attribution TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT (id, affiliate_id, store_id, source, method, window_days, hold_days, commission_base_idr, commission_idr, status, eligible_at, void_reason, created_at) ON public.affiliate_attribution TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.affiliate_catalog, public.affiliate_policy TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.affiliate_catalog TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON public.affiliate_policy, public.affiliate_counter TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.affiliate_seller_policy, public.affiliate_offer TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.affiliate_block TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.affiliate_seller_policy, public.affiliate_offer, public.affiliate_block TO bukalaris_platform;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE public.affiliate_link_id_seq, public.affiliate_code_id_seq, public.affiliate_offer_id_seq TO bukalaris_app;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE public.affiliate_id_seq TO bukalaris_platform;--> statement-breakpoint

-- Programme limits: one seeded row. The values are the NAMED placeholders of affiliate/settings.ts (a test pins them to this row); the window is
-- not an owner decision (ADR-0009 OPEN) and the rate bounds are not either. The hold of 3 days is the owner's decided default.
INSERT INTO public.affiliate_policy (id, min_rate_bps, max_rate_bps, attribution_window_days, hold_days, updated_by) VALUES (1, 100, 2000, 7, 3, 'system:migration') ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

-- JOB-27 retention: registered, no period row, so the purge deletes nothing until the privacy owner records one (PRIV-7). JOB-20 is a store-scoped kind.
INSERT INTO public.platform_job_kind (kind) VALUES ('retention.affiliate_click') ON CONFLICT (kind) DO NOTHING;--> statement-breakpoint
INSERT INTO public.retention_class (class, table_name, time_column, row_filter) VALUES ('affiliate_click', 'affiliate_click', 'captured_at', 'true') ON CONFLICT (class) DO NOTHING;--> statement-breakpoint

-- ── Counters ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.affiliate_bump(p_kind text, p_affiliate bigint) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO public.affiliate_counter (day, kind, affiliate_id, n) VALUES ((pg_catalog.now() AT TIME ZONE 'UTC')::date, p_kind, p_affiliate, 1)
  ON CONFLICT (day, kind, COALESCE(affiliate_id, 0)) DO UPDATE SET n = public.affiliate_counter.n + 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_bump(text, bigint) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint

-- A failed typed code has no affiliate: the one platform-wide counter. Callable by the checkout; it takes no argument, so nothing can be forged.
CREATE FUNCTION public.affiliate_count_code_failure() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT public.affiliate_bump('code_failure', NULL)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_count_code_failure() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.affiliate_count_code_failure() TO bukalaris_app;--> statement-breakpoint

-- ── Guards ──────────────────────────────────────────────────────────────────────────────────────────────────
-- Account state machine (ADR-0009 section 3). An account is registered pending; review moves it; closed is final; the identity never moves.
CREATE FUNCTION public.affiliate_status_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'an affiliate account starts pending' USING ERRCODE = 'check_violation'; END IF;
    NEW.revision := 1;
    RETURN NEW;
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'the affiliate identity is immutable' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('active', 'rejected'))
    OR (OLD.status = 'active' AND NEW.status IN ('suspended', 'closed'))
    OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'closed'))
    OR (OLD.status = 'rejected' AND NEW.status = 'pending')) THEN
    RAISE EXCEPTION 'illegal affiliate account transition % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_status_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_status_guard BEFORE INSERT OR UPDATE ON public.affiliate FOR EACH ROW EXECUTE FUNCTION public.affiliate_status_guard();--> statement-breakpoint

-- Links and codes: only an active account creates them; afterwards the only change is active to revoked. Suspension is not written here: it is derived from the account row.
CREATE FUNCTION public.affiliate_selector_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT a.status INTO v_status FROM public.affiliate a WHERE a.id = NEW.affiliate_id FOR SHARE;
    IF v_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'only an active affiliate account creates links and codes' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'affiliate_link' THEN
    IF NEW.id <> OLD.id OR NEW.affiliate_id <> OLD.affiliate_id OR NEW.token <> OLD.token OR NEW.store_id <> OLD.store_id OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
       OR NEW.source <> OLD.source OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'a link keeps its token and destination' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.affiliate_id <> OLD.affiliate_id OR NEW.code <> OLD.code OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'a code never changes' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'active' AND NEW.status = 'revoked') THEN RAISE EXCEPTION 'a revoked selector stays revoked' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_selector_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_selector_guard BEFORE INSERT OR UPDATE ON public.affiliate_link FOR EACH ROW EXECUTE FUNCTION public.affiliate_selector_guard();--> statement-breakpoint
CREATE TRIGGER affiliate_selector_guard BEFORE INSERT OR UPDATE ON public.affiliate_code FOR EACH ROW EXECUTE FUNCTION public.affiliate_selector_guard();--> statement-breakpoint

-- Offer state machine and the programme's rate bounds (a rate is validated when it is written or an offer becomes active again; pausing or withdrawing is never blocked).
CREATE FUNCTION public.affiliate_offer_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_pstatus text; v_min integer; v_max integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN RAISE EXCEPTION 'an offer starts active' USING ERRCODE = 'check_violation'; END IF;
    NEW.revision := 1;
  ELSE
    IF NEW.id <> OLD.id OR NEW.store_id <> OLD.store_id OR NEW.source <> OLD.source OR NEW.product_id <> OLD.product_id OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'the offer identity is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'active' AND NEW.status IN ('paused', 'withdrawn'))
      OR (OLD.status = 'paused' AND NEW.status IN ('active', 'withdrawn'))
      OR (OLD.status = 'withdrawn' AND NEW.status = 'active')) THEN
      RAISE EXCEPTION 'illegal offer transition % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.revision := OLD.revision + 1;
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active' OR NEW.rate_bps IS DISTINCT FROM OLD.rate_bps) THEN
    SELECT pr.status INTO v_pstatus FROM public.product pr WHERE pr.store_id = NEW.store_id AND pr.id = NEW.product_id;
    IF v_pstatus IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'only a published product can be offered' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.rate_bps IS NOT NULL THEN
      SELECT p.min_rate_bps, p.max_rate_bps INTO v_min, v_max FROM public.affiliate_policy p WHERE p.id = 1;
      IF NEW.rate_bps < v_min OR NEW.rate_bps > v_max THEN RAISE EXCEPTION 'commission rate % is outside the programme bounds', NEW.rate_bps USING ERRCODE = 'check_violation'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_offer_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_offer_guard BEFORE INSERT OR UPDATE ON public.affiliate_offer FOR EACH ROW EXECUTE FUNCTION public.affiliate_offer_guard();--> statement-breakpoint

CREATE FUNCTION public.affiliate_seller_policy_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_min integer; v_max integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.revision := 1;
  ELSE
    IF NEW.store_id <> OLD.store_id THEN RAISE EXCEPTION 'the store of a policy never changes' USING ERRCODE = 'check_violation'; END IF;
    NEW.revision := OLD.revision + 1;
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  IF NEW.default_rate_bps IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.default_rate_bps IS DISTINCT FROM OLD.default_rate_bps OR (NEW.participation = 'open' AND OLD.participation <> 'open')) THEN
    SELECT p.min_rate_bps, p.max_rate_bps INTO v_min, v_max FROM public.affiliate_policy p WHERE p.id = 1;
    IF NEW.default_rate_bps < v_min OR NEW.default_rate_bps > v_max THEN RAISE EXCEPTION 'commission rate % is outside the programme bounds', NEW.default_rate_bps USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_seller_policy_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_seller_policy_guard BEFORE INSERT OR UPDATE ON public.affiliate_seller_policy FOR EACH ROW EXECUTE FUNCTION public.affiliate_seller_policy_guard();--> statement-breakpoint

CREATE FUNCTION public.affiliate_policy_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_policy_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_policy_guard BEFORE UPDATE ON public.affiliate_policy FOR EACH ROW EXECUTE FUNCTION public.affiliate_policy_guard();--> statement-breakpoint

-- Catalog: the pair (offer revision, store policy revision) only grows, so a stale or replayed projection can never undo a newer withdrawal.
CREATE FUNCTION public.affiliate_catalog_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.source <> OLD.source OR NEW.offer_id <> OLD.offer_id OR NEW.store_id <> OLD.store_id OR NEW.product_id <> OLD.product_id THEN
    RAISE EXCEPTION 'a catalog row keeps its offer identity' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source_revision < OLD.source_revision OR (NEW.source_revision = OLD.source_revision AND NEW.seller_policy_revision <= OLD.seller_policy_revision) THEN
    RAISE EXCEPTION 'stale catalog revision % / % (current % / %)', NEW.source_revision, NEW.seller_policy_revision, OLD.source_revision, OLD.seller_policy_revision USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_catalog_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_catalog_guard BEFORE UPDATE ON public.affiliate_catalog FOR EACH ROW EXECUTE FUNCTION public.affiliate_catalog_guard();--> statement-breakpoint

-- Clicks are written once by affiliate_capture_click and never changed; the only deleters are the retention function and the owner-side demo reset.
CREATE FUNCTION public.affiliate_click_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (pg_catalog.current_setting('bukalaris.affiliate_retention', true) = 'on' OR pg_catalog.current_setting('bukalaris.affiliate_reset', true) = 'demo') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'an affiliate click is written once and only retired by the retention job' USING ERRCODE = 'insufficient_privilege';
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_click_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_click_guard BEFORE UPDATE OR DELETE ON public.affiliate_click FOR EACH ROW EXECUTE FUNCTION public.affiliate_click_guard();--> statement-breakpoint

-- Attribution: an insert must equal the committed financial snapshot (affiliate, commission, the sum of the bases of the lines that earn, one floor); afterwards only the T-53 state columns move
-- and the click reference may be detached by the retention job. Never deleted.
CREATE FUNCTION public.affiliate_attribution_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE f public.order_financials%ROWTYPE; v_lines integer; v_rated integer; v_base numeric; v_commission numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.affiliate_reset', true) = 'demo' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'an affiliate attribution is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.store_id <> OLD.store_id OR NEW.affiliate_id <> OLD.affiliate_id OR NEW.source <> OLD.source OR NEW.method <> OLD.method
       OR NEW.code_id IS DISTINCT FROM OLD.code_id OR NEW.window_days <> OLD.window_days OR NEW.hold_days <> OLD.hold_days OR NEW.policy_revision <> OLD.policy_revision
       OR NEW.seller_policy_revision <> OLD.seller_policy_revision OR NEW.commission_base_idr <> OLD.commission_base_idr OR NEW.commission_idr <> OLD.commission_idr OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'a frozen attribution is never rewritten' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.click_id IS DISTINCT FROM OLD.click_id THEN
      IF NEW.click_id IS NOT NULL OR OLD.click_id IS NULL OR NEW.click_detached_at IS NULL OR pg_catalog.current_setting('bukalaris.affiliate_retention', true) <> 'on' THEN
        RAISE EXCEPTION 'the click reference is only detached by the retention job' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.click_detached_at IS DISTINCT FROM OLD.click_detached_at THEN
      RAISE EXCEPTION 'the click reference is only detached by the retention job' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status <> OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('credited', 'void')) OR (OLD.status = 'credited' AND NEW.status = 'paid_out')) THEN
      RAISE EXCEPTION 'illegal attribution transition % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.eligible_at IS NOT NULL AND NEW.eligible_at IS DISTINCT FROM OLD.eligible_at THEN RAISE EXCEPTION 'eligible_at is set once' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.status = OLD.status AND (NEW.credit_ref IS DISTINCT FROM OLD.credit_ref OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
      RAISE EXCEPTION 'a reference changes only with its state' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'pending' OR NEW.eligible_at IS NOT NULL OR NEW.credit_ref IS NOT NULL OR NEW.void_reason IS NOT NULL THEN
    RAISE EXCEPTION 'an attribution starts pending' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO f FROM public.order_financials o WHERE o.store_id = NEW.store_id AND o.order_id = NEW.order_id;
  IF NOT FOUND OR f.affiliate_id IS DISTINCT FROM NEW.affiliate_id OR f.affiliate_commission_idr <> NEW.commission_idr THEN
    RAISE EXCEPTION 'the attribution must equal the frozen financial snapshot of its order' USING ERRCODE = 'check_violation';
  END IF;
  SELECT pg_catalog.count(*), pg_catalog.count(l.commission_rate_bps), pg_catalog.sum(l.commission_base_idr) FILTER (WHERE l.commission_rate_bps > 0), pg_catalog.floor(pg_catalog.sum(l.commission_base_idr::numeric * l.commission_rate_bps) / 10000)
    INTO v_lines, v_rated, v_base, v_commission
    FROM public.order_line_financials l WHERE l.store_id = NEW.store_id AND l.order_id = NEW.order_id;
  IF v_lines = 0 OR v_rated <> v_lines OR v_base IS DISTINCT FROM NEW.commission_base_idr::numeric OR v_commission IS DISTINCT FROM NEW.commission_idr::numeric THEN
    RAISE EXCEPTION 'the commission must be the single floor of the line bases at their frozen rates' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_attribution_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_attribution_guard BEFORE INSERT OR UPDATE OR DELETE ON public.affiliate_attribution FOR EACH ROW EXECUTE FUNCTION public.affiliate_attribution_guard();--> statement-breakpoint

-- The converse, checked at COMMIT: a snapshot that names an affiliate or carries a commission has exactly one attribution of the same affiliate and amount, with a rate on
-- every line; a snapshot without an affiliate has no rate, no commission and no attribution. An order cannot commit a deduction without its obligation.
CREATE FUNCTION public.affiliate_financial_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a public.affiliate_attribution%ROWTYPE; v_found boolean; v_lines integer; v_rated integer;
BEGIN
  SELECT pg_catalog.count(*), pg_catalog.count(l.commission_rate_bps) INTO v_lines, v_rated FROM public.order_line_financials l WHERE l.store_id = NEW.store_id AND l.order_id = NEW.order_id;
  SELECT * INTO a FROM public.affiliate_attribution t WHERE t.store_id = NEW.store_id AND t.order_id = NEW.order_id;
  v_found := FOUND;
  IF NEW.affiliate_id IS NULL THEN
    IF NEW.affiliate_commission_idr <> 0 OR v_found OR v_rated <> 0 THEN
      RAISE EXCEPTION 'order % carries affiliate evidence without an attributed affiliate', NEW.order_id USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NOT v_found OR a.affiliate_id <> NEW.affiliate_id OR a.commission_idr <> NEW.affiliate_commission_idr OR v_rated <> v_lines THEN
    RAISE EXCEPTION 'order % deducts a commission without its attribution', NEW.order_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_financial_check() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER affiliate_financial_check AFTER INSERT ON public.order_financials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.affiliate_financial_check();--> statement-breakpoint

-- ── Projection triggers (JOB-20): every write to an offer bumps its revision (guard above) and leaves one ID-only job; product, price, availability, image and
-- seller-policy changes touch the offers they affect, so no writer has to remember the projection. The job carries no state: the handler reads the live rows.
CREATE FUNCTION public.affiliate_offer_enqueue() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.job (kind, store_id, key, payload)
  VALUES ('affiliate.catalog.project', NEW.store_id, 'offer:' || NEW.id || ':' || NEW.revision, pg_catalog.jsonb_build_object('offerId', NEW.id, 'revision', NEW.revision))
  ON CONFLICT (kind, key) DO NOTHING;
  PERFORM pg_catalog.pg_notify('bukalaris_jobs', 'affiliate.catalog.project');
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_offer_enqueue() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_offer_enqueue AFTER INSERT OR UPDATE ON public.affiliate_offer FOR EACH ROW EXECUTE FUNCTION public.affiliate_offer_enqueue();--> statement-breakpoint

-- A store policy change leaves ONE store-wide job and touches no offer row: the handler reprojects every offer of the store with the new policy revision. (Updating the offers
-- from here would lock them after the policy row while a checkout holds an offer and wants the policy: a lock cycle between a seller save and an order.)
CREATE FUNCTION public.affiliate_seller_policy_enqueue() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.job (kind, store_id, key, payload)
  VALUES ('affiliate.catalog.project', NEW.store_id, 'policy:' || NEW.store_id || ':' || NEW.revision, pg_catalog.jsonb_build_object('revision', NEW.revision))
  ON CONFLICT (kind, key) DO NOTHING;
  PERFORM pg_catalog.pg_notify('bukalaris_jobs', 'affiliate.catalog.project');
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_seller_policy_enqueue() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_seller_policy_enqueue AFTER INSERT OR UPDATE ON public.affiliate_seller_policy FOR EACH ROW EXECUTE FUNCTION public.affiliate_seller_policy_enqueue();--> statement-breakpoint

CREATE FUNCTION public.affiliate_product_touch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_store bigint; v_product bigint;
BEGIN
  IF TG_TABLE_NAME = 'product' THEN
    v_store := NEW.store_id;
    v_product := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_store := OLD.store_id;
    v_product := OLD.product_id;
  ELSE
    v_store := NEW.store_id;
    v_product := NEW.product_id;
  END IF;
  UPDATE public.affiliate_offer o SET updated_by = o.updated_by WHERE o.store_id = v_store AND o.product_id = v_product;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_product_touch() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_product_touch AFTER UPDATE ON public.product FOR EACH ROW WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.slug IS DISTINCT FROM NEW.slug OR OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.affiliate_product_touch();--> statement-breakpoint
CREATE TRIGGER affiliate_variant_insert_touch AFTER INSERT ON public.variant FOR EACH ROW EXECUTE FUNCTION public.affiliate_product_touch();--> statement-breakpoint
CREATE TRIGGER affiliate_variant_touch AFTER UPDATE ON public.variant FOR EACH ROW WHEN (OLD.price IS DISTINCT FROM NEW.price OR (OLD.stock > 0) IS DISTINCT FROM (NEW.stock > 0)) EXECUTE FUNCTION public.affiliate_product_touch();--> statement-breakpoint
CREATE TRIGGER affiliate_media_touch AFTER INSERT OR UPDATE OR DELETE ON public.media FOR EACH ROW EXECUTE FUNCTION public.affiliate_product_touch();--> statement-breakpoint

-- ── Selection ───────────────────────────────────────────────────────────────────────────────────────────────
-- The single place that decides who an order is attributed to. Internal (no login role runs it): the two callers below check the store context first. A valid typed code
-- wins; otherwise the latest eligible click among the given ids (newest capture, then the larger id) of THIS store inside its own frozen window; a chosen affiliate whose
-- canonical phone is the buyer's earns nothing and nothing else is tried. Eligible means: account active, not blocked by this store, selector active. Window ends exclusive.
CREATE FUNCTION public.affiliate_resolve_core(p_store bigint, p_order bigint, p_code text, p_clicks text[])
RETURNS TABLE (r_affiliate_id bigint, r_method text, r_click_id text, r_code_id bigint, r_outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_phone text; v_aff bigint; v_aff_phone text; v_method text; v_click text; v_code bigint;
BEGIN
  SELECT public.buyer_canonical_phone(o.buyer_phone) INTO v_phone FROM public."order" o WHERE o.store_id = p_store AND o.id = p_order;
  IF NOT FOUND THEN RAISE EXCEPTION 'affiliate: order % of store % does not exist', p_order, p_store USING ERRCODE = 'no_data_found'; END IF;
  IF p_code IS NOT NULL THEN
    SELECT c.id, c.affiliate_id, a.contact_phone INTO v_code, v_aff, v_aff_phone
      FROM public.affiliate_code c JOIN public.affiliate a ON a.id = c.affiliate_id
     WHERE c.code = p_code AND c.status = 'active' AND (c.expires_at IS NULL OR pg_catalog.now() < c.expires_at) AND a.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM public.affiliate_block b WHERE b.store_id = p_store AND b.affiliate_id = a.id)
       FOR SHARE OF a;
    IF FOUND THEN v_method := 'code'; END IF;
  END IF;
  IF v_method IS NULL AND p_clicks IS NOT NULL AND pg_catalog.cardinality(p_clicks) > 0 THEN
    SELECT k.id, k.affiliate_id, a.contact_phone INTO v_click, v_aff, v_aff_phone
      FROM public.affiliate_click k
      JOIN public.affiliate_link l ON l.id = k.link_id AND l.affiliate_id = k.affiliate_id AND l.store_id = k.store_id
      JOIN public.affiliate a ON a.id = k.affiliate_id
     WHERE k.id = ANY (p_clicks[1:5]) AND k.store_id = p_store AND pg_catalog.now() < k.expires_at AND l.status = 'active' AND a.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM public.affiliate_block b WHERE b.store_id = p_store AND b.affiliate_id = a.id)
     ORDER BY k.captured_at DESC, k.id DESC
     LIMIT 1
       FOR SHARE OF a;
    IF FOUND THEN v_method := 'link'; END IF;
  END IF;
  IF v_method IS NULL THEN
    RETURN QUERY SELECT NULL::bigint, NULL::text, NULL::text, NULL::bigint, 'none'::text;
  -- Wave 5 review: fail closed. A buyer phone with no canonical Indonesian key (`+0812…`, `812…`) cannot be compared with the affiliate's, and a courier reads it as the
  -- same number: the commission is suppressed and counted, never earned on a guess.
  ELSIF v_phone IS NULL OR v_aff_phone = v_phone THEN
    RETURN QUERY SELECT v_aff, v_method, v_click, v_code, 'self_referral'::text;
  ELSE
    RETURN QUERY SELECT v_aff, v_method, v_click, v_code, 'selected'::text;
  END IF;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_resolve_core(bigint, bigint, text, text[]) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint

-- The checkout's resolution, inside the order transaction (the order row already exists, so the buyer's phone is read from it and never passed in). A self-referral
-- is counted for the risk queue and answered as "nothing earned".
CREATE FUNCTION public.affiliate_resolve(p_store bigint, p_order bigint, p_code text, p_clicks text[])
RETURNS TABLE (r_affiliate_id bigint, r_method text, r_click_id text, r_code_id bigint, r_outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record; v_code text := p_code;
BEGIN
  IF p_store IS NULL OR p_store IS DISTINCT FROM public.app_store_id() THEN RAISE EXCEPTION 'affiliate: the store does not match the transaction context' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF v_code IS NOT NULL AND v_code !~ '^[A-Z0-9]{4,24}$' THEN v_code := NULL; END IF;
  SELECT * INTO r FROM public.affiliate_resolve_core(p_store, p_order, v_code, p_clicks);
  IF r.r_outcome = 'self_referral' THEN
    PERFORM public.affiliate_bump('self_referral_suppressed', r.r_affiliate_id);
    RETURN QUERY SELECT NULL::bigint, NULL::text, NULL::text, NULL::bigint, 'self_referral'::text;
  ELSE
    RETURN QUERY SELECT r.r_affiliate_id, r.r_method, r.r_click_id, r.r_code_id, r.r_outcome;
  END IF;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_resolve(bigint, bigint, text, text[]) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.affiliate_resolve(bigint, bigint, text, text[]) TO bukalaris_app;--> statement-breakpoint

-- Whether a typed code is currently usable in this store (drives only the per-cart invalid-guess limit RL-CODE; the answer never reaches the buyer).
CREATE FUNCTION public.affiliate_code_valid(p_store bigint, p_code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_store IS NULL OR p_store IS DISTINCT FROM public.app_store_id() THEN RAISE EXCEPTION 'affiliate: the store does not match the transaction context' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_code IS NULL OR p_code !~ '^[A-Z0-9]{4,24}$' THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.affiliate_code c JOIN public.affiliate a ON a.id = c.affiliate_id
     WHERE c.code = p_code AND c.status = 'active' AND (c.expires_at IS NULL OR pg_catalog.now() < c.expires_at) AND a.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM public.affiliate_block b WHERE b.store_id = p_store AND b.affiliate_id = a.id));
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_code_valid(bigint, text) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.affiliate_code_valid(bigint, text) TO bukalaris_app;--> statement-breakpoint

-- The commission rate of one product in this store right now: the offer's override, else the store default, only while the store policy is open, the offer active, the
-- product published, the store active and the rate inside the programme bounds; otherwise 0. Share-locks the store policy, then the offer (the order every writer uses), so a seller edit waits for the order.
CREATE FUNCTION public.affiliate_line_rate(p_store bigint, p_product bigint) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_rate integer; v_min integer; v_max integer;
BEGIN
  IF p_store IS NULL OR p_store IS DISTINCT FROM public.app_store_id() THEN RAISE EXCEPTION 'affiliate: the store does not match the transaction context' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM 1 FROM public.affiliate_seller_policy s WHERE s.store_id = p_store FOR SHARE;
  SELECT COALESCE(o.rate_bps, s.default_rate_bps), g.min_rate_bps, g.max_rate_bps INTO v_rate, v_min, v_max
    FROM public.affiliate_offer o
    JOIN public.affiliate_seller_policy s ON s.store_id = o.store_id AND s.participation = 'open'
    JOIN public.product pr ON pr.store_id = o.store_id AND pr.id = o.product_id AND pr.status = 'active'
    JOIN public.store st ON st.id = o.store_id AND st.status = 'active'
    CROSS JOIN public.affiliate_policy g
   WHERE o.store_id = p_store AND o.source = 'bukalaris' AND o.product_id = p_product AND o.status = 'active'
     FOR SHARE OF o;
  IF NOT FOUND OR v_rate IS NULL OR v_rate < v_min OR v_rate > v_max THEN RETURN 0; END IF;
  RETURN v_rate;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_line_rate(bigint, bigint) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.affiliate_line_rate(bigint, bigint) TO bukalaris_app;--> statement-breakpoint

-- The only writer of an attribution. It re-runs the selection and re-derives every line rate from the live offer rules; the amounts come from the committed order snapshot
-- (the table guard re-proves the single floor). A caller cannot name the affiliate, the method, the click or the amounts.
CREATE FUNCTION public.affiliate_record_attribution(p_store bigint, p_order bigint, p_code text, p_clicks text[]) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record; f public.order_financials%ROWTYPE; v_code text := p_code; v_bad integer; v_base numeric; v_pol public.affiliate_policy%ROWTYPE; v_sp integer; v_id bigint;
BEGIN
  IF p_store IS NULL OR p_store IS DISTINCT FROM public.app_store_id() THEN RAISE EXCEPTION 'affiliate: the store does not match the transaction context' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF v_code IS NOT NULL AND v_code !~ '^[A-Z0-9]{4,24}$' THEN v_code := NULL; END IF;
  SELECT * INTO r FROM public.affiliate_resolve_core(p_store, p_order, v_code, p_clicks);
  IF r.r_outcome IS DISTINCT FROM 'selected' THEN RAISE EXCEPTION 'affiliate: no eligible selector for order %', p_order USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO f FROM public.order_financials o WHERE o.store_id = p_store AND o.order_id = p_order;
  IF NOT FOUND OR f.affiliate_id IS NULL OR f.affiliate_id <> r.r_affiliate_id OR f.affiliate_commission_idr <= 0 THEN
    RAISE EXCEPTION 'affiliate: the financial snapshot of order % does not carry this affiliate', p_order USING ERRCODE = 'check_violation';
  END IF;
  SELECT pg_catalog.count(*) INTO v_bad
    FROM public.order_line_financials l JOIN public.variant v ON v.store_id = l.store_id AND v.id = l.variant_id
   WHERE l.store_id = p_store AND l.order_id = p_order AND l.commission_rate_bps IS DISTINCT FROM public.affiliate_line_rate(p_store, v.product_id);
  IF v_bad > 0 THEN RAISE EXCEPTION 'affiliate: a line rate of order % does not match the live offer rules', p_order USING ERRCODE = 'check_violation'; END IF;
  SELECT pg_catalog.sum(l.commission_base_idr) FILTER (WHERE l.commission_rate_bps > 0) INTO v_base FROM public.order_line_financials l WHERE l.store_id = p_store AND l.order_id = p_order;
  SELECT * INTO v_pol FROM public.affiliate_policy g WHERE g.id = 1;
  SELECT s.revision INTO v_sp FROM public.affiliate_seller_policy s WHERE s.store_id = p_store;
  INSERT INTO public.affiliate_attribution (order_id, store_id, affiliate_id, method, code_id, click_id, window_days, hold_days, policy_revision, seller_policy_revision, commission_base_idr, commission_idr)
  VALUES (p_order, p_store, r.r_affiliate_id, r.r_method, r.r_code_id, r.r_click_id, v_pol.attribution_window_days, v_pol.hold_days, v_pol.revision, v_sp, v_base::bigint, f.affiliate_commission_idr)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_record_attribution(bigint, bigint, text, text[]) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.affiliate_record_attribution(bigint, bigint, text, text[]) TO bukalaris_app;--> statement-breakpoint

-- ── Click capture (HTTP-27, SEC-20) ──────────────────────────────────────────────────────────────────────────
-- One public entry point: the token is the only input. Unknown, revoked, expired, blocked and suspended all return no row. Mode `capture` records the click with the server clock and
-- the window of that moment; `refused_rate` and `non_navigation` record nothing but a counter and `redirect_only` not even that (no existence hint beyond the redirect the buyer gets either way).
CREATE FUNCTION public.affiliate_capture_click(p_token text, p_mode text) RETURNS TABLE (r_store_slug text, r_product_path text, r_click_id text, r_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE l record; v_now timestamptz; v_days integer; v_id text; v_expires timestamptz;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('capture', 'refused_rate', 'non_navigation', 'redirect_only') THEN RAISE EXCEPTION 'affiliate: unknown click mode' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{16,64}$' THEN RETURN; END IF;
  SELECT lk.id AS link_id, lk.affiliate_id, lk.store_id, lk.offer_id, s.slug AS store_slug, COALESCE(pr.slug, pr.catalog_id::text) AS product_path
    INTO l
    FROM public.affiliate_link lk
    JOIN public.affiliate a ON a.id = lk.affiliate_id
    JOIN public.store s ON s.id = lk.store_id
    LEFT JOIN public.affiliate_offer o ON o.store_id = lk.store_id AND o.id = lk.offer_id AND o.status = 'active'
    LEFT JOIN public.product pr ON pr.store_id = o.store_id AND pr.id = o.product_id AND pr.status = 'active'
   WHERE lk.token = p_token AND lk.status = 'active' AND (lk.expires_at IS NULL OR pg_catalog.now() < lk.expires_at) AND a.status = 'active' AND s.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM public.affiliate_block b WHERE b.store_id = lk.store_id AND b.affiliate_id = lk.affiliate_id);
  IF NOT FOUND THEN RETURN; END IF;
  IF p_mode = 'capture' THEN
    v_now := pg_catalog.clock_timestamp();
    SELECT g.attribution_window_days INTO v_days FROM public.affiliate_policy g WHERE g.id = 1;
    v_id := 'c' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
    v_expires := v_now + pg_catalog.make_interval(days => v_days);
    INSERT INTO public.affiliate_click (id, link_id, affiliate_id, store_id, offer_id, captured_at, expires_at)
    VALUES (v_id, l.link_id, l.affiliate_id, l.store_id, l.offer_id, v_now, v_expires);
    PERFORM public.affiliate_bump('click_captured', l.affiliate_id);
  ELSIF p_mode = 'refused_rate' THEN
    PERFORM public.affiliate_bump('click_refused_rate', l.affiliate_id);
  ELSIF p_mode = 'non_navigation' THEN
    PERFORM public.affiliate_bump('click_non_navigation', l.affiliate_id);
  END IF;
  RETURN QUERY SELECT l.store_slug, l.product_path, v_id, v_expires;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_capture_click(text, text) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.affiliate_capture_click(text, text) TO bukalaris_app;--> statement-breakpoint

-- ── Retention (JOB-27): OFF until a period row exists. Detaches the attribution evidence first (the click reference becomes NULL, the evidence stays), then removes the raw click. ──
CREATE FUNCTION public.retention_purge_affiliate_click(p_batch integer) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_days integer; v_id text; v_n bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname LIKE 'pg\_%') THEN
    RAISE EXCEPTION 'retention purge refused: a temporary relation shadows a system catalog' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN RAISE EXCEPTION 'retention purge: batch must be between 1 and 10000' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT rp.period_days INTO v_days FROM public.retention_policy rp WHERE rp.class = 'affiliate_click';
  IF NOT FOUND THEN RETURN 0; END IF;
  PERFORM pg_catalog.set_config('bukalaris.affiliate_retention', 'on', true);
  FOR v_id IN
    SELECT k.id FROM public.affiliate_click k WHERE k.captured_at < pg_catalog.now() - pg_catalog.make_interval(days => v_days) ORDER BY k.captured_at, k.id LIMIT p_batch FOR UPDATE OF k SKIP LOCKED
  LOOP
    UPDATE public.affiliate_attribution a SET click_id = NULL, click_detached_at = pg_catalog.now() WHERE a.click_id = v_id;
    DELETE FROM public.affiliate_click k WHERE k.id = v_id;
    v_n := v_n + 1;
  END LOOP;
  PERFORM pg_catalog.set_config('bukalaris.affiliate_retention', '', true);
  RETURN v_n;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retention_purge_affiliate_click(integer) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retention_purge_affiliate_click(integer) TO bukalaris_platform;--> statement-breakpoint

-- Local demo reset (packages/db/src/demo/seed-demo.ts): removes the affiliate rows of stores whose slug starts with 'demo-' and nothing else. Owner connection only.
CREATE FUNCTION public.reset_demo_affiliate(p_store_ids bigint[]) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_ids bigint[]; v_total bigint := 0; v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname LIKE 'pg\_%') THEN
    RAISE EXCEPTION 'reset refused: a temporary relation shadows a system catalog' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT pg_catalog.array_agg(s.id) INTO v_ids FROM public.store s WHERE s.id = ANY (p_store_ids) AND s.slug LIKE 'demo-%';
  IF v_ids IS NULL THEN RETURN 0; END IF;
  PERFORM pg_catalog.set_config('bukalaris.affiliate_reset', 'demo', true);
  DELETE FROM public.affiliate_attribution WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_click WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_link WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_catalog WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_block WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_offer WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_seller_policy WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  PERFORM pg_catalog.set_config('bukalaris.affiliate_reset', '', true);
  RETURN v_total;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reset_demo_affiliate(bigint[]) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint

-- ===== T-48 fix (review findings: platform shipping discount, margin approval revision, demo reset) =====
-- Hand-written: drizzle-kit models neither guards, views nor definer functions. The generated statements above are untouched. No new table and no new
-- function: three existing definer guards/functions are replaced IN PLACE (same names, pinned search_path, schema-qualified, no execute grant), so the
-- isolation registry keeps its entries. Existing rows: platform_shipping_discount_idr = 0 (the old behaviour: an earlier platform discount was never stored,
-- so no historical order is re-interpreted) and shipping_margin_rule.revision = 0.

-- 1. A booking carries exactly the platform discount frozen with the order financials (the immutable snapshot is the one source of truth), as it already
--    carries the store discount. Body identical to 0015 apart from the extra comparison.
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
      IF f.order_id IS NULL OR NEW.shipping_discount_idr <> f.shipping_discount_idr OR NEW.platform_shipping_discount_idr <> f.platform_shipping_discount_idr THEN
        RAISE EXCEPTION 'booking discounts equal frozen financial discounts' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 2. The platform's money position: the margin class is the platform's NET shipping margin. The shipment cost stores the GROSS margin (what the collected
--    amount left after the courier, before the platform-funded discount); the discount the platform paid out of it is subtracted here. Without a discount
--    nothing changes; with one, a courier price rise beyond the margin shows as a platform loss (negative), never as a seller debit.
CREATE OR REPLACE VIEW "platform_money_position" WITH (security_invoker = true) AS
SELECT 'seller_pending'::text AS class, COALESCE(sum(amount_idr), 0)::bigint AS amount_idr FROM public.ledger_entry WHERE status = 'pending'
UNION ALL SELECT 'seller_available', COALESCE(sum(amount_idr), 0)::bigint FROM public.ledger_entry WHERE status = 'available'
UNION ALL SELECT 'payouts_requested', COALESCE(sum(amount_idr), 0)::bigint FROM public.payout WHERE status = 'requested'
UNION ALL SELECT 'payouts_processing', COALESCE(sum(amount_idr), 0)::bigint FROM public.payout WHERE status = 'processing'
UNION ALL SELECT 'refunds_open', COALESCE(sum(amount_idr), 0)::bigint FROM public.refund WHERE status IN ('pending', 'processing')
UNION ALL SELECT 'platform_shipping_margin', COALESCE(sum(platform_shipping_margin_idr - platform_shipping_discount_idr), 0)::bigint FROM public.shipment_cost
UNION ALL SELECT 'platform_shipping_cashback', COALESCE(sum(platform_cashback_idr), 0)::bigint FROM public.order_financials
UNION ALL SELECT 'platform_cod_fee', COALESCE(sum(cod_fee_idr), 0)::bigint FROM public.order_financials
UNION ALL SELECT 'platform_cod_fee_vat', COALESCE(sum(cod_fee_vat_idr), 0)::bigint FROM public.order_financials
UNION ALL SELECT 'platform_payment_fee_margin', COALESCE(sum(admin_fee_idr - provider_fee_idr), 0)::bigint FROM public.payment_attempt WHERE status = 'paid' AND provider_fee_idr IS NOT NULL
UNION ALL SELECT 'refunds_failed', COALESCE(sum(r.amount_idr), 0)::bigint FROM public.refund r WHERE r.status = 'failed' AND NOT EXISTS (SELECT 1 FROM public.refund n WHERE n.store_id = r.store_id AND n.order_id = r.order_id AND n.status <> 'failed');--> statement-breakpoint

-- 3. A margin approval is bound to the rule revision it was requested against (`revision` joins the approved payload, like the discount/routing settings):
--    an approved but unapplied margin can no longer overwrite a later approved one. A new row starts at revision 1 (payload revision 0).
CREATE OR REPLACE FUNCTION public.shipping_policy_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p jsonb; target text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'shipping policy is retained' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF TG_TABLE_NAME = 'shipping_control' THEN
    p := jsonb_build_object('revision', OLD.revision, 'preferPartner', NEW.prefer_partner, 'discountIdr', NEW.discount_idr, 'discountBps', NEW.discount_bps); target := 'shipping_policy';
    IF NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'stale shipping settings' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    p := jsonb_build_object('revision', COALESCE(OLD.revision, 0), 'fixedIdr', NEW.fixed_idr, 'percentBps', NEW.percent_bps, 'roundTo', NEW.round_to); target := 'shipping_margin_rule';
    IF NEW.revision <> COALESCE(OLD.revision, 0) + 1 THEN RAISE EXCEPTION 'stale shipping margin approval' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF NOT public.approval_binds(NEW.approval_request_id, 'shipping.margin', target, 'default', p)
     OR NOT EXISTS (SELECT 1 FROM public.approval_request ar WHERE ar.id = NEW.approval_request_id AND ar.requested_by = NEW.updated_by AND ar.status = 'executed' AND ar.executed_at = now()) THEN
    RAISE EXCEPTION 'shipping pricing requires the executed approval of this exact change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 4. Local demo reset: a demo store whose account is referenced by a reconciliation batch (batches are never deleted) or by a surviving order used to end
--    in an anonymous foreign-key error halfway through the reset. It now refuses up front, naming the reason, before anything is deleted.
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
  PERFORM pg_catalog.set_config('bukalaris.shipping_reset', 'demo', true);
  DELETE FROM public.store_shipping_account WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
