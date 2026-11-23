CREATE TABLE "bank_transfer_confirmation" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bank_transfer_confirmation_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"proof_id" uuid,
	"confirmed_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transfer_confirmation_order_uq" UNIQUE("store_id","order_id"),
	CONSTRAINT "bank_transfer_confirmation_chk" CHECK (length(btrim("bank_transfer_confirmation"."reason")) between 5 and 500)
);
--> statement-breakpoint
CREATE TABLE "order_bank_transfer" (
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"accounts" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_bank_transfer_pk" PRIMARY KEY("store_id","order_id"),
	CONSTRAINT "order_bank_transfer_chk" CHECK (jsonb_typeof("order_bank_transfer"."accounts") = 'array' and jsonb_array_length("order_bank_transfer"."accounts") between 1 and 5 and "order_bank_transfer"."expires_at" > "order_bank_transfer"."created_at")
);
--> statement-breakpoint
CREATE TABLE "payment_proof" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"files" jsonb NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"files_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_proof_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "payment_proof_chk" CHECK ("payment_proof"."status" in ('sent', 'accepted', 'rejected') and jsonb_typeof("payment_proof"."files") = 'array'
    and (jsonb_array_length("payment_proof"."files") between 1 and 3 or ("payment_proof"."files_purged_at" is not null and jsonb_array_length("payment_proof"."files") = 0))
    and (("payment_proof"."status" = 'sent') = ("payment_proof"."decided_at" is null)) and (("payment_proof"."decided_at" is null) = ("payment_proof"."decided_by" is null))
    and (("payment_proof"."status" = 'rejected') = ("payment_proof"."reject_reason" is not null)) and ("payment_proof"."reject_reason" is null or length(btrim("payment_proof"."reject_reason")) between 5 and 500))
);
--> statement-breakpoint
CREATE TABLE "store_bank_account" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "store_bank_account_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"bank_code" text NOT NULL,
	"account_number" text NOT NULL,
	"holder_name" text NOT NULL,
	"created_by" text NOT NULL,
	"step_up_ref" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	"removal_step_up_ref" uuid,
	CONSTRAINT "bank_account_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "bank_account_step_up_uq" UNIQUE("step_up_ref"),
	CONSTRAINT "bank_account_fields_chk" CHECK ("store_bank_account"."bank_code" ~ '^[A-Z0-9]{2,12}$' and "store_bank_account"."account_number" ~ '^[0-9]{5,24}$' and length(btrim("store_bank_account"."holder_name")) between 2 and 120
    and (("store_bank_account"."removed_at" is null) = ("store_bank_account"."removed_by" is null)) and (("store_bank_account"."removed_at" is null) = ("store_bank_account"."removal_step_up_ref" is null)))
);
--> statement-breakpoint
CREATE TABLE "store_bank_transfer" (
	"store_id" bigint PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"payment_window_hours" integer DEFAULT 24 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transfer_window_chk" CHECK ("store_bank_transfer"."payment_window_hours" between 1 and 168 and "store_bank_transfer"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "order" DROP CONSTRAINT "order_payment_chk";--> statement-breakpoint
ALTER TABLE "bank_transfer_confirmation" ADD CONSTRAINT "bank_transfer_confirmation_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer_confirmation" ADD CONSTRAINT "bank_transfer_confirmation_proof_fk" FOREIGN KEY ("store_id","proof_id") REFERENCES "public"."payment_proof"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bank_transfer" ADD CONSTRAINT "order_bank_transfer_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proof" ADD CONSTRAINT "payment_proof_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_bank_account" ADD CONSTRAINT "store_bank_account_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_bank_transfer" ADD CONSTRAINT "store_bank_transfer_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_bank_transfer_expiry_idx" ON "order_bank_transfer" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_proof_one_sent_uq" ON "payment_proof" USING btree ("store_id","order_id") WHERE "payment_proof"."status" = 'sent';--> statement-breakpoint
CREATE INDEX "bank_account_store_idx" ON "store_bank_account" USING btree ("store_id","removed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_account_removal_step_up_uq" ON "store_bank_account" USING btree ("removal_step_up_ref") WHERE "store_bank_account"."removal_step_up_ref" is not null;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_payment_chk" CHECK ("order"."payment_method" in ('cod', 'manual_transfer', 'bank_transfer'));--> statement-breakpoint

-- ===== T-113 bank transfer to the seller's own bank account (ADR-0013 section 10, decisions 35 to 39; D-31, D-32, D-33, D-36) ===========
-- The store lists its destination accounts (step-up, audited, at most five listed), the buyer pays the exact order total into one of them,
-- may upload a private proof, and only the seller's confirmation record makes the order paid. No provider, no platform account, no bank check.

-- 1. D-36: a listed bank account is a seller-owned money account. The money mode counts every row (a removal is a stamp), so it never goes back,
--    and the first one obeys the clean cut-over of T-107 (review M2) like a provider account.
CREATE OR REPLACE FUNCTION public.store_money_mode(p_store_id bigint) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.store_shipping_account a WHERE a.store_id = p_store_id AND a.kind = 'seller_owned')
                OR EXISTS (SELECT 1 FROM public.store_payment_account p WHERE p.store_id = p_store_id)
                OR EXISTS (SELECT 1 FROM public.store_bank_account b WHERE b.store_id = p_store_id)
              THEN 'seller_owned' ELSE 'platform_held' END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.store_money_mode(bigint) FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER a_money_cutover_guard BEFORE INSERT ON public.store_bank_account FOR EACH ROW EXECUTE FUNCTION public.money_cutover_guard();--> statement-breakpoint

-- 2. Store-owned tables: FORCE RLS on the store context, privileges per writer.
REVOKE ALL ON public.store_bank_account, public.store_bank_transfer, public.order_bank_transfer, public.payment_proof, public.bank_transfer_confirmation FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
ALTER TABLE public.store_bank_account ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.store_bank_account FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.store_bank_account USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.store_bank_transfer ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.store_bank_transfer FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.store_bank_transfer USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.order_bank_transfer ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.order_bank_transfer FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.order_bank_transfer USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.payment_proof ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.payment_proof FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.payment_proof USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
ALTER TABLE public.bank_transfer_confirmation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.bank_transfer_confirmation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.bank_transfer_confirmation USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT ON public.store_bank_account TO bukalaris_app;--> statement-breakpoint
GRANT UPDATE (removed_at, removed_by, removal_step_up_ref) ON public.store_bank_account TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.store_bank_account TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.store_bank_transfer TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.store_bank_transfer TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON public.order_bank_transfer TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.order_bank_transfer TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON public.payment_proof TO bukalaris_app;--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, reject_reason) ON public.payment_proof TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.payment_proof TO bukalaris_platform;--> statement-breakpoint
GRANT UPDATE (files, files_purged_at) ON public.payment_proof TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON public.bank_transfer_confirmation TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.bank_transfer_confirmation TO bukalaris_platform;--> statement-breakpoint
CREATE TRIGGER order_bank_transfer_append_only BEFORE UPDATE OR DELETE ON public.order_bank_transfer FOR EACH ROW EXECUTE FUNCTION public.payment_evidence_guard();--> statement-breakpoint
CREATE TRIGGER bank_transfer_confirmation_append_only BEFORE UPDATE OR DELETE ON public.bank_transfer_confirmation FOR EACH ROW EXECUTE FUNCTION public.payment_evidence_guard();--> statement-breakpoint

-- 3. Decision 36 / THR-17: an account is listed or removed only with an owner step-up consumed in the same transaction (action
--    `integrations.bank_account`, subject `bank_transfer`), at most five listed at a time (serialised per store), and a row is never edited or
--    deleted: the only change is the removal stamp, once.
CREATE FUNCTION public.store_bank_account_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ref uuid;
  v_user text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.payment_evidence_reset', true) = 'demo' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'a bank account is never deleted; it is removed with a stamp' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bank_account:' || NEW.store_id::text, 0));
    IF NEW.removed_at IS NOT NULL THEN RAISE EXCEPTION 'a new bank account is listed' USING ERRCODE = 'check_violation'; END IF;
    IF (SELECT pg_catalog.count(*) FROM public.store_bank_account b WHERE b.store_id = NEW.store_id AND b.removed_at IS NULL) >= 5 THEN
      RAISE EXCEPTION 'bank_account_limit: at most five bank accounts are listed' USING ERRCODE = 'check_violation';
    END IF;
    v_ref := NEW.step_up_ref; v_user := NEW.created_by;
  ELSE
    IF (NEW.id, NEW.store_id, NEW.bank_code, NEW.account_number, NEW.holder_name, NEW.created_by, NEW.step_up_ref, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.store_id, OLD.bank_code, OLD.account_number, OLD.holder_name, OLD.created_by, OLD.step_up_ref, OLD.created_at)
       OR OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL THEN
      RAISE EXCEPTION 'a bank account is never edited; it is removed once' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_ref := NEW.removal_step_up_ref; v_user := NEW.removed_by;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_step_up_proof pr WHERE pr.id = v_ref AND pr.store_id = NEW.store_id AND pr.user_id = v_user
                   AND pr.action_key = 'integrations.bank_account' AND pr.subject_kind = 'store' AND pr.subject_id = 'bank_transfer' AND pr.consumed_at = pg_catalog.now()) THEN
    RAISE EXCEPTION 'a bank account change needs a step-up proof consumed in this transaction' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.store_bank_account_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER store_bank_account_guard BEFORE INSERT OR UPDATE OR DELETE ON public.store_bank_account FOR EACH ROW EXECUTE FUNCTION public.store_bank_account_guard();--> statement-breakpoint

-- 4. The order-side records: the snapshot names a bank-transfer order; a proof is sent only for an unpaid bank-transfer order, is decided once
--    (sent -> accepted | rejected) and loses only its files, once, to the retention purge; a confirmation names an unpaid bank-transfer order and,
--    when it names a proof, one of that order that was not rejected.
CREATE FUNCTION public.order_bank_transfer_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."order" o WHERE o.store_id = NEW.store_id AND o.id = NEW.order_id AND o.payment_method = 'bank_transfer') THEN
    RAISE EXCEPTION 'the bank-transfer record belongs to a bank-transfer order' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.order_bank_transfer_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER order_bank_transfer_guard BEFORE INSERT ON public.order_bank_transfer FOR EACH ROW EXECUTE FUNCTION public.order_bank_transfer_guard();--> statement-breakpoint
CREATE FUNCTION public.payment_proof_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.payment_evidence_reset', true) = 'demo' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'a payment proof is never deleted (its files are purged)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'sent' OR NEW.files_purged_at IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public."order" o WHERE o.store_id = NEW.store_id AND o.id = NEW.order_id AND o.payment_method = 'bank_transfer' AND o.status = 'awaiting_payment') THEN
      RAISE EXCEPTION 'a proof is sent only for an unpaid bank-transfer order' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.store_id, NEW.order_id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.store_id, OLD.order_id, OLD.created_at) THEN
    RAISE EXCEPTION 'a payment proof keeps its identity' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.files IS DISTINCT FROM OLD.files OR NEW.files_purged_at IS DISTINCT FROM OLD.files_purged_at THEN
    IF OLD.files_purged_at IS NOT NULL OR NEW.files_purged_at IS NULL OR NEW.files <> '[]'::jsonb THEN
      RAISE EXCEPTION 'the files of a proof are only purged, once' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF (NEW.status, NEW.decided_by, NEW.decided_at, NEW.reject_reason) IS DISTINCT FROM (OLD.status, OLD.decided_by, OLD.decided_at, OLD.reject_reason) THEN
    IF OLD.status <> 'sent' OR NEW.status NOT IN ('accepted', 'rejected') THEN
      RAISE EXCEPTION 'a proof is decided once' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."order" o WHERE o.store_id = NEW.store_id AND o.id = NEW.order_id AND o.status = 'awaiting_payment')
       OR (NEW.status = 'rejected' AND EXISTS (SELECT 1 FROM public.bank_transfer_confirmation c WHERE c.store_id = NEW.store_id AND c.proof_id = NEW.id)) THEN
      RAISE EXCEPTION 'a proof is decided only while its order waits for payment' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.payment_proof_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER payment_proof_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payment_proof FOR EACH ROW EXECUTE FUNCTION public.payment_proof_guard();--> statement-breakpoint
CREATE FUNCTION public.bank_transfer_confirmation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."order" o WHERE o.store_id = NEW.store_id AND o.id = NEW.order_id AND o.payment_method = 'bank_transfer' AND o.status = 'awaiting_payment') THEN
    RAISE EXCEPTION 'a bank-transfer confirmation names an unpaid bank-transfer order' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.proof_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.payment_proof p WHERE p.store_id = NEW.store_id AND p.id = NEW.proof_id AND p.order_id = NEW.order_id AND p.status <> 'rejected') THEN
    RAISE EXCEPTION 'the confirmation names a proof of that order that was not rejected' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.bank_transfer_confirmation_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER bank_transfer_confirmation_guard BEFORE INSERT ON public.bank_transfer_confirmation FOR EACH ROW EXECUTE FUNCTION public.bank_transfer_confirmation_guard();--> statement-breakpoint

-- 5. Decision 38: a bank-transfer order starts unpaid, keeps its method, and leaves awaiting payment other than by cancellation only with its
--    confirmation record, for every role (an upload, the worker, an Owner console path or a bare seller "pay" cannot make it paid).
CREATE FUNCTION public.order_bank_transfer_paid_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.payment_method = 'bank_transfer' AND NEW.status <> 'awaiting_payment' THEN
      RAISE EXCEPTION 'a bank-transfer order starts awaiting payment' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.payment_method = 'bank_transfer') IS DISTINCT FROM (NEW.payment_method = 'bank_transfer') THEN
    RAISE EXCEPTION 'the payment method of a bank-transfer order never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.payment_method = 'bank_transfer' AND OLD.status = 'awaiting_payment' AND NEW.status NOT IN ('awaiting_payment', 'cancelled')
     AND NOT EXISTS (SELECT 1 FROM public.bank_transfer_confirmation c WHERE c.store_id = NEW.store_id AND c.order_id = NEW.id) THEN
    RAISE EXCEPTION 'a bank-transfer order is paid only by the seller''s confirmation record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.order_bank_transfer_paid_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER order_bank_transfer_paid_guard BEFORE INSERT OR UPDATE OF status, payment_method ON public."order" FOR EACH ROW
  EXECUTE FUNCTION public.order_bank_transfer_paid_guard();--> statement-breakpoint

-- 6. Retention (D-33, owner 2026-11-15): proof files 90 days after the order closes. The row is kept (the confirmation names it); the cleanup
--    command deletes the files and stamps `files_purged_at`. The period is the retention setting of class `payment_proof` (`setRetentionPeriod`).
INSERT INTO public.retention_class (class, table_name, time_column, row_filter) VALUES
  ('payment_proof', 'payment_proof', 'created_at', 'false'),
  ('bank_transfer_confirmation', 'bank_transfer_confirmation', 'created_at', 'false'),
  ('order_bank_transfer', 'order_bank_transfer', 'created_at', 'false')
ON CONFLICT (class) DO NOTHING;--> statement-breakpoint
INSERT INTO public.retention_policy (class, period_days) VALUES ('payment_proof', 90) ON CONFLICT (class) DO NOTHING;--> statement-breakpoint
INSERT INTO public.retention_policy_event (class, period_days, actor_user_id, reason)
  VALUES ('payment_proof', 90, 'migration:T-113', 'D-33 (owner 2026-11-15): proof-of-transfer files are deleted 90 days after the order closes');--> statement-breakpoint

-- 7. The expiry sweep of unpaid bank-transfer orders (decision 37: stock is reserved for the store's payment window).
INSERT INTO public.platform_job_kind (kind) VALUES ('bank_transfer.expire') ON CONFLICT (kind) DO NOTHING;--> statement-breakpoint

-- 8. The demo reset removes the bank-transfer records and settings of demo stores before their orders and stores (the guards honour the reset flag).
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
  DELETE FROM public.bank_transfer_confirmation WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_proof WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.order_bank_transfer WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.store_bank_account WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.store_bank_transfer WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
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
