CREATE TABLE "affiliate_commission" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "affiliate_commission_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"affiliate_id" bigint NOT NULL,
	"commission_base_idr" bigint NOT NULL,
	"commission_idr" bigint NOT NULL,
	"hold_days" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"payable_at" timestamp with time zone,
	"void_reason" text,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_commission_order_uq" UNIQUE("order_id"),
	CONSTRAINT "affiliate_commission_amounts_chk" CHECK ("affiliate_commission"."commission_idr" > 0 and "affiliate_commission"."commission_base_idr" >= "affiliate_commission"."commission_idr" and "affiliate_commission"."hold_days" >= 0),
	CONSTRAINT "affiliate_commission_status_chk" CHECK ("affiliate_commission"."status" in ('pending', 'void', 'payable', 'paid', 'confirmed', 'disputed') and ("affiliate_commission"."delivered_at" is null) = ("affiliate_commission"."payable_at" is null) and ("affiliate_commission"."status" in ('pending', 'void') or "affiliate_commission"."delivered_at" is not null) and (("affiliate_commission"."status" = 'void') = ("affiliate_commission"."void_reason" is not null and "affiliate_commission"."voided_at" is not null)))
);
--> statement-breakpoint
CREATE TABLE "affiliate_membership" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "affiliate_membership_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"affiliate_id" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"display_name" text NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"application_note" text,
	"status_reason" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_membership_store_affiliate_uq" UNIQUE("store_id","affiliate_id"),
	CONSTRAINT "affiliate_membership_status_chk" CHECK ("affiliate_membership"."status" in ('pending', 'active', 'rejected', 'suspended') and ("affiliate_membership"."status" = 'pending' or "affiliate_membership"."reviewed_at" is not null)),
	CONSTRAINT "affiliate_membership_reason_chk" CHECK ("affiliate_membership"."status" not in ('rejected', 'suspended') or char_length(btrim(coalesce("affiliate_membership"."status_reason", ''))) between 1 and 300),
	CONSTRAINT "affiliate_membership_application_chk" CHECK (char_length(btrim("affiliate_membership"."display_name")) between 2 and 80 and cardinality("affiliate_membership"."channels") <= 5 and ("affiliate_membership"."application_note" is null or char_length("affiliate_membership"."application_note") <= 500))
);
--> statement-breakpoint
ALTER TABLE "affiliate" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "affiliate_seller_policy" ADD COLUMN "auto_approve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "affiliate_commission" ADD CONSTRAINT "affiliate_commission_affiliate_id_affiliate_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commission" ADD CONSTRAINT "affiliate_commission_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order_financials"("store_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commission" ADD CONSTRAINT "affiliate_commission_attribution_fk" FOREIGN KEY ("order_id") REFERENCES "public"."affiliate_attribution"("order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_membership" ADD CONSTRAINT "affiliate_membership_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_membership" ADD CONSTRAINT "affiliate_membership_affiliate_id_affiliate_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "affiliate_commission_store_idx" ON "affiliate_commission" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "affiliate_commission_affiliate_idx" ON "affiliate_commission" USING btree ("affiliate_id","id");--> statement-breakpoint
CREATE INDEX "affiliate_commission_due_idx" ON "affiliate_commission" USING btree ("status","payable_at");--> statement-breakpoint
CREATE INDEX "affiliate_membership_affiliate_idx" ON "affiliate_membership" USING btree ("affiliate_id");--> statement-breakpoint

-- ===== T-108 affiliate membership per store and commission as a seller obligation (ADR-0015 decisions 1 to 4; D-29, D-31, D-32 C-A3/C-A4/C-A6, D-33; D-38) =====
-- Hand-written; everything of T-108 that drizzle-kit does not generate sits in this one section. Function bodies keep to the definer invariant: pinned
-- search_path, every relation schema-qualified, no dynamic SQL. Nothing here rewrites an existing row: the T-52 attributions written before this migration
-- keep their deduction in `order_financials` and get no obligation (their commission was already taken from the seller's sale); new orders never deduct.

-- 1. Isolation and grants. Both tables are store records (`tenant`): the seller reads its own store's memberships and obligations; the affiliate reads its
--    own through affiliate_own_memberships() / affiliate_own_commissions(). The app role inserts neither: an application is affiliate_apply(), an obligation
--    is written with its attribution by affiliate_record_attribution(). The seller reviews through four column grants; the release job runs on the platform pool.
ALTER TABLE public.affiliate_membership ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.affiliate_membership FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.affiliate_membership USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.affiliate_commission ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.affiliate_commission FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.affiliate_commission USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
REVOKE ALL ON public.affiliate_membership, public.affiliate_commission FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON public.affiliate_membership TO bukalaris_app;--> statement-breakpoint
GRANT UPDATE (status, status_reason, reviewed_by, reviewed_at) ON public.affiliate_membership TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.affiliate_membership TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON public.affiliate_commission TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, UPDATE ON public.affiliate_commission TO bukalaris_platform;--> statement-breakpoint

-- 2. The decided programme bounds (D-31 OPEN-A1/A2): 100 to 5000 bps, 7-day window. Only the T-52 placeholder maximum moves; a value someone already
--    changed is left alone. Owner-configurable as before (one row, `affiliate_policy`). The release job kind (JOB-38).
UPDATE public.affiliate_policy SET max_rate_bps = 5000, updated_by = 'system:migration:t108' WHERE id = 1 AND max_rate_bps = 2000;--> statement-breakpoint
INSERT INTO public.platform_job_kind (kind) VALUES ('affiliate.commission.release') ON CONFLICT (kind) DO NOTHING;--> statement-breakpoint

-- 3. C-A3 (D-38 C, owner-delegated): an affiliate account is created only for a verified e-mail and is then `active`; there is no platform application
--    step, so no new account starts `pending` (the column default is now `active`). Accounts written before 0028 keep their state, and the update
--    transitions (the Owner console's suspension and closure, the T-52 review of a legacy `pending` row) are unchanged. Body otherwise identical to 0016.
CREATE OR REPLACE FUNCTION public.affiliate_status_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'an affiliate account starts active' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."user" u WHERE u.id = NEW.user_id AND u.email_verified) THEN
      RAISE EXCEPTION 'an affiliate account needs a verified e-mail' USING ERRCODE = 'check_violation';
    END IF;
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

-- 4. Membership state machine (ADR-0015 decision 1). pending -> active | rejected (seller); active -> suspended -> active (seller); rejected -> pending (the
--    affiliate applies again: a fresh, unreviewed application). The application fields change only with a new application; a review names its reviewer,
--    and a `system:` reviewer is written only on INSERT, which only the owner-side definer path can do (auto-approval): a seller's review never claims it.
CREATE FUNCTION public.affiliate_membership_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.affiliate_reset', true) = 'demo' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'a membership is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT ((NEW.status = 'pending' AND NEW.reviewed_by IS NULL AND NEW.reviewed_at IS NULL AND NEW.status_reason IS NULL)
         OR (NEW.status = 'active' AND NEW.reviewed_by = 'system:auto_approve' AND NEW.reviewed_at IS NOT NULL AND NEW.status_reason IS NULL)) THEN
      RAISE EXCEPTION 'a membership starts pending, or active when the store approves automatically' USING ERRCODE = 'check_violation';
    END IF;
    NEW.revision := 1;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.store_id <> OLD.store_id OR NEW.affiliate_id <> OLD.affiliate_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the membership identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = OLD.status THEN
    IF (NEW.display_name, NEW.channels, NEW.application_note, NEW.status_reason, NEW.reviewed_by, NEW.reviewed_at)
       IS DISTINCT FROM (OLD.display_name, OLD.channels, OLD.application_note, OLD.status_reason, OLD.reviewed_by, OLD.reviewed_at) THEN
      RAISE EXCEPTION 'a membership changes only with its state' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'rejected'))
       OR (OLD.status = 'active' AND NEW.status = 'suspended')
       OR (OLD.status = 'suspended' AND NEW.status = 'active')
       OR (OLD.status = 'rejected' AND NEW.status = 'pending')) THEN
    RAISE EXCEPTION 'illegal membership transition % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'pending' THEN
    NEW.status_reason := NULL;
    NEW.reviewed_by := NULL;
    NEW.reviewed_at := NULL;
  ELSE
    IF (NEW.display_name, NEW.channels, NEW.application_note) IS DISTINCT FROM (OLD.display_name, OLD.channels, OLD.application_note) THEN
      RAISE EXCEPTION 'the application changes only with a new application' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reviewed_by IS NULL OR pg_catalog.btrim(NEW.reviewed_by) = '' THEN RAISE EXCEPTION 'a membership review names its reviewer' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.reviewed_by LIKE 'system:%' THEN RAISE EXCEPTION 'a system reviewer is written only by automatic approval' USING ERRCODE = 'check_violation'; END IF;
    NEW.reviewed_at := pg_catalog.now();
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_membership_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_membership_guard BEFORE INSERT OR UPDATE OR DELETE ON public.affiliate_membership FOR EACH ROW EXECUTE FUNCTION public.affiliate_membership_guard();--> statement-breakpoint

-- 5. Apply to one store (RL-AFF-STORE-APPLY: the per-day budget is counted by the service before this call; "one open application per affiliate and
--    store" is the unique key). The affiliate comes from the transaction's own context (app.affiliate_id, the verified portal session), never from an
--    argument. Only an active account applies, only to an active store whose programme is open and that has not blocked it. A pending or active
--    membership is returned as it is (idempotent), a rejected one becomes a new pending application, a suspended one cannot apply. Every refusal is the
--    same SQLSTATE BKAF1 with no detail, so the answer never hints at the store's decision. The store's auto-approval (default off) makes the new
--    membership active at once, reviewed by `system:auto_approve`. T-109 adds the frozen-programme refusal here.
CREATE FUNCTION public.affiliate_apply(p_store bigint, p_note text, p_channels text[]) RETURNS TABLE (r_membership_id bigint, r_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_aff bigint := public.app_affiliate_id(); v_name text; v_auto boolean; v_note text := NULLIF(pg_catalog.btrim(p_note), ''); v_channels text[] := COALESCE(p_channels, '{}'::text[]); m public.affiliate_membership%ROWTYPE;
BEGIN
  IF v_aff IS NULL THEN RAISE EXCEPTION 'affiliate_apply: no affiliate context' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_store IS NULL OR (v_note IS NOT NULL AND pg_catalog.char_length(v_note) > 500) OR pg_catalog.cardinality(v_channels) > 5
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_channels) c(v) WHERE c.v IS NULL OR pg_catalog.char_length(pg_catalog.btrim(c.v)) NOT BETWEEN 1 AND 200) THEN
    RAISE EXCEPTION 'affiliate_apply: invalid application' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT a.display_name INTO v_name FROM public.affiliate a WHERE a.id = v_aff AND a.status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'affiliate_apply: unavailable' USING ERRCODE = 'BKAF1'; END IF;
  SELECT s.auto_approve INTO v_auto FROM public.affiliate_seller_policy s JOIN public.store st ON st.id = s.store_id AND st.status = 'active'
   WHERE s.store_id = p_store AND s.participation = 'open' FOR SHARE OF s;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.affiliate_block b WHERE b.store_id = p_store AND b.affiliate_id = v_aff) THEN
    RAISE EXCEPTION 'affiliate_apply: unavailable' USING ERRCODE = 'BKAF1';
  END IF;
  SELECT * INTO m FROM public.affiliate_membership x WHERE x.store_id = p_store AND x.affiliate_id = v_aff FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.affiliate_membership (store_id, affiliate_id, status, display_name, channels, application_note, reviewed_by, reviewed_at)
    VALUES (p_store, v_aff, CASE WHEN v_auto THEN 'active' ELSE 'pending' END, v_name, v_channels, v_note,
            CASE WHEN v_auto THEN 'system:auto_approve' END, CASE WHEN v_auto THEN pg_catalog.now() END)
    ON CONFLICT (store_id, affiliate_id) DO NOTHING
    RETURNING * INTO m;
    IF m.id IS NULL THEN -- a concurrent application of the same affiliate won: answer with it
      SELECT * INTO m FROM public.affiliate_membership x WHERE x.store_id = p_store AND x.affiliate_id = v_aff;
    END IF;
  ELSIF m.status = 'rejected' THEN
    UPDATE public.affiliate_membership x SET status = 'pending', display_name = v_name, channels = v_channels, application_note = v_note WHERE x.id = m.id RETURNING * INTO m;
  ELSIF m.status = 'suspended' THEN
    RAISE EXCEPTION 'affiliate_apply: unavailable' USING ERRCODE = 'BKAF1';
  END IF;
  RETURN QUERY SELECT m.id, m.status;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_apply(bigint, text, text[]) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.affiliate_apply(bigint, text, text[]) TO bukalaris_app;--> statement-breakpoint

-- 6. The affiliate's own reads (its context only). Memberships: store and state, never the seller's reason. Obligations: amounts and state, never the order
--    id (PRIV-7; the affiliate statement of T-109 builds on this).
CREATE FUNCTION public.affiliate_own_memberships() RETURNS TABLE (r_membership_id bigint, r_store_id bigint, r_store_slug text, r_store_name text, r_status text, r_created_at timestamptz, r_reviewed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.id, m.store_id, s.slug, s.name, m.status, m.created_at, m.reviewed_at
    FROM public.affiliate_membership m JOIN public.store s ON s.id = m.store_id
   WHERE m.affiliate_id = public.app_affiliate_id()
   ORDER BY m.id
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_own_memberships() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.affiliate_own_memberships() TO bukalaris_app;--> statement-breakpoint
CREATE FUNCTION public.affiliate_own_commissions() RETURNS TABLE (r_commission_id bigint, r_store_id bigint, r_status text, r_commission_base_idr bigint, r_commission_idr bigint, r_created_at timestamptz, r_payable_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.id, c.store_id, c.status, c.commission_base_idr, c.commission_idr, c.created_at, c.payable_at
    FROM public.affiliate_commission c
   WHERE c.affiliate_id = public.app_affiliate_id()
   ORDER BY c.id
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_own_commissions() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.affiliate_own_commissions() TO bukalaris_app;--> statement-breakpoint

-- 7. Selection (ADR-0015 decision 3; T-52 rules otherwise unchanged): only an affiliate with an ACTIVE membership of this store is eligible, by code or by
--    click (an ineligible code falls back to a click, as for a block; a self-referral still earns nothing and never falls back). The membership row is
--    share-locked with the account, so a concurrent suspension waits for the order or the order sees it. A sandbox test order (T-105 decision 11,
--    `order.test_order`) selects nobody and counts nothing.
CREATE OR REPLACE FUNCTION public.affiliate_resolve_core(p_store bigint, p_order bigint, p_code text, p_clicks text[])
RETURNS TABLE (r_affiliate_id bigint, r_method text, r_click_id text, r_code_id bigint, r_outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_phone text; v_test boolean; v_aff bigint; v_aff_phone text; v_method text; v_click text; v_code bigint;
BEGIN
  SELECT public.buyer_canonical_phone(o.buyer_phone), o.test_order INTO v_phone, v_test FROM public."order" o WHERE o.store_id = p_store AND o.id = p_order;
  IF NOT FOUND THEN RAISE EXCEPTION 'affiliate: order % of store % does not exist', p_order, p_store USING ERRCODE = 'no_data_found'; END IF;
  IF v_test THEN
    RETURN QUERY SELECT NULL::bigint, NULL::text, NULL::text, NULL::bigint, 'none'::text;
    RETURN;
  END IF;
  IF p_code IS NOT NULL THEN
    SELECT c.id, c.affiliate_id, a.contact_phone INTO v_code, v_aff, v_aff_phone
      FROM public.affiliate_code c JOIN public.affiliate a ON a.id = c.affiliate_id
      JOIN public.affiliate_membership m ON m.store_id = p_store AND m.affiliate_id = a.id AND m.status = 'active'
     WHERE c.code = p_code AND c.status = 'active' AND (c.expires_at IS NULL OR pg_catalog.now() < c.expires_at) AND a.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM public.affiliate_block b WHERE b.store_id = p_store AND b.affiliate_id = a.id)
       FOR SHARE OF a, m;
    IF FOUND THEN v_method := 'code'; END IF;
  END IF;
  IF v_method IS NULL AND p_clicks IS NOT NULL AND pg_catalog.cardinality(p_clicks) > 0 THEN
    SELECT k.id, k.affiliate_id, a.contact_phone INTO v_click, v_aff, v_aff_phone
      FROM public.affiliate_click k
      JOIN public.affiliate_link l ON l.id = k.link_id AND l.affiliate_id = k.affiliate_id AND l.store_id = k.store_id
      JOIN public.affiliate a ON a.id = k.affiliate_id
      JOIN public.affiliate_membership m ON m.store_id = p_store AND m.affiliate_id = a.id AND m.status = 'active'
     WHERE k.id = ANY (p_clicks[1:5]) AND k.store_id = p_store AND pg_catalog.now() < k.expires_at AND l.status = 'active' AND a.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM public.affiliate_block b WHERE b.store_id = p_store AND b.affiliate_id = a.id)
     ORDER BY k.captured_at DESC, k.id DESC
     LIMIT 1
       FOR SHARE OF a, m;
    IF FOUND THEN v_method := 'link'; END IF;
  END IF;
  IF v_method IS NULL THEN
    RETURN QUERY SELECT NULL::bigint, NULL::text, NULL::text, NULL::bigint, 'none'::text;
  ELSIF v_phone IS NULL OR v_aff_phone = v_phone THEN
    RETURN QUERY SELECT v_aff, v_method, v_click, v_code, 'self_referral'::text;
  ELSE
    RETURN QUERY SELECT v_aff, v_method, v_click, v_code, 'selected'::text;
  END IF;
END $$;--> statement-breakpoint

-- RL-CODE counts a code that is not usable in THIS store as an invalid guess: a code of an affiliate without an active membership here is one.
CREATE OR REPLACE FUNCTION public.affiliate_code_valid(p_store bigint, p_code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_store IS NULL OR p_store IS DISTINCT FROM public.app_store_id() THEN RAISE EXCEPTION 'affiliate: the store does not match the transaction context' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_code IS NULL OR p_code !~ '^[A-Z0-9]{4,24}$' THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.affiliate_code c JOIN public.affiliate a ON a.id = c.affiliate_id
      JOIN public.affiliate_membership m ON m.store_id = p_store AND m.affiliate_id = a.id AND m.status = 'active'
     WHERE c.code = p_code AND c.status = 'active' AND (c.expires_at IS NULL OR pg_catalog.now() < c.expires_at) AND a.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM public.affiliate_block b WHERE b.store_id = p_store AND b.affiliate_id = a.id));
END $$;--> statement-breakpoint

-- 7b. The rate of one product (D-38 B, owner-delegated; ADR-0015 decision 2 read literally): while the store's programme is open with a default rate, EVERY
--     published product of the active store earns the default; an `affiliate_offer` row is the per-product override (its `rate_bps`, else the default) or
--     an exclusion (`paused` / `withdrawn` earn 0). Rates outside the programme bounds earn 0. Lock order as before: the store policy, then the offer.
--     The TypeScript mirror is `effectiveOfferRate` (affiliate/catalog.ts); a parity test runs one corpus through both. 0016's definition is replaced, not edited.
CREATE OR REPLACE FUNCTION public.affiliate_line_rate(p_store bigint, p_product bigint) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_default integer; v_min integer; v_max integer; v_status text; v_override integer; v_rate integer;
BEGIN
  IF p_store IS NULL OR p_store IS DISTINCT FROM public.app_store_id() THEN RAISE EXCEPTION 'affiliate: the store does not match the transaction context' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT s.default_rate_bps, g.min_rate_bps, g.max_rate_bps INTO v_default, v_min, v_max
    FROM public.affiliate_seller_policy s
    JOIN public.store st ON st.id = s.store_id AND st.status = 'active'
    JOIN public.product pr ON pr.store_id = s.store_id AND pr.id = p_product AND pr.status = 'active'
    CROSS JOIN public.affiliate_policy g
   WHERE s.store_id = p_store AND s.participation = 'open'
     FOR SHARE OF s;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT o.status, o.rate_bps INTO v_status, v_override
    FROM public.affiliate_offer o WHERE o.store_id = p_store AND o.source = 'bukalaris' AND o.product_id = p_product
     FOR SHARE OF o;
  IF FOUND AND v_status <> 'active' THEN RETURN 0; END IF;
  v_rate := COALESCE(v_override, v_default);
  IF v_rate IS NULL OR v_rate < v_min OR v_rate > v_max THEN RETURN 0; END IF;
  RETURN v_rate;
END $$;--> statement-breakpoint

-- 8. The only writer of an attribution and of its obligation (ADR-0015 decision 4, C-A6). It re-runs the selection and re-derives every line rate from the live
--    offer rules; the base and the single-floor commission come from the frozen line snapshot (the attribution guard re-proves both). The seller's sale is
--    never reduced: the order's financial snapshot carries no affiliate and no commission (affiliate_financial_check). The obligation is written in the same
--    statement sequence, equal to the attribution, with the hold of this moment.
CREATE OR REPLACE FUNCTION public.affiliate_record_attribution(p_store bigint, p_order bigint, p_code text, p_clicks text[]) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record; v_code text := p_code; v_bad integer; v_base numeric; v_commission numeric; v_pol public.affiliate_policy%ROWTYPE; v_sp integer; v_id bigint;
BEGIN
  IF p_store IS NULL OR p_store IS DISTINCT FROM public.app_store_id() THEN RAISE EXCEPTION 'affiliate: the store does not match the transaction context' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF v_code IS NOT NULL AND v_code !~ '^[A-Z0-9]{4,24}$' THEN v_code := NULL; END IF;
  SELECT * INTO r FROM public.affiliate_resolve_core(p_store, p_order, v_code, p_clicks);
  IF r.r_outcome IS DISTINCT FROM 'selected' THEN RAISE EXCEPTION 'affiliate: no eligible selector for order %', p_order USING ERRCODE = 'check_violation'; END IF;
  SELECT pg_catalog.count(*) INTO v_bad
    FROM public.order_line_financials l JOIN public.variant v ON v.store_id = l.store_id AND v.id = l.variant_id
   WHERE l.store_id = p_store AND l.order_id = p_order AND l.commission_rate_bps IS DISTINCT FROM public.affiliate_line_rate(p_store, v.product_id);
  IF v_bad > 0 THEN RAISE EXCEPTION 'affiliate: a line rate of order % does not match the live offer rules', p_order USING ERRCODE = 'check_violation'; END IF;
  SELECT pg_catalog.sum(l.commission_base_idr) FILTER (WHERE l.commission_rate_bps > 0), pg_catalog.floor(pg_catalog.sum(l.commission_base_idr::numeric * l.commission_rate_bps) / 10000)
    INTO v_base, v_commission
    FROM public.order_line_financials l WHERE l.store_id = p_store AND l.order_id = p_order;
  IF v_commission IS NULL OR v_commission <= 0 THEN RAISE EXCEPTION 'affiliate: order % earns no commission', p_order USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO v_pol FROM public.affiliate_policy g WHERE g.id = 1;
  SELECT s.revision INTO v_sp FROM public.affiliate_seller_policy s WHERE s.store_id = p_store;
  INSERT INTO public.affiliate_attribution (order_id, store_id, affiliate_id, method, code_id, click_id, window_days, hold_days, policy_revision, seller_policy_revision, commission_base_idr, commission_idr)
  VALUES (p_order, p_store, r.r_affiliate_id, r.r_method, r.r_code_id, r.r_click_id, v_pol.attribution_window_days, v_pol.hold_days, v_pol.revision, v_sp, v_base::bigint, v_commission::bigint)
  RETURNING id INTO v_id;
  INSERT INTO public.affiliate_commission (store_id, order_id, affiliate_id, commission_base_idr, commission_idr, hold_days)
  VALUES (p_store, p_order, r.r_affiliate_id, v_base::bigint, v_commission::bigint, v_pol.hold_days);
  RETURN v_id;
END $$;--> statement-breakpoint

-- 9. Attribution guard. INSERT: the order's sale carries no deduction, the affiliate holds an ACTIVE membership of the store at this moment (share-locked),
--    the order is not a sandbox test order, and the commission is the single floor of the line bases at their frozen rates. These rules hold for every
--    writer, the definer function above included. UPDATE and DELETE: unchanged from 0016.
CREATE OR REPLACE FUNCTION public.affiliate_attribution_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
  IF NOT FOUND OR f.affiliate_id IS NOT NULL OR f.affiliate_commission_idr <> 0 THEN
    RAISE EXCEPTION 'the attribution needs the financial snapshot of its order, without a commission deduction' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM public.affiliate_membership m WHERE m.store_id = NEW.store_id AND m.affiliate_id = NEW.affiliate_id AND m.status = 'active' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'affiliate % holds no active membership of store %', NEW.affiliate_id, NEW.store_id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public."order" o WHERE o.store_id = NEW.store_id AND o.id = NEW.order_id AND o.test_order) THEN
    RAISE EXCEPTION 'a sandbox test order earns no commission' USING ERRCODE = 'check_violation';
  END IF;
  SELECT pg_catalog.count(*), pg_catalog.count(l.commission_rate_bps), pg_catalog.sum(l.commission_base_idr) FILTER (WHERE l.commission_rate_bps > 0), pg_catalog.floor(pg_catalog.sum(l.commission_base_idr::numeric * l.commission_rate_bps) / 10000)
    INTO v_lines, v_rated, v_base, v_commission
    FROM public.order_line_financials l WHERE l.store_id = NEW.store_id AND l.order_id = NEW.order_id;
  IF v_lines = 0 OR v_rated <> v_lines OR v_base IS DISTINCT FROM NEW.commission_base_idr::numeric OR v_commission IS DISTINCT FROM NEW.commission_idr::numeric THEN
    RAISE EXCEPTION 'the commission must be the single floor of the line bases at their frozen rates' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 10. Checked at COMMIT for every new order snapshot: the seller's sale is never reduced by a commission (no affiliate and no commission on
--     `order_financials`, whatever the money mode), and line rates exist exactly when the order carries an attribution, whose obligation exists with the
--     same affiliate and amount. Existing rows are not re-checked (the trigger fires on INSERT only).
CREATE OR REPLACE FUNCTION public.affiliate_financial_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a public.affiliate_attribution%ROWTYPE; v_found boolean; v_lines integer; v_rated integer;
BEGIN
  IF NEW.affiliate_id IS NOT NULL OR NEW.affiliate_commission_idr <> 0 THEN
    RAISE EXCEPTION 'order % deducts an affiliate commission: the seller sale stays whole and the commission is the seller''s obligation (T-108)', NEW.order_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT pg_catalog.count(*), pg_catalog.count(l.commission_rate_bps) INTO v_lines, v_rated FROM public.order_line_financials l WHERE l.store_id = NEW.store_id AND l.order_id = NEW.order_id;
  SELECT * INTO a FROM public.affiliate_attribution t WHERE t.store_id = NEW.store_id AND t.order_id = NEW.order_id;
  v_found := FOUND;
  IF NOT v_found THEN
    IF v_rated <> 0 THEN RAISE EXCEPTION 'order % freezes commission rates without its attribution', NEW.order_id USING ERRCODE = 'check_violation'; END IF;
  ELSIF v_rated <> v_lines OR NOT EXISTS (SELECT 1 FROM public.affiliate_commission c WHERE c.store_id = NEW.store_id AND c.order_id = NEW.order_id AND c.affiliate_id = a.affiliate_id AND c.commission_idr = a.commission_idr) THEN
    RAISE EXCEPTION 'order % carries an attribution without its obligation', NEW.order_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint

-- 11. Obligation guard (ADR-0015 decision 4). Insert: pending, equal to the attribution of its order. Afterwards the amounts never move; delivery is stamped
--     once, on a completed order, with `payable_at` = delivery + the snapshotted hold; the transitions are pending -> void ONLY before delivery (the order
--     cancelled or returned; D-38 A: nothing after delivery voids, a mistake is a manual correction of T-109), pending -> payable (from `payable_at` on), and
--     the T-109 states payable -> paid -> confirmed | disputed. Never deleted (the owner-side demo reset aside).
CREATE FUNCTION public.affiliate_commission_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t public.affiliate_attribution%ROWTYPE; v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.affiliate_reset', true) = 'demo' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'a commission obligation is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.delivered_at IS NOT NULL OR NEW.payable_at IS NOT NULL OR NEW.void_reason IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a commission obligation starts pending' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO t FROM public.affiliate_attribution a WHERE a.store_id = NEW.store_id AND a.order_id = NEW.order_id;
    IF NOT FOUND OR t.affiliate_id <> NEW.affiliate_id OR t.commission_idr <> NEW.commission_idr OR t.commission_base_idr <> NEW.commission_base_idr OR t.hold_days <> NEW.hold_days THEN
      RAISE EXCEPTION 'the obligation must equal the attribution of its order' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.store_id <> OLD.store_id OR NEW.order_id <> OLD.order_id OR NEW.affiliate_id <> OLD.affiliate_id OR NEW.commission_base_idr <> OLD.commission_base_idr
     OR NEW.commission_idr <> OLD.commission_idr OR NEW.hold_days <> OLD.hold_days OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a frozen commission obligation is never rewritten' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.delivered_at IS DISTINCT FROM OLD.delivered_at OR NEW.payable_at IS DISTINCT FROM OLD.payable_at THEN
    SELECT o.status INTO v_status FROM public."order" o WHERE o.store_id = NEW.store_id AND o.id = NEW.order_id;
    IF OLD.delivered_at IS NOT NULL OR NEW.delivered_at IS NULL OR OLD.status <> 'pending' OR v_status IS DISTINCT FROM 'completed'
       OR NEW.payable_at IS DISTINCT FROM NEW.delivered_at + pg_catalog.make_interval(days => NEW.hold_days) THEN
      RAISE EXCEPTION 'delivery is stamped once, on a completed order, with the hold the order froze' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'pending' AND NEW.status = 'void' AND OLD.delivered_at IS NULL AND NEW.delivered_at IS NULL)
         OR (OLD.status = 'pending' AND NEW.status = 'payable' AND NEW.payable_at IS NOT NULL AND NEW.payable_at <= pg_catalog.now())
         OR (OLD.status = 'payable' AND NEW.status = 'paid')
         OR (OLD.status = 'paid' AND NEW.status IN ('confirmed', 'disputed'))) THEN
      RAISE EXCEPTION 'illegal commission transition % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'void' THEN NEW.voided_at := pg_catalog.now(); END IF;
  ELSIF NEW.void_reason IS DISTINCT FROM OLD.void_reason OR NEW.voided_at IS DISTINCT FROM OLD.voided_at THEN
    RAISE EXCEPTION 'a void reason changes only with its state' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_commission_guard() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_commission_guard BEFORE INSERT OR UPDATE OR DELETE ON public.affiliate_commission FOR EACH ROW EXECUTE FUNCTION public.affiliate_commission_guard();--> statement-breakpoint

-- 12. The order status hook: whatever writes the order's status (seller action, courier status, approved manual completion, payment settlement, the
--     bank-transfer expiry sweep), the obligation follows in the same transaction. `completed` is delivery (a physical or mixed order on the courier's
--     DELIVERED or the four-eyes manual completion; a digital-only order when it is paid, in the transaction that issues its access grants: ADR-0016
--     decision 20); `cancelled` and `returned` before delivery void it. A completed order never moves again (order_status_guard), so nothing after
--     delivery reverses an obligation automatically (ADR-0015 decision 4).
CREATE FUNCTION public.affiliate_commission_order_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status = 'completed' THEN
    UPDATE public.affiliate_commission c SET delivered_at = pg_catalog.now(), payable_at = pg_catalog.now() + pg_catalog.make_interval(days => c.hold_days)
     WHERE c.store_id = NEW.store_id AND c.order_id = NEW.id AND c.status = 'pending' AND c.delivered_at IS NULL;
  ELSE
    UPDATE public.affiliate_commission c SET status = 'void', void_reason = 'order_' || NEW.status
     WHERE c.store_id = NEW.store_id AND c.order_id = NEW.id AND c.status = 'pending' AND c.delivered_at IS NULL;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.affiliate_commission_order_sync() FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER affiliate_commission_order_sync AFTER UPDATE OF status ON public."order" FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed', 'cancelled', 'returned')) EXECUTE FUNCTION public.affiliate_commission_order_sync();--> statement-breakpoint

-- 13. T-112's digital hook is removed (D-38 A, owner-delegated; review M-1): it voided a commission after delivery when the last access grant was revoked,
--     against ADR-0015 decision 4 (`void` only for a cancel or return before delivery, by the order status writer). The hold of a digital-only order starts
--     at its completion (stamped above, in the transaction that issues the grants); a grant revocation, a recorded refund or a privacy redaction never voids
--     a commission. Attribution rows were never written by it after 0028 either.
DROP TRIGGER digital_grant_affiliate_sync ON public.digital_grant;--> statement-breakpoint
DROP FUNCTION public.digital_grant_affiliate_sync();--> statement-breakpoint

-- 14. Local demo reset: memberships and obligations of demo stores go first (obligations reference attributions). Owner connection only, as before.
CREATE OR REPLACE FUNCTION public.reset_demo_affiliate(p_store_ids bigint[]) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_ids bigint[]; v_total bigint := 0; v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname LIKE 'pg\_%') THEN
    RAISE EXCEPTION 'reset refused: a temporary relation shadows a system catalog' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT pg_catalog.array_agg(s.id) INTO v_ids FROM public.store s WHERE s.id = ANY (p_store_ids) AND s.slug LIKE 'demo-%';
  IF v_ids IS NULL THEN RETURN 0; END IF;
  PERFORM pg_catalog.set_config('bukalaris.affiliate_reset', 'demo', true);
  DELETE FROM public.affiliate_commission WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_attribution WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_click WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_link WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_catalog WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_block WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_membership WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_offer WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.affiliate_seller_policy WHERE store_id = ANY (v_ids); GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  PERFORM pg_catalog.set_config('bukalaris.affiliate_reset', '', true);
  RETURN v_total;
END $$;
