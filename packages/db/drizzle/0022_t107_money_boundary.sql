CREATE TABLE "order_seller_refund" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_seller_refund_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"amount_idr" bigint NOT NULL,
	"refunded_on" date NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"reason" text NOT NULL,
	"recorded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_seller_refund_chk" CHECK ("order_seller_refund"."amount_idr" > 0 and "order_seller_refund"."method" in ('bank_transfer', 'autolaris', 'cash', 'other') and length("order_seller_refund"."reason") between 5 and 500 and ("order_seller_refund"."reference" is null or length("order_seller_refund"."reference") between 1 and 120))
);
--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN "money_mode" text DEFAULT 'platform_held' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN "payment_fee_bearer" text;--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN "cod_fee_bearer" text;--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN "expected_cod_fee_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN "buyer_fee_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN "fee_rate_version" integer;--> statement-breakpoint
ALTER TABLE "order_seller_refund" ADD CONSTRAINT "order_seller_refund_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_seller_refund_order_idx" ON "order_seller_refund" USING btree ("store_id","order_id");--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_money_mode_chk" CHECK ("order_financials"."expected_cod_fee_idr" >= 0 and "order_financials"."buyer_fee_idr" >= 0 and ("order_financials"."payment_fee_bearer" is null or "order_financials"."payment_fee_bearer" in ('buyer', 'seller')) and ("order_financials"."cod_fee_bearer" is null or "order_financials"."cod_fee_bearer" in ('buyer', 'seller')) and (
        ("order_financials"."money_mode" = 'platform_held' and "order_financials"."payment_fee_bearer" is null and "order_financials"."cod_fee_bearer" is null and "order_financials"."expected_cod_fee_idr" = 0 and "order_financials"."buyer_fee_idr" = 0 and "order_financials"."fee_rate_version" is null)
        or ("order_financials"."money_mode" = 'seller_owned' and "order_financials"."payment_fee_bearer" is not null and "order_financials"."cod_fee_bearer" is not null and "order_financials"."fee_rate_version" is not null
          and "order_financials"."platform_shipping_discount_idr" = 0 and "order_financials"."shipping_cashback_gross_idr" = 0 and "order_financials"."platform_cashback_idr" = 0 and "order_financials"."seller_cashback_idr" = 0
          and "order_financials"."affiliate_id" is null and "order_financials"."affiliate_commission_idr" = 0 and "order_financials"."cod_fee_idr" = 0 and "order_financials"."cod_fee_vat_idr" = 0
          and ("order_financials"."expected_cod_fee_idr" = 0 or "order_financials"."expected_gateway_fee_idr" = 0)
          and "order_financials"."buyer_fee_idr" = (case when "order_financials"."cod_fee_bearer" = 'buyer' then "order_financials"."expected_cod_fee_idr" else 0 end) + (case when "order_financials"."payment_fee_bearer" = 'buyer' then "order_financials"."expected_gateway_fee_idr" else 0 end))));--> statement-breakpoint

-- ===== T-107 money boundary for stores on seller-owned accounts (ADR-0013 sections 5 and 8, BILL-4, BILL-5, D-27, D-31, D-32 C-P7/C-P9) ===========
-- Hand-written; everything of T-107 that drizzle-kit does not generate sits in this one section. Order: the rule, the guards, the new table's grants and
-- guards, the money view, seeds, the backfill of existing snapshots, retention and the demo reset.
--
-- The rule (one definition, used by every guard below and mirrored by `storeMoneyMode` in ledger/boundary.ts): a store is `seller_owned` when it holds
-- a seller-owned account of either provider (a `store_shipping_account` of kind `seller_owned` or a `store_payment_account`). Its orders freeze that
-- mode in `order_financials.money_mode`. Money of a `seller_owned` store or order never enters the platform's books: no ledger entry, payout,
-- payout destination, reconciliation item, shipment cost reservation, platform refund, late-payment obligation or platform-account payment attempt.
-- The ADR-0006 invariants stay untouched for `platform_held` money. Every boundary refusal raises the dedicated SQLSTATE `BKMB1` (message prefix
-- `money_boundary:`), so a caller never confuses it with another check; the cut-over refusal of section 1a raises `BKMB2`.

-- 1. The rule. Owner-only (definer, no EXECUTE for a login role): the guards call it; the services ask the same question with their own query.
CREATE FUNCTION public.store_money_mode(p_store_id bigint) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.store_shipping_account a WHERE a.store_id = p_store_id AND a.kind = 'seller_owned')
                OR EXISTS (SELECT 1 FROM public.store_payment_account p WHERE p.store_id = p_store_id)
              THEN 'seller_owned' ELSE 'platform_held' END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.store_money_mode(bigint) FROM PUBLIC;--> statement-breakpoint

-- 1a. Clean cut-over (review M2): a store becomes `seller_owned` only with no platform money in flight, so no platform money row of it can ever be
--     needed afterwards (no balance to pay out or adjust, no payout to reject, no refund to settle, no order still able to book a sale). The first
--     seller-owned account row of a store is refused while the store has a non-zero pending or available ledger balance, a payout requested or
--     processing, a refund pending, processing or failed (still owed), or an order that is not completed, cancelled or returned. The reason is the
--     message suffix; the services show it to the seller.
CREATE FUNCTION public.money_cutover_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_reason text;
BEGIN
  IF TG_TABLE_NAME = 'store_shipping_account' THEN
    IF NEW.kind <> 'seller_owned' THEN RETURN NEW; END IF;
  END IF;
  IF public.store_money_mode(NEW.store_id) = 'seller_owned' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_entry e WHERE e.store_id = NEW.store_id GROUP BY e.status HAVING sum(e.amount_idr) <> 0) THEN
    v_reason := 'balance';
  ELSIF EXISTS (SELECT 1 FROM public.payout p WHERE p.store_id = NEW.store_id AND p.status IN ('requested', 'processing')) THEN
    v_reason := 'payout';
  ELSIF EXISTS (SELECT 1 FROM public.refund r WHERE r.store_id = NEW.store_id AND (r.status IN ('pending', 'processing')
           OR (r.status = 'failed' AND NOT EXISTS (SELECT 1 FROM public.refund n WHERE n.store_id = r.store_id AND n.order_id = r.order_id AND n.status <> 'failed')))) THEN
    v_reason := 'refund';
  ELSIF EXISTS (SELECT 1 FROM public."order" o WHERE o.store_id = NEW.store_id AND o.status NOT IN ('completed', 'cancelled', 'returned')) THEN
    v_reason := 'order';
  END IF;
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'money_cutover: store % still has platform money in flight: %', NEW.store_id, v_reason USING ERRCODE = 'BKMB2';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.money_cutover_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER a_money_cutover_guard BEFORE INSERT ON public.store_shipping_account FOR EACH ROW EXECUTE FUNCTION public.money_cutover_guard();--> statement-breakpoint
CREATE TRIGGER a_money_cutover_guard BEFORE INSERT ON public.store_payment_account FOR EACH ROW EXECUTE FUNCTION public.money_cutover_guard();--> statement-breakpoint

-- 2. The boundary guard: refused by rule, not by missing data. Store-level for rows without an order (payout, destination, adjustment) and for a
--    platform-account payment attempt of an order; order-level (the frozen mode) for every order-linked row, so a platform-held order keeps the
--    ADR-0006 behaviour and a seller-owned order never gets platform money rows.
CREATE FUNCTION public.money_boundary_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME IN ('payout', 'payout_destination') THEN
    IF public.store_money_mode(NEW.store_id) = 'seller_owned' THEN
      RAISE EXCEPTION 'money_boundary: % refused, store % is on seller-owned accounts', TG_TABLE_NAME, NEW.store_id USING ERRCODE = 'BKMB1';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'payment_attempt' THEN
    IF NEW.payment_account_id IS NULL AND NEW.owner_kind = 'order' AND public.store_money_mode(NEW.store_id) = 'seller_owned' THEN
      RAISE EXCEPTION 'money_boundary: an order of store % is never paid to the platform account', NEW.store_id USING ERRCODE = 'BKMB1';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'ledger_entry' THEN
    IF NEW.order_id IS NULL THEN
      IF public.store_money_mode(NEW.store_id) = 'seller_owned' THEN
        RAISE EXCEPTION 'money_boundary: ledger_entry refused, store % is on seller-owned accounts', NEW.store_id USING ERRCODE = 'BKMB1';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_financials f WHERE f.store_id = NEW.store_id AND f.order_id = NEW.order_id AND f.money_mode = 'seller_owned') THEN
    RAISE EXCEPTION 'money_boundary: % refused, order % is paid to the seller''s own accounts', TG_TABLE_NAME, NEW.order_id USING ERRCODE = 'BKMB1';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.money_boundary_guard() FROM PUBLIC;--> statement-breakpoint
-- Named `a_…` so it fires first among the BEFORE INSERT triggers of each table (alphabetical order): the refusal is the boundary's own, by rule.
CREATE TRIGGER a_money_boundary_guard BEFORE INSERT ON public.ledger_entry FOR EACH ROW EXECUTE FUNCTION public.money_boundary_guard();--> statement-breakpoint
CREATE TRIGGER a_money_boundary_guard BEFORE INSERT ON public.payout FOR EACH ROW EXECUTE FUNCTION public.money_boundary_guard();--> statement-breakpoint
CREATE TRIGGER a_money_boundary_guard BEFORE INSERT ON public.payout_destination FOR EACH ROW EXECUTE FUNCTION public.money_boundary_guard();--> statement-breakpoint
CREATE TRIGGER a_money_boundary_guard BEFORE INSERT ON public.refund FOR EACH ROW EXECUTE FUNCTION public.money_boundary_guard();--> statement-breakpoint
CREATE TRIGGER a_money_boundary_guard BEFORE INSERT ON public.reconciliation_batch_item FOR EACH ROW EXECUTE FUNCTION public.money_boundary_guard();--> statement-breakpoint
CREATE TRIGGER a_money_boundary_guard BEFORE INSERT ON public.shipment_cost FOR EACH ROW EXECUTE FUNCTION public.money_boundary_guard();--> statement-breakpoint
CREATE TRIGGER a_money_boundary_guard BEFORE INSERT ON public.late_payment_obligation FOR EACH ROW EXECUTE FUNCTION public.money_boundary_guard();--> statement-breakpoint
CREATE TRIGGER a_money_boundary_guard BEFORE INSERT ON public.payment_attempt FOR EACH ROW EXECUTE FUNCTION public.money_boundary_guard();--> statement-breakpoint

-- 3. The frozen snapshot of a new order: its mode is the store's mode at submit; a seller-owned order carries no platform shipping margin, the
--    store's two fee bearers of that moment, and the one fee of its method (gateway for prepaid, COD for COD). The CHECK on the table holds the rest.
CREATE FUNCTION public.order_financials_money_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  o public."order"%ROWTYPE;
  v_cod text := 'buyer';
  v_pay text := 'buyer';
BEGIN
  IF NEW.money_mode IS DISTINCT FROM public.store_money_mode(NEW.store_id) THEN
    RAISE EXCEPTION 'money_boundary: the frozen money mode is the store''s mode at submit' USING ERRCODE = 'BKMB1';
  END IF;
  IF NEW.money_mode = 'seller_owned' THEN
    SELECT * INTO o FROM public."order" WHERE store_id = NEW.store_id AND id = NEW.order_id;
    IF NOT FOUND OR o.shipping_margin <> 0 THEN
      RAISE EXCEPTION 'money_boundary: a seller-owned order carries no platform shipping margin' USING ERRCODE = 'BKMB1';
    END IF;
    IF (o.payment_method = 'cod' AND NEW.expected_gateway_fee_idr <> 0) OR (o.payment_method <> 'cod' AND NEW.expected_cod_fee_idr <> 0) THEN
      RAISE EXCEPTION 'money_boundary: an order carries only the fee of its own payment method' USING ERRCODE = 'BKMB1';
    END IF;
    SELECT s.cod_fee_bearer INTO v_cod FROM public.store_shipping_setting s WHERE s.store_id = NEW.store_id;
    IF NOT FOUND THEN v_cod := 'buyer'; END IF;
    SELECT p.fee_bearer INTO v_pay FROM public.store_payment_account p WHERE p.store_id = NEW.store_id;
    IF NOT FOUND THEN v_pay := 'buyer'; END IF;
    IF (NEW.cod_fee_bearer = v_cod) IS NOT TRUE OR (NEW.payment_fee_bearer = v_pay) IS NOT TRUE THEN
      RAISE EXCEPTION 'money_boundary: the frozen fee bearers are the store''s settings at submit' USING ERRCODE = 'BKMB1';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.order_financials_money_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER order_financials_money_guard BEFORE INSERT ON public.order_financials FOR EACH ROW EXECUTE FUNCTION public.order_financials_money_guard();--> statement-breakpoint

-- 4. order_seller_refund (decision 26, C-P9): store-owned, FORCE RLS, append-only. The seller records; nobody moves money.
REVOKE ALL ON public.order_seller_refund FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
ALTER TABLE public.order_seller_refund ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.order_seller_refund FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.order_seller_refund USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT ON public.order_seller_refund TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.order_seller_refund TO bukalaris_platform;--> statement-breakpoint
DROP TRIGGER IF EXISTS order_seller_refund_append_only ON public.order_seller_refund;--> statement-breakpoint
CREATE TRIGGER order_seller_refund_append_only BEFORE UPDATE OR DELETE ON public.order_seller_refund FOR EACH ROW EXECUTE FUNCTION public.payment_evidence_guard();--> statement-breakpoint
-- A refund is recorded only on a seller-owned order that was paid, and the recorded refunds of one order never exceed the buyer's bill
-- (`payable + buyer_fee`). Serialised per order, so two concurrent records cannot both pass the sum.
CREATE FUNCTION public.order_seller_refund_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_bill bigint;
  v_done bigint;
BEGIN
  SELECT f.payable_idr + f.buyer_fee_idr INTO v_bill FROM public.order_financials f WHERE f.store_id = NEW.store_id AND f.order_id = NEW.order_id AND f.money_mode = 'seller_owned';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'money_boundary: a seller refund is recorded only on an order paid to the store''s own accounts' USING ERRCODE = 'BKMB1';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."order" o WHERE o.store_id = NEW.store_id AND o.id = NEW.order_id AND o.paid_at IS NOT NULL) THEN
    RAISE EXCEPTION 'money_boundary: a refund is recorded only on a paid order' USING ERRCODE = 'BKMB1';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('order_seller_refund:' || NEW.store_id || ':' || NEW.order_id, 0));
  SELECT sum(r.amount_idr) INTO v_done FROM public.order_seller_refund r WHERE r.store_id = NEW.store_id AND r.order_id = NEW.order_id;
  IF v_done IS NULL THEN v_done := 0; END IF;
  IF v_done + NEW.amount_idr > v_bill THEN
    RAISE EXCEPTION 'money_boundary: recorded refunds never exceed the buyer''s bill' USING ERRCODE = 'BKMB1';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.order_seller_refund_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER order_seller_refund_guard BEFORE INSERT ON public.order_seller_refund FOR EACH ROW EXECUTE FUNCTION public.order_seller_refund_guard();--> statement-breakpoint

-- 5. The Owner console money position lists only platform-held money: the order snapshot classes count platform-held orders only and the payment
--    fee margin counts platform-account attempts only (the ledger, payout, refund and shipment-cost classes cannot hold a seller-owned row, guard 2).
CREATE OR REPLACE VIEW "platform_money_position" WITH (security_invoker = true) AS
SELECT 'seller_pending'::text AS class, COALESCE(sum(amount_idr), 0)::bigint AS amount_idr FROM public.ledger_entry WHERE status = 'pending'
UNION ALL SELECT 'seller_available', COALESCE(sum(amount_idr), 0)::bigint FROM public.ledger_entry WHERE status = 'available'
UNION ALL SELECT 'payouts_requested', COALESCE(sum(amount_idr), 0)::bigint FROM public.payout WHERE status = 'requested'
UNION ALL SELECT 'payouts_processing', COALESCE(sum(amount_idr), 0)::bigint FROM public.payout WHERE status = 'processing'
UNION ALL SELECT 'refunds_open', COALESCE(sum(amount_idr), 0)::bigint FROM public.refund WHERE status IN ('pending', 'processing')
UNION ALL SELECT 'platform_shipping_margin', COALESCE(sum(platform_shipping_margin_idr - platform_shipping_discount_idr), 0)::bigint FROM public.shipment_cost
UNION ALL SELECT 'platform_shipping_cashback', COALESCE(sum(platform_cashback_idr), 0)::bigint FROM public.order_financials WHERE money_mode = 'platform_held'
UNION ALL SELECT 'platform_cod_fee', COALESCE(sum(cod_fee_idr), 0)::bigint FROM public.order_financials WHERE money_mode = 'platform_held'
UNION ALL SELECT 'platform_cod_fee_vat', COALESCE(sum(cod_fee_vat_idr), 0)::bigint FROM public.order_financials WHERE money_mode = 'platform_held'
UNION ALL SELECT 'platform_payment_fee_margin', COALESCE(sum(admin_fee_idr - provider_fee_idr), 0)::bigint FROM public.payment_attempt WHERE status = 'paid' AND provider_fee_idr IS NOT NULL AND payment_account_id IS NULL
UNION ALL SELECT 'refunds_failed', COALESCE(sum(r.amount_idr), 0)::bigint FROM public.refund r WHERE r.status = 'failed' AND NOT EXISTS (SELECT 1 FROM public.refund n WHERE n.store_id = r.store_id AND n.order_id = r.order_id AND n.status <> 'failed');--> statement-breakpoint

-- 6. The provider COD fee is a versioned platform setting beside the payment channel fees (decision 19): channel code `COD`, base = the order total
--    before the fee (goods after discount plus shipping). 3% of that base is the reference system's starting value, UNVERIFIED with Mengantar (no
--    minimum and no VAT modelled: C-P7, Bukalaris books no VAT of its own). Added to every existing version so the schedule in force always prices
--    COD; a later version is published with the Owner console service, which copies every row forward.
INSERT INTO public.payment_fee_rate (version, channel_code, base, rate_bps, fixed_idr, created_by, reason)
SELECT DISTINCT r.version, 'COD', 'payable', 300, 0, 'migration:T-107', 'COD fee starting value from the reference system; UNVERIFIED with Mengantar (ADR-0013 decision 19)'
  FROM public.payment_fee_rate r
 WHERE NOT EXISTS (SELECT 1 FROM public.payment_fee_rate c WHERE c.version = r.version AND c.channel_code = 'COD');--> statement-breakpoint

-- 7. Backfill (review nit: a backfilled COD order was charged no COD fee, so `expected_cod_fee_idr` and `buyer_fee_idr` stay 0; its `fee_rate_version`
--    names the schedule in force when the order was frozen, version 1, the only version before this migration): a snapshot frozen before this migration whose money provably went to the seller's own account (a paid or pending attempt on the store's
--    own AutoLaris account, or COD on the store's own Mengantar account) and that never reached the platform books (no ledger, refund, reconciliation
--    or shipment-cost row, no affiliate or cashback figure) becomes `seller_owned`, with the store's bearers and the fee its attempt froze. Everything
--    else keeps `platform_held`, which is how the code of the time treated it. The snapshot is immutable, so its guard is off for this one statement.
ALTER TABLE public.order_financials DISABLE TRIGGER order_financials_guard;--> statement-breakpoint
UPDATE public.order_financials f
   SET money_mode = 'seller_owned',
       payment_fee_bearer = COALESCE((SELECT a.fee_bearer FROM public.payment_attempt a WHERE a.store_id = f.store_id AND a.order_id = f.order_id ORDER BY a.attempt_no LIMIT 1), (SELECT p.fee_bearer FROM public.store_payment_account p WHERE p.store_id = f.store_id), 'buyer'),
       cod_fee_bearer = COALESCE((SELECT s.cod_fee_bearer FROM public.store_shipping_setting s WHERE s.store_id = f.store_id), 'buyer'),
       fee_rate_version = COALESCE((SELECT a.fee_rate_version FROM public.payment_attempt a WHERE a.store_id = f.store_id AND a.order_id = f.order_id ORDER BY a.attempt_no LIMIT 1), 1),
       buyer_fee_idr = CASE WHEN COALESCE((SELECT a.fee_bearer FROM public.payment_attempt a WHERE a.store_id = f.store_id AND a.order_id = f.order_id ORDER BY a.attempt_no LIMIT 1), (SELECT p.fee_bearer FROM public.store_payment_account p WHERE p.store_id = f.store_id), 'buyer') = 'buyer' THEN f.expected_gateway_fee_idr ELSE 0 END
  FROM public."order" o
 WHERE o.store_id = f.store_id AND o.id = f.order_id
   AND f.money_mode = 'platform_held'
   AND ((o.payment_method = 'cod' AND o.shipping_account_kind = 'seller_owned')
        OR (o.payment_method <> 'cod' AND EXISTS (SELECT 1 FROM public.payment_attempt a WHERE a.store_id = f.store_id AND a.order_id = f.order_id AND a.payment_account_id IS NOT NULL)))
   AND o.shipping_margin = 0 AND f.platform_shipping_discount_idr = 0 AND f.shipping_cashback_gross_idr = 0 AND f.platform_cashback_idr = 0 AND f.seller_cashback_idr = 0
   AND f.affiliate_id IS NULL AND f.affiliate_commission_idr = 0 AND f.cod_fee_idr = 0 AND f.cod_fee_vat_idr = 0
   AND NOT EXISTS (SELECT 1 FROM public.ledger_entry e WHERE e.store_id = f.store_id AND e.order_id = f.order_id)
   AND NOT EXISTS (SELECT 1 FROM public.refund r WHERE r.store_id = f.store_id AND r.order_id = f.order_id)
   AND NOT EXISTS (SELECT 1 FROM public.reconciliation_batch_item i WHERE i.store_id = f.store_id AND i.order_id = f.order_id)
   AND NOT EXISTS (SELECT 1 FROM public.shipment_cost c WHERE c.store_id = f.store_id AND c.order_id = f.order_id)
   AND NOT EXISTS (SELECT 1 FROM public.late_payment_obligation l WHERE l.store_id = f.store_id AND l.order_id = f.order_id);--> statement-breakpoint
ALTER TABLE public.order_financials ENABLE TRIGGER order_financials_guard;--> statement-breakpoint

-- 8. Retention (C-P10, T-74 framework): a recorded seller refund is a financial record kept with the order; the generic purge never deletes it.
INSERT INTO public.retention_class (class, table_name, time_column, row_filter) VALUES ('order_seller_refund', 'order_seller_refund', 'created_at', 'false')
ON CONFLICT (class) DO NOTHING;--> statement-breakpoint

-- 9. Local demo reset: the demo stores' recorded refunds go with their payment evidence (same owner-only function, one DELETE added first).
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
  DELETE FROM public.order_seller_refund WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
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
