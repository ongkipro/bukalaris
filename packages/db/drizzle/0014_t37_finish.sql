CREATE TABLE "payout_control" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"reason" text,
	"changed_by" text,
	"destination_hold_hours" integer DEFAULT 72 NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_control_singleton_chk" CHECK ("payout_control"."id" = 1),
	CONSTRAINT "payout_control_hold_chk" CHECK ("payout_control"."destination_hold_hours" between 1 and 720)
);
--> statement-breakpoint
ALTER TABLE "payout" ADD COLUMN "reject_approval_request_id" bigint;--> statement-breakpoint
ALTER TABLE "refund" ADD COLUMN "fail_approval_request_id" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_reject_approval_uq" ON "payout" USING btree ("reject_approval_request_id") WHERE "payout"."reject_approval_request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_fail_approval_uq" ON "refund" USING btree ("fail_approval_request_id") WHERE "refund"."fail_approval_request_id" is not null;
--> statement-breakpoint
-- ===== T-37 finish (hand-written) =====
-- Everything below is hand-written: drizzle-kit models neither grants, triggers, seed rows nor views. The generated statements above are untouched.
-- Guards that 0013 created are REPLACED here with CREATE OR REPLACE FUNCTION (same name, same signature, same trigger): the conductor folding 0013 and 0014
-- keeps the LATER definition of payout_guard, refund_guard, payout_destination_guard, ledger_entry_insert_guard, ledger_entry_change_guard,
-- store_step_up_proof_guard, transfer_evidence_registry_guard, order_status_guard and the view platform_money_position. Review findings fixed here
-- (docs/tracks/t37b.md): P2-2 unknown transfer never re-claimed, rejection from processing and refund failure are four-eyes; P3-5 demo reset marker;
-- P3-6 (a) completed/returned only for platform roles, (b) approvals bound to payout/refund/adjustment, (c) the 72-hour hold in the database; P3-7 failed refunds stay visible.

-- approval_binds: does approval request <id> approve exactly this action on this target with a payload that contains the expected facts? The approver is a
-- second person, and the request is unexpired (or was consumed in THIS transaction by the same writer). Definer: the callers are definer guards.
CREATE OR REPLACE FUNCTION "approval_binds"(p_id bigint, p_action text, p_kind text, p_target text, p_expect jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.approval_request ar
   WHERE ar.id = p_id AND ar.action_key = p_action AND ar.target_kind = p_kind AND ar.target_id = p_target
     AND ar.decided_by IS NOT NULL AND ar.decided_by <> ar.requested_by
     AND ((ar.status = 'executed' AND ar.executed_at = pg_catalog.now()) OR (ar.status = 'approved' AND ar.expires_at > pg_catalog.now()))
     AND ar.payload_canonical::jsonb @> p_expect)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "approval_binds"(bigint, text, text, text, jsonb) FROM PUBLIC;--> statement-breakpoint

INSERT INTO "four_eyes_rule" ("action_key", "capability", "phase", "max_validity", "active") VALUES
  ('payout.reject_processing', 'payouts.process', 'P1', interval '24 hours', true),
  ('refund.fail', 'refunds.process', 'P1', interval '24 hours', true)
ON CONFLICT ("action_key") DO NOTHING;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "payout_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  d public.payout_destination%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.ledger_reset', true) = 'demo' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payouts are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' OR NEW.approval_request_id IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.claimed_by_user_id IS NOT NULL OR NEW.transfer_unknown_at IS NOT NULL
       OR NEW.transfer_evidence_ref IS NOT NULL OR NEW.evidence_artifact_id IS NOT NULL OR NEW.processed_at IS NOT NULL OR NEW.rejection_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a payout starts requested and empty' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO d FROM public.payout_destination WHERE store_id = NEW.store_id AND id = NEW.destination_id;
    IF d.id IS NULL OR d.status <> 'active' OR (d.hold_until IS NOT NULL AND d.hold_until > pg_catalog.now()) THEN
      RAISE EXCEPTION 'a payout needs an active destination whose hold has elapsed' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.bank_code, NEW.bank_account_number, NEW.bank_account_holder, NEW.holder_name_check) IS DISTINCT FROM (d.bank_code, d.account_number, d.account_holder_name, d.holder_name_check) THEN
      RAISE EXCEPTION 'the payout snapshot equals its destination' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.store_step_up_proof pr WHERE pr.id = NEW.step_up_ref AND pr.store_id = NEW.store_id AND pr.user_id = NEW.requested_by_user_id
                   AND pr.action_key = 'payout.request' AND pr.consumed_at = pg_catalog.now()) THEN
      RAISE EXCEPTION 'a payout request needs a step-up proof consumed in this transaction' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.store_id, NEW.requested_by_user_id, NEW.request_key, NEW.step_up_ref, NEW.amount_idr, NEW.destination_id, NEW.bank_code, NEW.bank_account_number, NEW.bank_account_holder, NEW.holder_name_check, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.store_id, OLD.requested_by_user_id, OLD.request_key, OLD.step_up_ref, OLD.amount_idr, OLD.destination_id, OLD.bank_code, OLD.bank_account_number, OLD.bank_account_holder, OLD.holder_name_check, OLD.created_at) THEN
    RAISE EXCEPTION 'the request and bank snapshot of a payout are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('paid', 'rejected') THEN
    RAISE EXCEPTION 'a paid or rejected payout never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'requested' AND NEW.status IN ('processing', 'rejected')) OR (OLD.status = 'processing' AND NEW.status IN ('paid', 'rejected'))) THEN
    RAISE EXCEPTION 'illegal payout move % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.approval_request_id IS NOT NULL AND NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id THEN
    RAISE EXCEPTION 'the approval of a payout is written once' USING ERRCODE = 'check_violation';
  END IF;
  -- T-37 finish: the move to processing needs an approval request that really approves THIS payout: the right action, this target, a second person,
  -- unexpired (or consumed in this very transaction), and a payload that names this payout, amount and bank snapshot.
  IF NEW.status = 'processing' AND OLD.status = 'requested' THEN
    IF NEW.approval_request_id IS NULL OR NOT public.approval_binds(NEW.approval_request_id, 'payout.approve_transfer', 'payout', NEW.id::text,
         pg_catalog.jsonb_build_object('kind', 'payout', 'payoutId', NEW.id, 'storeId', NEW.store_id, 'amountIdr', NEW.amount_idr, 'bankCode', NEW.bank_code, 'bankAccountNumber', NEW.bank_account_number, 'bankAccountHolder', NEW.bank_account_holder)) THEN
      RAISE EXCEPTION 'a payout moves to processing only with the second person''s approval of exactly this payout' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- A rejection out of processing says "no transfer was sent": a second person approves exactly that statement (reason and normalised bank evidence reference).
  IF NEW.status = 'rejected' AND OLD.status = 'processing' THEN
    IF NEW.no_transfer_evidence_ref IS NULL OR NEW.reject_approval_request_id IS NULL OR NOT public.approval_binds(NEW.reject_approval_request_id, 'payout.reject_processing', 'payout', NEW.id::text,
         pg_catalog.jsonb_build_object('decision', 'reject_processing', 'payoutId', NEW.id, 'storeId', NEW.store_id, 'amountIdr', NEW.amount_idr, 'reason', NEW.rejection_reason,
           'noTransferEvidenceNorm', pg_catalog.regexp_replace(pg_catalog.lower(NEW.no_transfer_evidence_ref), '[^a-z0-9]', '', 'g'))) THEN
      RAISE EXCEPTION 'a payout in processing is rejected only with a second person''s approval of the no-transfer statement' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.reject_approval_request_id IS DISTINCT FROM OLD.reject_approval_request_id AND (OLD.reject_approval_request_id IS NOT NULL OR NOT (NEW.status = 'rejected' AND OLD.status = 'processing')) THEN
    RAISE EXCEPTION 'the rejection approval of a payout is written once, at the rejection' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'processing' AND OLD.status = 'requested' AND (NEW.claimed_by_user_id IS NOT NULL OR NEW.transfer_unknown_at IS NOT NULL) THEN
    RAISE EXCEPTION 'approval and claim are separate steps' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.claimed_by_user_id IS DISTINCT FROM OLD.claimed_by_user_id AND NEW.claimed_by_user_id IS NOT NULL AND OLD.status = 'processing'
     AND OLD.claimed_by_user_id IS NOT NULL AND OLD.claim_expires_at > pg_catalog.now() AND OLD.claimed_by_user_id <> NEW.claimed_by_user_id THEN
    RAISE EXCEPTION 'PAYOUT_ALREADY_CLAIMED' USING ERRCODE = 'lock_not_available';
  END IF;
  IF OLD.transfer_unknown_at IS NOT NULL AND NEW.status = 'processing' AND (NEW.claimed_by_user_id IS DISTINCT FROM OLD.claimed_by_user_id OR NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at) THEN
    RAISE EXCEPTION 'an unknown transfer outcome is never claimed again: it is only settled by evidence' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.transfer_unknown_at IS NOT NULL AND NEW.transfer_unknown_at IS NULL AND NEW.status = 'processing' THEN
    RAISE EXCEPTION 'an unknown transfer outcome stays until a final decision' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'paid' AND (OLD.claimed_by_user_id IS NULL OR (OLD.claim_expires_at <= pg_catalog.now() AND OLD.transfer_unknown_at IS NULL) OR OLD.claimed_by_user_id <> NEW.processed_by_user_id) THEN
    RAISE EXCEPTION 'a payout is marked paid only by the operator holding a live claim (or the one who reported its outcome unknown)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "refund_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  o public."order"%ROWTYPE;
  f public.order_financials%ROWTYPE;
  a public.payment_attempt%ROWTYPE;
  v_app boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.ledger_reset', true) = 'demo' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'refunds are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_app := NOT (pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER'));
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO o FROM public."order" WHERE store_id = NEW.store_id AND id = NEW.order_id;
    SELECT * INTO f FROM public.order_financials WHERE store_id = NEW.store_id AND order_id = NEW.order_id;
    SELECT * INTO a FROM public.payment_attempt WHERE store_id = NEW.store_id AND id = NEW.payment_attempt_id AND order_id = NEW.order_id;
    IF o.id IS NULL OR f.order_id IS NULL OR a.id IS NULL OR o.payment_method = 'cod' OR a.status <> 'paid' OR o.status NOT IN ('cancelled', 'returned') THEN
      RAISE EXCEPTION 'a refund needs a paid non-COD payment on a cancelled or returned order' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'pending' OR NEW.approval_request_id IS NOT NULL OR NEW.claimed_by_user_id IS NOT NULL OR NEW.transfer_evidence_ref IS NOT NULL THEN
      RAISE EXCEPTION 'a refund starts pending and empty' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.amount_idr <> a.total_idr OR NEW.goods_refund_idr <> f.goods_proceeds_idr + f.included_sales_tax_idr + f.added_sales_tax_idr OR NEW.shipping_refund_idr <> f.shipping_charged_idr OR NEW.fee_refund_idr <> a.admin_fee_idr THEN
      RAISE EXCEPTION 'the refund is the full payment: goods, shipping and the admin fee' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.store_id, NEW.order_id, NEW.payment_attempt_id, NEW.goods_refund_idr, NEW.shipping_refund_idr, NEW.fee_refund_idr, NEW.amount_idr, NEW.reason, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.store_id, OLD.order_id, OLD.payment_attempt_id, OLD.goods_refund_idr, OLD.shipping_refund_idr, OLD.fee_refund_idr, OLD.amount_idr, OLD.reason, OLD.created_at) THEN
    RAISE EXCEPTION 'the composition of a refund is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_app AND ((NEW.status, NEW.approval_request_id, NEW.approved_at, NEW.claimed_by_user_id, NEW.claim_expires_at, NEW.transfer_unknown_at, NEW.transfer_evidence_ref, NEW.evidence_artifact_id, NEW.no_transfer_evidence_ref, NEW.processed_by_user_id, NEW.failure_reason)
     IS DISTINCT FROM (OLD.status, OLD.approval_request_id, OLD.approved_at, OLD.claimed_by_user_id, OLD.claim_expires_at, OLD.transfer_unknown_at, OLD.transfer_evidence_ref, OLD.evidence_artifact_id, OLD.no_transfer_evidence_ref, OLD.processed_by_user_id, OLD.failure_reason)
     OR NEW.fail_approval_request_id IS DISTINCT FROM OLD.fail_approval_request_id) THEN
    RAISE EXCEPTION 'the buyer link can only submit the refund destination' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'a completed or failed refund never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('processing', 'failed')) OR (OLD.status = 'processing' AND NEW.status IN ('completed', 'failed'))) THEN
    RAISE EXCEPTION 'illegal refund move % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND (NEW.destination_bank, NEW.destination_account, NEW.destination_holder, NEW.destination_submitted_at) IS DISTINCT FROM (OLD.destination_bank, OLD.destination_account, OLD.destination_holder, OLD.destination_submitted_at) THEN
    RAISE EXCEPTION 'the refund destination is frozen once approved' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.approval_request_id IS NOT NULL AND NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id THEN
    RAISE EXCEPTION 'the approval of a refund is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.claimed_by_user_id IS DISTINCT FROM OLD.claimed_by_user_id AND NEW.claimed_by_user_id IS NOT NULL AND OLD.status = 'processing'
     AND OLD.claimed_by_user_id IS NOT NULL AND OLD.claim_expires_at > pg_catalog.now() AND OLD.claimed_by_user_id <> NEW.claimed_by_user_id THEN
    RAISE EXCEPTION 'REFUND_ALREADY_CLAIMED' USING ERRCODE = 'lock_not_available';
  END IF;
  IF NEW.status = 'processing' AND OLD.status = 'pending' THEN
    IF NEW.approval_request_id IS NULL OR NOT public.approval_binds(NEW.approval_request_id, 'refund.approve_transfer', 'refund', NEW.id::text,
         pg_catalog.jsonb_build_object('kind', 'refund', 'refundId', NEW.id, 'orderId', NEW.order_id, 'storeId', NEW.store_id, 'amountIdr', NEW.amount_idr, 'destinationBank', NEW.destination_bank, 'destinationAccount', NEW.destination_account, 'destinationHolder', NEW.destination_holder)) THEN
      RAISE EXCEPTION 'a refund moves to processing only with the second person''s approval of exactly this refund' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- T-37 finish: failing a refund leaves the buyer's money owed, so it is a four-eyes decision bound to the reason (and, out of processing, the normalised no-transfer evidence).
  IF NEW.status = 'failed' THEN
    IF NEW.fail_approval_request_id IS NULL OR NOT public.approval_binds(NEW.fail_approval_request_id, 'refund.fail', 'refund', NEW.id::text,
         pg_catalog.jsonb_build_object('decision', 'fail', 'refundId', NEW.id, 'storeId', NEW.store_id, 'amountIdr', NEW.amount_idr, 'reason', NEW.failure_reason,
           'noTransferEvidenceNorm', pg_catalog.regexp_replace(pg_catalog.lower(COALESCE(NEW.no_transfer_evidence_ref, '')), '[^a-z0-9]', '', 'g'))) THEN
      RAISE EXCEPTION 'a refund fails only with a second person''s approval of exactly that decision' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.fail_approval_request_id IS DISTINCT FROM OLD.fail_approval_request_id AND (OLD.fail_approval_request_id IS NOT NULL OR NEW.status <> 'failed') THEN
    RAISE EXCEPTION 'the failure approval of a refund is written once, at the failure' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.transfer_unknown_at IS NOT NULL AND NEW.status = 'processing' AND (NEW.claimed_by_user_id IS DISTINCT FROM OLD.claimed_by_user_id OR NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at) THEN
    RAISE EXCEPTION 'an unknown transfer outcome is never claimed again: it is only settled by evidence' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.transfer_unknown_at IS NOT NULL AND NEW.transfer_unknown_at IS NULL AND NEW.status = 'processing' THEN
    RAISE EXCEPTION 'an unknown transfer outcome stays until a final decision' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'completed' AND (OLD.claimed_by_user_id IS NULL OR (OLD.claim_expires_at <= pg_catalog.now() AND OLD.transfer_unknown_at IS NULL) OR OLD.claimed_by_user_id <> NEW.processed_by_user_id) THEN
    RAISE EXCEPTION 'a refund is completed only by the operator holding a live claim (or the one who reported its outcome unknown)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'failed' AND OLD.status = 'processing' AND NEW.no_transfer_evidence_ref IS NULL THEN
    RAISE EXCEPTION 'a refund in processing fails only with evidence that no transfer was sent' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "payout_destination_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.ledger_reset', true) = 'demo' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payout destinations are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'held' OR NEW.hold_until IS NULL OR NEW.hold_until < pg_catalog.now() + pg_catalog.make_interval(hours => COALESCE((SELECT destination_hold_hours FROM public.payout_control WHERE id = 1), 72)) - pg_catalog.make_interval(mins => 1) THEN
      RAISE EXCEPTION 'a new payout destination is held for the full hold period (D-19)' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.store_step_up_proof pr WHERE pr.id = NEW.step_up_ref AND pr.store_id = NEW.store_id AND pr.user_id = NEW.created_by_user_id
                   AND pr.action_key = 'payout.destination' AND pr.consumed_at = pg_catalog.now()) THEN
      RAISE EXCEPTION 'a destination change needs a step-up proof consumed in this transaction' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.store_id, NEW.bank_code, NEW.account_number, NEW.account_holder_name, NEW.holder_name_check, NEW.hold_until, NEW.created_by_user_id, NEW.step_up_ref, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.store_id, OLD.bank_code, OLD.account_number, OLD.account_holder_name, OLD.holder_name_check, OLD.hold_until, OLD.created_by_user_id, OLD.step_up_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'a payout destination is never edited; a change is a new destination' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (OLD.status = NEW.status OR (OLD.status = 'held' AND NEW.status IN ('active', 'superseded')) OR (OLD.status = 'active' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'illegal destination move % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'active' AND OLD.status = 'held' AND OLD.hold_until > pg_catalog.now() THEN
    RAISE EXCEPTION 'the destination is still on hold' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.previous_contact_notified_at IS NOT NULL AND NEW.previous_contact_notified_at IS DISTINCT FROM OLD.previous_contact_notified_at THEN
    RAISE EXCEPTION 'the notification time is written once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "ledger_entry_insert_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_app boolean;
  o public."order"%ROWTYPE;
  f public.order_financials%ROWTYPE;
  s public.ledger_entry%ROWTYPE;
  d public.ledger_entry%ROWTYPE;
  p public.payout%ROWTYPE;
  v_avail bigint;
BEGIN
  v_app := NOT (pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER'));
  IF v_app AND NEW.kind NOT IN ('payout', 'return_reversal') THEN
    RAISE EXCEPTION 'the seller login can only debit its own balance (payout, return reversal)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('bukalaris.payout.store'), pg_catalog.hashtext(NEW.store_id::text));
  IF NEW.kind IN ('sale', 'cashback') AND NEW.status <> 'pending' THEN
    RAISE EXCEPTION 'a sale or cashback is booked pending and released later' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'available' AND NEW.release_basis <> 'direct' THEN
    RAISE EXCEPTION 'an entry born available carries release_basis direct' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.order_id IS NOT NULL THEN
    SELECT * INTO o FROM public."order" WHERE store_id = NEW.store_id AND id = NEW.order_id;
    SELECT * INTO f FROM public.order_financials WHERE store_id = NEW.store_id AND order_id = NEW.order_id;
    IF o.id IS NULL OR f.order_id IS NULL THEN
      RAISE EXCEPTION 'a ledger entry of an order needs the order and its financial snapshot' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.kind IN ('sale', 'cashback') THEN
    IF o.status IN ('cancelled', 'returned') THEN
      RAISE EXCEPTION 'nothing is credited for a cancelled or returned order' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'sale' AND NEW.amount_idr <> f.sale_amount_idr THEN
      RAISE EXCEPTION 'the sale equals sale_amount_idr of the financial snapshot' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'cashback' AND NEW.amount_idr <> f.seller_cashback_idr THEN
      RAISE EXCEPTION 'the cashback equals seller_cashback_idr of the financial snapshot' USING ERRCODE = 'check_violation';
    END IF;
    IF o.payment_method = 'cod' THEN
      IF o.status <> 'completed' THEN
        RAISE EXCEPTION 'a COD sale is booked only when the parcel is delivered' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF o.status NOT IN ('placed', 'processing', 'shipped', 'completed')
         OR NOT EXISTS (SELECT 1 FROM public.payment_attempt a WHERE a.store_id = NEW.store_id AND a.order_id = NEW.order_id AND a.status = 'paid') THEN
        RAISE EXCEPTION 'a prepaid sale is booked only for a verified payment on a live order' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW.kind = 'return_reversal' THEN
    IF o.status NOT IN ('cancelled', 'returned') THEN
      RAISE EXCEPTION 'a return reversal needs a cancelled or returned order' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO s FROM public.ledger_entry WHERE store_id = NEW.store_id AND order_id = NEW.order_id AND kind = 'sale' FOR UPDATE;
    IF s.id IS NULL OR s.status <> 'pending' OR NEW.amount_idr <> -s.amount_idr THEN
      RAISE EXCEPTION 'a return reversal is the exact opposite of a still-pending sale' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'shipping_debit' THEN
    IF NEW.status = 'pending' THEN
      SELECT * INTO s FROM public.ledger_entry WHERE store_id = NEW.store_id AND order_id = NEW.order_id AND kind = 'sale';
      IF o.payment_method <> 'cod' AND (s.id IS NULL OR s.status <> 'pending') THEN
        RAISE EXCEPTION 'a pending prepaid debit nets against its own pending sale' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW.kind = 'shipping_debit_reversal' THEN
    SELECT * INTO d FROM public.ledger_entry WHERE store_id = NEW.store_id AND order_id = NEW.order_id AND kind = 'shipping_debit';
    IF d.id IS NULL OR NEW.amount_idr <> -d.amount_idr OR NEW.status <> d.status THEN
      RAISE EXCEPTION 'a debit reversal is the exact opposite of its debit and takes its status' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'payout' THEN
    SELECT * INTO p FROM public.payout WHERE store_id = NEW.store_id AND id = NEW.payout_id;
    IF p.id IS NULL OR p.status <> 'requested' OR NEW.amount_idr <> -p.amount_idr OR NEW.status <> 'available' THEN
      RAISE EXCEPTION 'a payout entry debits exactly its requested payout and is born available' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'adjustment' THEN
    IF NEW.approval_request_id IS NULL OR NEW.business_ref IS NULL OR NOT public.approval_binds(NEW.approval_request_id, 'ledger.adjust', 'ledger_adjustment', NEW.store_id::text || ':' || NEW.business_ref,
         pg_catalog.jsonb_build_object('storeId', NEW.store_id, 'amountIdr', NEW.amount_idr, 'businessRef', NEW.business_ref)) THEN
      RAISE EXCEPTION 'an adjustment needs the second person''s approval of exactly this store, amount and business reference' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'payout_reversal' THEN
    SELECT * INTO p FROM public.payout WHERE store_id = NEW.store_id AND id = NEW.payout_id;
    SELECT * INTO d FROM public.ledger_entry WHERE store_id = NEW.store_id AND payout_id = NEW.payout_id AND kind = 'payout';
    IF p.id IS NULL OR p.status <> 'rejected' OR d.id IS NULL OR NEW.amount_idr <> -d.amount_idr OR NEW.status <> 'available' THEN
      RAISE EXCEPTION 'a payout reversal is the exact opposite of the debit of a rejected payout' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status = 'available' AND NEW.amount_idr < 0 THEN
    SELECT COALESCE(sum(amount_idr), 0) INTO v_avail FROM public.ledger_entry WHERE store_id = NEW.store_id AND status = 'available';
    IF v_avail + NEW.amount_idr < 0 THEN
      RAISE EXCEPTION 'the available balance would go negative' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "ledger_entry_change_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  o public."order"%ROWTYPE;
  s public.ledger_entry%ROWTYPE;
  i public.reconciliation_batch_item%ROWTYPE;
  b_status text;
  v_avail bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.ledger_reset', true) = 'demo' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'ledger_entry rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status <> 'available' THEN
    RAISE EXCEPTION 'the ledger is append-only: only a pending entry may be released' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.store_id, NEW.order_id, NEW.payout_id, NEW.kind, NEW.amount_idr, NEW.business_ref, NEW.approval_request_id, NEW.note, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.store_id, OLD.order_id, OLD.payout_id, OLD.kind, OLD.amount_idr, OLD.business_ref, OLD.approval_request_id, OLD.note, OLD.created_at) THEN
    RAISE EXCEPTION 'a release changes only status, released_at, release_basis and reconciliation_item_id' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.release_basis IS NULL OR NEW.release_basis = 'direct' THEN
    RAISE EXCEPTION 'a release names its basis (delivery, reconciliation or netting)' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('bukalaris.payout.store'), pg_catalog.hashtext(NEW.store_id::text));
  SELECT * INTO o FROM public."order" WHERE store_id = NEW.store_id AND id = NEW.order_id;
  IF o.id IS NULL THEN
    RAISE EXCEPTION 'a released entry belongs to an order' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind IN ('sale', 'cashback') THEN
    IF EXISTS (SELECT 1 FROM public.ledger_entry r WHERE r.store_id = NEW.store_id AND r.order_id = NEW.order_id AND r.kind = 'return_reversal') THEN
      RAISE EXCEPTION 'a reversed order is never released' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.release_basis = 'delivery' THEN
      IF o.payment_method = 'cod' OR o.status <> 'completed' THEN
        RAISE EXCEPTION 'delivery releases a prepaid sale of a completed order only' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.release_basis = 'reconciliation' THEN
      SELECT * INTO i FROM public.reconciliation_batch_item WHERE id = NEW.reconciliation_item_id AND store_id = NEW.store_id;
      IF o.payment_method <> 'cod' OR o.status <> 'completed' OR i.id IS NULL OR i.order_id <> NEW.order_id OR i.voided_at IS NOT NULL OR i.reconciled_at IS NULL THEN
        RAISE EXCEPTION 'a COD release needs an applied reconciliation item of this order' USING ERRCODE = 'check_violation';
      END IF;
      SELECT status INTO b_status FROM public.reconciliation_batch WHERE id = i.batch_id;
      IF b_status IS DISTINCT FROM 'applied' THEN
        RAISE EXCEPTION 'the reconciliation batch is not applied' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'a sale or cashback is released by delivery or reconciliation only' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind IN ('shipping_debit', 'shipping_debit_reversal') THEN
    IF NEW.release_basis = 'netting' THEN
      SELECT * INTO s FROM public.ledger_entry WHERE store_id = NEW.store_id AND order_id = NEW.order_id AND kind = 'sale';
      IF NOT ((o.status IN ('cancelled', 'returned') AND (s.id IS NULL OR EXISTS (SELECT 1 FROM public.ledger_entry r WHERE r.store_id = NEW.store_id AND r.order_id = NEW.order_id AND r.kind = 'return_reversal')))
              OR (o.status = 'completed' AND s.id IS NOT NULL AND s.status = 'available')) THEN
        RAISE EXCEPTION 'only the debit of a parcel that earned no sale, or the debit its released sale could not cover, is netted' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT * INTO s FROM public.ledger_entry WHERE store_id = NEW.store_id AND order_id = NEW.order_id AND kind = 'sale';
      IF s.id IS NULL OR s.status <> 'available' OR s.release_basis IS DISTINCT FROM NEW.release_basis OR s.reconciliation_item_id IS DISTINCT FROM NEW.reconciliation_item_id THEN
        RAISE EXCEPTION 'a debit is released together with its own released sale' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'this entry kind is never pending' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_idr < 0 THEN
    SELECT COALESCE(sum(amount_idr), 0) INTO v_avail FROM public.ledger_entry WHERE store_id = NEW.store_id AND status = 'available';
    IF v_avail + NEW.amount_idr < 0 THEN
      RAISE EXCEPTION 'the available balance would go negative' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- P3-5: the demo reset marker is honoured by the two evidence guards that refused every DELETE.
CREATE OR REPLACE FUNCTION "store_step_up_proof_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.ledger_reset', true) = 'demo' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'step-up proofs are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."consumed_at" IS NOT NULL OR NEW."consumed_at" IS NULL OR NEW."consumed_at" <> pg_catalog.now()
     OR (NEW."id", NEW."store_id", NEW."user_id", NEW."session_id", NEW."action_key", NEW."subject_kind", NEW."subject_id", NEW."created_at", NEW."expires_at")
        IS DISTINCT FROM (OLD."id", OLD."store_id", OLD."user_id", OLD."session_id", OLD."action_key", OLD."subject_kind", OLD."subject_id", OLD."created_at", OLD."expires_at") THEN
    RAISE EXCEPTION 'a step-up proof is consumed once, as it stands' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."expires_at" <= pg_catalog.now() THEN
    RAISE EXCEPTION 'the step-up proof has expired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "transfer_evidence_registry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.current_setting('bukalaris.ledger_reset', true) = 'demo' THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the transfer evidence registry is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."norm_ref" := pg_catalog.regexp_replace(pg_catalog.lower(NEW."ref_raw"), '[^a-z0-9]', '', 'g');
  IF pg_catalog.length(NEW."norm_ref") < 6 THEN
    RAISE EXCEPTION 'a transfer reference needs at least 6 letters or digits' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- P3-6 (a): completed and returned are written by the courier writer (platform) or the four-eyes manual completion (platform); a seller login cannot move an order there.
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
    (OLD."status" = 'shipped' AND NEW."status" IN ('completed', 'returned', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'order status % -> % is not a legal move', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('completed', 'returned') AND NOT (pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER')) THEN
    RAISE EXCEPTION 'only the courier writer or an approved manual completion moves an order to % (the seller login cannot)', NEW."status" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- P3-7: a failed refund is still owed to the buyer until a new refund is opened for the order: it stays visible as its own liability class.
CREATE OR REPLACE VIEW "platform_money_position" WITH (security_invoker = true) AS
SELECT 'seller_pending'::text AS class, COALESCE(sum(amount_idr), 0)::bigint AS amount_idr FROM public.ledger_entry WHERE status = 'pending'
UNION ALL SELECT 'seller_available', COALESCE(sum(amount_idr), 0)::bigint FROM public.ledger_entry WHERE status = 'available'
UNION ALL SELECT 'payouts_requested', COALESCE(sum(amount_idr), 0)::bigint FROM public.payout WHERE status = 'requested'
UNION ALL SELECT 'payouts_processing', COALESCE(sum(amount_idr), 0)::bigint FROM public.payout WHERE status = 'processing'
UNION ALL SELECT 'refunds_open', COALESCE(sum(amount_idr), 0)::bigint FROM public.refund WHERE status IN ('pending', 'processing')
UNION ALL SELECT 'platform_shipping_margin', COALESCE(sum(platform_shipping_margin_idr), 0)::bigint FROM public.shipment_cost
UNION ALL SELECT 'platform_shipping_cashback', COALESCE(sum(platform_cashback_idr), 0)::bigint FROM public.order_financials
UNION ALL SELECT 'platform_cod_fee', COALESCE(sum(cod_fee_idr), 0)::bigint FROM public.order_financials
UNION ALL SELECT 'platform_cod_fee_vat', COALESCE(sum(cod_fee_vat_idr), 0)::bigint FROM public.order_financials
UNION ALL SELECT 'platform_payment_fee_margin', COALESCE(sum(admin_fee_idr - provider_fee_idr), 0)::bigint FROM public.payment_attempt WHERE status = 'paid' AND provider_fee_idr IS NOT NULL
UNION ALL SELECT 'refunds_failed', COALESCE(sum(r.amount_idr), 0)::bigint FROM public.refund r WHERE r.status = 'failed' AND NOT EXISTS (SELECT 1 FROM public.refund n WHERE n.store_id = r.store_id AND n.order_id = r.order_id AND n.status <> 'failed');--> statement-breakpoint

-- ===== T-37 finish: post-restore payout freeze (hand-written) =====
-- Hand-written: drizzle-kit models neither grants, triggers nor seed rows. The generated statement above is untouched. The singleton row is seeded
-- UNFROZEN; the guard below FAILS CLOSED when the row is missing. One SECURITY DEFINER guard (pinned search_path, schema-qualified names, registry kind
-- `guard`, no execute grant) serves three triggers, so a caller that forgets the service-level check still cannot move money while the switch is on:
--   payout:                INSERT (a seller request) and any change of status or claim (approve for transfer, claim, paid, rejected)
--   refund:                any change of status or claim (the buyer's destination columns and an operator's "outcome unknown" note stay possible)
--   reconciliation_batch:  the move to `applied` (a COD release)
INSERT INTO "payout_control" ("id", "frozen", "reason", "changed_by") VALUES (1, false, 'initial', 'system:migration');--> statement-breakpoint
REVOKE ALL ON "payout_control" FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "payout_control" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, UPDATE ON "payout_control" TO bukalaris_platform;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payout_control_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'the payout control row is never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payout_control_guard" ON "payout_control";--> statement-breakpoint
CREATE TRIGGER "payout_control_guard" BEFORE DELETE ON "payout_control" FOR EACH ROW EXECUTE FUNCTION "payout_control_guard"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payout_freeze_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_frozen boolean;
  v_blocked boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'payout' THEN
    v_blocked := TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.claimed_by_user_id IS DISTINCT FROM OLD.claimed_by_user_id OR NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at));
  ELSIF TG_TABLE_NAME = 'refund' THEN
    v_blocked := TG_OP = 'UPDATE' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.claimed_by_user_id IS DISTINCT FROM OLD.claimed_by_user_id OR NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at);
  ELSIF TG_TABLE_NAME = 'reconciliation_batch' THEN
    v_blocked := TG_OP = 'UPDATE' AND NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied';
  END IF;
  IF NOT v_blocked THEN RETURN NEW; END IF;
  SELECT frozen INTO v_frozen FROM public.payout_control WHERE id = 1;
  IF v_frozen IS NULL OR v_frozen THEN
    RAISE EXCEPTION 'payouts_frozen' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "payout_freeze_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payout_freeze_guard" ON "payout";--> statement-breakpoint
CREATE TRIGGER "payout_freeze_guard" BEFORE INSERT OR UPDATE ON "payout" FOR EACH ROW EXECUTE FUNCTION "payout_freeze_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "payout_freeze_guard" ON "refund";--> statement-breakpoint
CREATE TRIGGER "payout_freeze_guard" BEFORE UPDATE ON "refund" FOR EACH ROW EXECUTE FUNCTION "payout_freeze_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "payout_freeze_guard" ON "reconciliation_batch";--> statement-breakpoint
CREATE TRIGGER "payout_freeze_guard" BEFORE UPDATE ON "reconciliation_batch" FOR EACH ROW EXECUTE FUNCTION "payout_freeze_guard"();
