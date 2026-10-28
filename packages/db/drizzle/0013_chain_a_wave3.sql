CREATE TABLE "access_review_decision" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "access_review_decision_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"reviewer_user_id" text NOT NULL,
	"operator_user_id" text NOT NULL,
	"capability" text NOT NULL,
	"decision" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"grant_created_at" timestamp with time zone,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_review_decision_chk" CHECK ("access_review_decision"."decision" in ('confirmed', 'revoked')),
	CONSTRAINT "access_review_reason_chk" CHECK (length(btrim("access_review_decision"."reason")) between 5 and 500),
	CONSTRAINT "access_review_self_chk" CHECK ("access_review_decision"."reviewer_user_id" <> "access_review_decision"."operator_user_id")
);
--> statement-breakpoint
CREATE TABLE "account_status_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_status_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_note" text,
	"actor_user_id" text,
	"case_id" bigint,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_status_event_kind_chk" CHECK ("account_status_event"."subject_kind" in ('store', 'user', 'affiliate', 'buyer')),
	CONSTRAINT "account_status_event_reason_chk" CHECK ("account_status_event"."reason_code" ~ '^[a-z][a-z0-9_.-]{1,63}$'),
	CONSTRAINT "account_status_event_change_chk" CHECK ("account_status_event"."from_status" is distinct from "account_status_event"."to_status")
);
--> statement-breakpoint
CREATE TABLE "account_verification" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_verification_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subject_kind" text NOT NULL,
	"subject_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"submitted_by" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewer_user_id" text,
	"decided_at" timestamp with time zone,
	"decision_reason_code" text,
	"expires_at" timestamp with time zone,
	"evidence_ref" text,
	"verified_name" text,
	"contact_email" text,
	"contact_phone" text,
	"contact_confirmed_at" timestamp with time zone,
	"registration_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_verification_status_chk" CHECK ("account_verification"."status" in ('not_started', 'submitted', 'in_review', 'verified', 'rejected', 'expired', 'revoked')),
	CONSTRAINT "account_verification_version_chk" CHECK ("account_verification"."version" >= 1),
	CONSTRAINT "account_verification_decision_chk" CHECK (("account_verification"."status" not in ('verified', 'rejected', 'revoked')) or ("account_verification"."reviewer_user_id" is not null and "account_verification"."decided_at" is not null and "account_verification"."decision_reason_code" is not null)),
	CONSTRAINT "account_verification_evidence_chk" CHECK ("account_verification"."evidence_ref" is null or "account_verification"."evidence_ref" ~ '^[A-Za-z0-9_.:/-]{1,120}$')
);
--> statement-breakpoint
CREATE TABLE "store_risk_ack" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "store_risk_ack_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_ref" bigint NOT NULL,
	"flag_key" text NOT NULL,
	"acknowledged_by" text NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_risk_ack_flag_chk" CHECK ("store_risk_ack"."flag_key" ~ '^[a-z][a-z0-9_.-]{1,63}$'),
	CONSTRAINT "store_risk_ack_reason_chk" CHECK (length(btrim("store_risk_ack"."reason")) between 5 and 500),
	CONSTRAINT "store_risk_ack_expiry_chk" CHECK ("store_risk_ack"."expires_at" > "store_risk_ack"."created_at")
);
--> statement-breakpoint
CREATE TABLE "support_action" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "support_action_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"case_id" bigint,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"action_kind" text NOT NULL,
	"action_key" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" text NOT NULL,
	"approval_request_id" bigint,
	"idempotency_key" text NOT NULL,
	"reason_code" text NOT NULL,
	"executed_at" timestamp with time zone,
	"result_code" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_action_kind_chk" CHECK ("support_action"."action_kind" in ('resend_verification', 'revoke_sessions', 'reset_mfa', 'start_recovery', 'suspend', 'reinstate', 'request_merge', 'execute_merge', 'recover_ownership', 'start_export', 'close_account')),
	CONSTRAINT "support_action_status_chk" CHECK ("support_action"."status" in ('requested', 'awaiting_approval', 'approved', 'executed', 'failed', 'cancelled')),
	CONSTRAINT "support_action_subject_kind_chk" CHECK ("support_action"."subject_kind" in ('store', 'user', 'affiliate', 'buyer')),
	CONSTRAINT "support_action_executed_chk" CHECK (("support_action"."status" = 'executed') = ("support_action"."executed_at" is not null)),
	CONSTRAINT "support_action_key_chk" CHECK ("support_action"."action_key" is null or "support_action"."status" not in ('approved', 'executed') or "support_action"."approval_request_id" is not null),
	CONSTRAINT "support_action_idem_chk" CHECK (length("support_action"."idempotency_key") between 8 and 128)
);
--> statement-breakpoint
CREATE TABLE "support_case" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "support_case_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"case_number" text GENERATED ALWAYS AS ('C-' || lpad(id::text, 6, '0')) STORED,
	"kind" text DEFAULT 'support' NOT NULL,
	"subject_kind" text,
	"subject_id" text,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee_user_id" text,
	"opened_by_user_id" text NOT NULL,
	"source" text DEFAULT 'operator' NOT NULL,
	"due_at" timestamp with time zone,
	"resolution_code" text,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_case_kind_chk" CHECK ("support_case"."kind" in ('support', 'verification', 'risk', 'merge_request', 'tax_correction')),
	CONSTRAINT "support_case_status_chk" CHECK ("support_case"."status" in ('open', 'in_progress', 'waiting', 'resolved', 'closed')),
	CONSTRAINT "support_case_priority_chk" CHECK ("support_case"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "support_case_source_chk" CHECK ("support_case"."source" in ('operator', 'system', 'payee_request', 'external')),
	CONSTRAINT "support_case_subject_chk" CHECK (("support_case"."subject_kind" is null) = ("support_case"."subject_id" is null)),
	CONSTRAINT "support_case_title_chk" CHECK (length(btrim("support_case"."title")) between 1 and 200),
	CONSTRAINT "support_case_closed_chk" CHECK ("support_case"."status" <> 'closed' or "support_case"."resolved_at" is not null),
	CONSTRAINT "support_case_resolved_chk" CHECK ("support_case"."status" not in ('resolved', 'closed') or ("support_case"."resolved_at" is not null and "support_case"."resolution_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "support_case_note" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "support_case_note_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"case_id" bigint NOT NULL,
	"author_user_id" text NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_case_note_body_chk" CHECK (length(btrim("support_case_note"."body")) between 1 and 2000),
	CONSTRAINT "support_case_note_kind_chk" CHECK ("support_case_note"."kind" in ('note', 'system'))
);
--> statement-breakpoint
CREATE TABLE "support_recovery_link" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "support_recovery_link_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_sha256" text NOT NULL,
	"user_id" text NOT NULL,
	"support_action_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_recovery_link_token_chk" CHECK ("support_recovery_link"."token_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "support_recovery_link_expiry_chk" CHECK ("support_recovery_link"."expires_at" > "support_recovery_link"."created_at")
);
--> statement-breakpoint
CREATE TABLE "courier_service_policy" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "courier_service_policy_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"courier_code" text NOT NULL,
	"service_code" text DEFAULT '' NOT NULL,
	"cod_allowed" boolean DEFAULT false NOT NULL,
	"return_free" boolean DEFAULT false NOT NULL,
	"return_free_evidence_ref" text,
	"status" text DEFAULT 'active' NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_service_policy_uq" UNIQUE("courier_code","service_code"),
	CONSTRAINT "courier_service_policy_status_chk" CHECK ("courier_service_policy"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "ledger_entry" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entry_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"order_id" bigint,
	"payout_id" bigint,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"amount_idr" bigint NOT NULL,
	"business_ref" text,
	"approval_request_id" bigint,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_basis" text,
	"reconciliation_item_id" bigint,
	CONSTRAINT "ledger_entry_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "ledger_kind_chk" CHECK ("ledger_entry"."kind" in ('sale', 'cashback', 'shipping_debit', 'shipping_debit_reversal', 'return_reversal', 'payout', 'payout_reversal', 'adjustment') and "ledger_entry"."status" in ('pending', 'available')),
	CONSTRAINT "ledger_sign_chk" CHECK (("ledger_entry"."kind" in ('sale', 'cashback', 'shipping_debit_reversal', 'payout_reversal') and "ledger_entry"."amount_idr" > 0) or ("ledger_entry"."kind" in ('shipping_debit', 'return_reversal', 'payout') and "ledger_entry"."amount_idr" < 0) or ("ledger_entry"."kind" = 'adjustment' and "ledger_entry"."amount_idr" <> 0)),
	CONSTRAINT "ledger_refs_chk" CHECK (("ledger_entry"."kind" in ('payout', 'payout_reversal')) = ("ledger_entry"."payout_id" is not null) and ("ledger_entry"."kind" in ('sale', 'cashback', 'shipping_debit', 'shipping_debit_reversal', 'return_reversal')) = ("ledger_entry"."order_id" is not null) and ("ledger_entry"."kind" <> 'adjustment' or ("ledger_entry"."business_ref" is not null and "ledger_entry"."approval_request_id" is not null and "ledger_entry"."order_id" is null and "ledger_entry"."payout_id" is null))),
	CONSTRAINT "ledger_release_chk" CHECK (("ledger_entry"."status" = 'pending' and "ledger_entry"."released_at" is null and "ledger_entry"."release_basis" is null and "ledger_entry"."reconciliation_item_id" is null) or ("ledger_entry"."status" = 'available' and "ledger_entry"."released_at" is not null and "ledger_entry"."release_basis" is not null)),
	CONSTRAINT "ledger_basis_chk" CHECK ("ledger_entry"."release_basis" is null or "ledger_entry"."release_basis" in ('delivery', 'reconciliation', 'netting', 'direct')),
	CONSTRAINT "ledger_basis_kind_chk" CHECK ("ledger_entry"."release_basis" is null or ("ledger_entry"."release_basis" in ('delivery', 'reconciliation') and "ledger_entry"."kind" in ('sale', 'cashback', 'shipping_debit', 'shipping_debit_reversal')) or ("ledger_entry"."release_basis" = 'netting' and "ledger_entry"."kind" in ('shipping_debit', 'shipping_debit_reversal')) or ("ledger_entry"."release_basis" = 'direct' and "ledger_entry"."kind" not in ('sale', 'cashback'))),
	CONSTRAINT "ledger_item_chk" CHECK (("ledger_entry"."release_basis" = 'reconciliation') = ("ledger_entry"."reconciliation_item_id" is not null)),
	CONSTRAINT "ledger_pending_kind_chk" CHECK ("ledger_entry"."status" = 'available' or "ledger_entry"."kind" in ('sale', 'cashback', 'shipping_debit', 'shipping_debit_reversal', 'return_reversal')),
	CONSTRAINT "ledger_note_chk" CHECK ("ledger_entry"."note" is null or length("ledger_entry"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "order_financials" (
	"order_id" bigint PRIMARY KEY NOT NULL,
	"store_id" bigint NOT NULL,
	"subtotal_idr" bigint NOT NULL,
	"goods_discount_idr" bigint DEFAULT 0 NOT NULL,
	"shipping_discount_idr" bigint DEFAULT 0 NOT NULL,
	"included_sales_tax_idr" bigint DEFAULT 0 NOT NULL,
	"added_sales_tax_idr" bigint DEFAULT 0 NOT NULL,
	"goods_proceeds_idr" bigint NOT NULL,
	"shipping_charged_idr" bigint NOT NULL,
	"shipping_cashback_gross_idr" bigint DEFAULT 0 NOT NULL,
	"platform_cashback_idr" bigint DEFAULT 0 NOT NULL,
	"seller_cashback_idr" bigint DEFAULT 0 NOT NULL,
	"affiliate_commission_idr" bigint DEFAULT 0 NOT NULL,
	"cod_fee_idr" bigint DEFAULT 0 NOT NULL,
	"cod_fee_vat_idr" bigint DEFAULT 0 NOT NULL,
	"cod_fee_vat_rate_bps" integer,
	"cod_fee_vat_policy_version_id" bigint,
	"payable_idr" bigint NOT NULL,
	"sale_amount_idr" bigint NOT NULL,
	"expected_gateway_fee_idr" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_financials_store_order_uq" UNIQUE("store_id","order_id"),
	CONSTRAINT "order_financials_amounts_chk" CHECK ("order_financials"."subtotal_idr" >= 0 and "order_financials"."goods_discount_idr" >= 0 and "order_financials"."shipping_discount_idr" >= 0 and "order_financials"."included_sales_tax_idr" >= 0 and "order_financials"."added_sales_tax_idr" >= 0 and "order_financials"."goods_proceeds_idr" >= 0 and "order_financials"."shipping_charged_idr" >= 0 and "order_financials"."shipping_cashback_gross_idr" >= 0 and "order_financials"."platform_cashback_idr" >= 0 and "order_financials"."seller_cashback_idr" >= 0 and "order_financials"."affiliate_commission_idr" >= 0 and "order_financials"."cod_fee_idr" >= 0 and "order_financials"."cod_fee_vat_idr" >= 0 and "order_financials"."payable_idr" >= 0 and "order_financials"."sale_amount_idr" >= 0 and "order_financials"."expected_gateway_fee_idr" >= 0),
	CONSTRAINT "order_financials_cashback_chk" CHECK ("order_financials"."shipping_cashback_gross_idr" = "order_financials"."platform_cashback_idr" + "order_financials"."seller_cashback_idr"),
	CONSTRAINT "order_financials_payable_chk" CHECK ("order_financials"."payable_idr" = "order_financials"."goods_proceeds_idr" + "order_financials"."included_sales_tax_idr" + "order_financials"."added_sales_tax_idr" + "order_financials"."shipping_charged_idr" + "order_financials"."cod_fee_idr" + "order_financials"."cod_fee_vat_idr"),
	CONSTRAINT "order_financials_sale_chk" CHECK ("order_financials"."sale_amount_idr" = "order_financials"."goods_proceeds_idr" + "order_financials"."included_sales_tax_idr" + "order_financials"."added_sales_tax_idr" - "order_financials"."affiliate_commission_idr"),
	CONSTRAINT "order_financials_distribution_chk" CHECK ("order_financials"."payable_idr" = "order_financials"."sale_amount_idr" + "order_financials"."affiliate_commission_idr" + "order_financials"."shipping_charged_idr" + "order_financials"."cod_fee_idr" + "order_financials"."cod_fee_vat_idr"),
	CONSTRAINT "order_financials_vat_chk" CHECK ("order_financials"."cod_fee_vat_policy_version_id" is not null or ("order_financials"."cod_fee_vat_idr" = 0 and "order_financials"."cod_fee_vat_rate_bps" is null))
);
--> statement-breakpoint
CREATE TABLE "order_line_financials" (
	"order_id" bigint NOT NULL,
	"line_no" integer NOT NULL,
	"store_id" bigint NOT NULL,
	"variant_id" bigint NOT NULL,
	"line_gross_idr" bigint NOT NULL,
	"discount_alloc_idr" bigint NOT NULL,
	"net_goods_idr" bigint NOT NULL,
	"included_tax_idr" bigint NOT NULL,
	"added_tax_idr" bigint NOT NULL,
	"commission_base_idr" bigint NOT NULL,
	"commission_rate_bps" integer,
	CONSTRAINT "order_line_financials_order_id_line_no_pk" PRIMARY KEY("order_id","line_no"),
	CONSTRAINT "order_line_financials_chk" CHECK ("order_line_financials"."line_no" >= 1 and "order_line_financials"."discount_alloc_idr" >= 0 and "order_line_financials"."discount_alloc_idr" <= "order_line_financials"."line_gross_idr" and "order_line_financials"."net_goods_idr" = "order_line_financials"."line_gross_idr" - "order_line_financials"."discount_alloc_idr" and "order_line_financials"."included_tax_idr" >= 0 and "order_line_financials"."included_tax_idr" <= "order_line_financials"."net_goods_idr" and "order_line_financials"."added_tax_idr" >= 0 and "order_line_financials"."commission_base_idr" = "order_line_financials"."net_goods_idr" - "order_line_financials"."included_tax_idr")
);
--> statement-breakpoint
CREATE TABLE "payout" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payout_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"request_key" text NOT NULL,
	"step_up_ref" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"destination_id" bigint NOT NULL,
	"bank_code" text NOT NULL,
	"bank_account_number" text NOT NULL,
	"bank_account_holder" text NOT NULL,
	"holder_name_check" text NOT NULL,
	"approval_request_id" bigint,
	"approved_at" timestamp with time zone,
	"claimed_by_user_id" text,
	"claim_expires_at" timestamp with time zone,
	"transfer_unknown_at" timestamp with time zone,
	"transfer_evidence_ref" text,
	"evidence_artifact_id" bigint,
	"no_transfer_evidence_ref" text,
	"processed_by_user_id" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "payout_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "payout_request_key_uq" UNIQUE("store_id","request_key"),
	CONSTRAINT "payout_amount_chk" CHECK ("payout"."amount_idr" > 0 and "payout"."amount_idr" <= 9007199254740991),
	CONSTRAINT "payout_status_chk" CHECK ("payout"."status" in ('requested', 'processing', 'paid', 'rejected')),
	CONSTRAINT "payout_approval_chk" CHECK ("payout"."status" not in ('processing', 'paid') or ("payout"."approval_request_id" is not null and "payout"."approved_at" is not null)),
	CONSTRAINT "payout_paid_chk" CHECK ("payout"."status" <> 'paid' or ("payout"."transfer_evidence_ref" is not null and "payout"."evidence_artifact_id" is not null and "payout"."processed_by_user_id" is not null and "payout"."processed_at" is not null and "payout"."transfer_unknown_at" is null)),
	CONSTRAINT "payout_rejected_chk" CHECK ("payout"."status" <> 'rejected' or ("payout"."rejection_reason" is not null and "payout"."processed_at" is not null and ("payout"."approval_request_id" is null or "payout"."no_transfer_evidence_ref" is not null))),
	CONSTRAINT "payout_claim_chk" CHECK (("payout"."claimed_by_user_id" is null) = ("payout"."claim_expires_at" is null)),
	CONSTRAINT "payout_unknown_chk" CHECK ("payout"."transfer_unknown_at" is null or "payout"."status" = 'processing')
);
--> statement-breakpoint
CREATE TABLE "payout_destination" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payout_destination_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"bank_code" text NOT NULL,
	"account_number" text NOT NULL,
	"account_holder_name" text NOT NULL,
	"holder_name_check" text NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"hold_until" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"step_up_ref" uuid NOT NULL,
	"previous_contact_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "payout_destination_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "payout_destination_chk" CHECK ("payout_destination"."status" in ('held', 'active', 'superseded') and "payout_destination"."holder_name_check" in ('match', 'mismatch', 'unchecked') and ("payout_destination"."status" <> 'held' or "payout_destination"."hold_until" is not null) and ("payout_destination"."status" <> 'superseded') = ("payout_destination"."superseded_at" is null)),
	CONSTRAINT "payout_destination_fields_chk" CHECK (length(btrim("payout_destination"."bank_code")) > 0 and "payout_destination"."account_number" ~ '^[0-9]{5,24}$' and length(btrim("payout_destination"."account_holder_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_batch" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reconciliation_batch_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"status" text DEFAULT 'draft' NOT NULL,
	"source" text DEFAULT 'owner_batch' NOT NULL,
	"evidence_ref" text NOT NULL,
	"evidence_total_idr" bigint DEFAULT 0 NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"payload_sha256" text,
	"prepared_by_user_id" text,
	"approval_request_id" bigint,
	"approved_by_user_id" text,
	"applied_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_batch_status_chk" CHECK ("reconciliation_batch"."status" in ('draft', 'pending_approval', 'applied', 'void') and "reconciliation_batch"."source" in ('owner_batch', 'provider')),
	CONSTRAINT "reconciliation_batch_amounts_chk" CHECK ("reconciliation_batch"."evidence_total_idr" >= 0 and "reconciliation_batch"."item_count" >= 0 and length(btrim("reconciliation_batch"."evidence_ref")) > 0),
	CONSTRAINT "reconciliation_batch_applied_chk" CHECK ("reconciliation_batch"."status" <> 'applied' or ("reconciliation_batch"."approval_request_id" is not null and "reconciliation_batch"."applied_at" is not null and "reconciliation_batch"."payload_sha256" is not null and "reconciliation_batch"."item_count" > 0 and ("reconciliation_batch"."source" = 'provider' or ("reconciliation_batch"."approved_by_user_id" is not null and "reconciliation_batch"."prepared_by_user_id" is not null and "reconciliation_batch"."approved_by_user_id" <> "reconciliation_batch"."prepared_by_user_id")))),
	CONSTRAINT "reconciliation_batch_provider_chk" CHECK ("reconciliation_batch"."source" <> 'provider' or "reconciliation_batch"."prepared_by_user_id" is null),
	CONSTRAINT "reconciliation_batch_owner_chk" CHECK ("reconciliation_batch"."source" <> 'owner_batch' or "reconciliation_batch"."prepared_by_user_id" is not null),
	CONSTRAINT "reconciliation_batch_void_chk" CHECK (("reconciliation_batch"."status" = 'void') = ("reconciliation_batch"."void_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "reconciliation_batch_item" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reconciliation_batch_item_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"batch_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"store_id" bigint NOT NULL,
	"cod_amount_idr" bigint NOT NULL,
	"evidence_line_ref" text NOT NULL,
	"evidence_amount_idr" bigint NOT NULL,
	"evidence_date" date NOT NULL,
	"reconciled_at" timestamp with time zone,
	"reconciliation_source" text DEFAULT 'owner_batch' NOT NULL,
	"voided_at" timestamp with time zone,
	CONSTRAINT "reconciliation_item_batch_order_uq" UNIQUE("batch_id","order_id"),
	CONSTRAINT "reconciliation_item_id_store_uq" UNIQUE("id","store_id"),
	CONSTRAINT "reconciliation_item_amounts_chk" CHECK ("reconciliation_batch_item"."cod_amount_idr" > 0 and "reconciliation_batch_item"."evidence_amount_idr" >= 0 and length(btrim("reconciliation_batch_item"."evidence_line_ref")) > 0),
	CONSTRAINT "reconciliation_item_source_chk" CHECK ("reconciliation_batch_item"."reconciliation_source" in ('owner_batch', 'provider'))
);
--> statement-breakpoint
CREATE TABLE "refund" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "refund_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"goods_refund_idr" bigint NOT NULL,
	"shipping_refund_idr" bigint NOT NULL,
	"fee_refund_idr" bigint NOT NULL,
	"amount_idr" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"destination_bank" text,
	"destination_account" text,
	"destination_holder" text,
	"destination_submitted_at" timestamp with time zone,
	"approval_request_id" bigint,
	"approved_at" timestamp with time zone,
	"claimed_by_user_id" text,
	"claim_expires_at" timestamp with time zone,
	"transfer_unknown_at" timestamp with time zone,
	"transfer_evidence_ref" text,
	"evidence_artifact_id" bigint,
	"no_transfer_evidence_ref" text,
	"processed_by_user_id" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "refund_composition_chk" CHECK ("refund"."goods_refund_idr" >= 0 and "refund"."shipping_refund_idr" >= 0 and "refund"."fee_refund_idr" >= 0 and "refund"."amount_idr" = "refund"."goods_refund_idr" + "refund"."shipping_refund_idr" + "refund"."fee_refund_idr" and "refund"."amount_idr" > 0),
	CONSTRAINT "refund_status_chk" CHECK ("refund"."status" in ('pending', 'processing', 'completed', 'failed') and "refund"."reason" in ('order_cancelled', 'order_returned', 'late_payment')),
	CONSTRAINT "refund_approval_chk" CHECK ("refund"."status" not in ('processing', 'completed') or ("refund"."approval_request_id" is not null and "refund"."approved_at" is not null)),
	CONSTRAINT "refund_completed_chk" CHECK ("refund"."status" <> 'completed' or ("refund"."transfer_evidence_ref" is not null and "refund"."evidence_artifact_id" is not null and "refund"."processed_by_user_id" is not null and "refund"."transfer_unknown_at" is null and "refund"."destination_account" is not null)),
	CONSTRAINT "refund_failed_chk" CHECK ("refund"."status" <> 'failed' or "refund"."failure_reason" is not null),
	CONSTRAINT "refund_claim_chk" CHECK (("refund"."claimed_by_user_id" is null) = ("refund"."claim_expires_at" is null)),
	CONSTRAINT "refund_unknown_chk" CHECK ("refund"."transfer_unknown_at" is null or "refund"."status" = 'processing'),
	CONSTRAINT "refund_destination_chk" CHECK ((("refund"."destination_bank" is null) = ("refund"."destination_account" is null)) and (("refund"."destination_bank" is null) = ("refund"."destination_holder" is null)) and (("refund"."destination_bank" is null) = ("refund"."destination_submitted_at" is null)) and ("refund"."status" = 'pending' or "refund"."status" = 'failed' or "refund"."destination_account" is not null))
);
--> statement-breakpoint
CREATE TABLE "shipment_cost" (
	"order_id" bigint PRIMARY KEY NOT NULL,
	"store_id" bigint NOT NULL,
	"booked_shipping_idr" bigint NOT NULL,
	"shipping_charged_idr" bigint NOT NULL,
	"seller_shipping_debit_idr" bigint NOT NULL,
	"platform_shipping_margin_idr" bigint NOT NULL,
	"provider_cod_fee_idr" bigint DEFAULT 0 NOT NULL,
	"cod_amount_sent_idr" bigint,
	"shipping_debit_entry_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_cost_amounts_chk" CHECK ("shipment_cost"."booked_shipping_idr" >= 0 and "shipment_cost"."shipping_charged_idr" >= 0 and "shipment_cost"."seller_shipping_debit_idr" >= 0 and "shipment_cost"."platform_shipping_margin_idr" >= 0 and "shipment_cost"."provider_cod_fee_idr" >= 0 and ("shipment_cost"."cod_amount_sent_idr" is null or "shipment_cost"."cod_amount_sent_idr" > 0)),
	CONSTRAINT "shipment_cost_identity_chk" CHECK ("shipment_cost"."shipping_charged_idr" + "shipment_cost"."seller_shipping_debit_idr" = "shipment_cost"."booked_shipping_idr" + "shipment_cost"."platform_shipping_margin_idr"),
	CONSTRAINT "shipment_cost_one_side_chk" CHECK ("shipment_cost"."seller_shipping_debit_idr" = 0 or "shipment_cost"."platform_shipping_margin_idr" = 0)
);
--> statement-breakpoint
CREATE TABLE "store_step_up_proof" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"action_key" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "store_step_up_chk" CHECK ("store_step_up_proof"."expires_at" > "store_step_up_proof"."created_at")
);
--> statement-breakpoint
CREATE TABLE "transfer_evidence_artifact" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transfer_evidence_artifact_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"sha256" text NOT NULL,
	"kind" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_base64" text NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"claimed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_evidence_artifact_sha256_unique" UNIQUE("sha256"),
	CONSTRAINT "transfer_evidence_artifact_chk" CHECK ("transfer_evidence_artifact"."size_bytes" between 1 and 10485760 and "transfer_evidence_artifact"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "transfer_evidence_registry" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transfer_evidence_registry_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ref_raw" text NOT NULL,
	"norm_ref" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_control" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"jobs_frozen" boolean DEFAULT false NOT NULL,
	"dunning_enabled" boolean DEFAULT false NOT NULL,
	"reason" text,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_control_singleton_chk" CHECK ("billing_control"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "store_subscription" (
	"store_id" bigint PRIMARY KEY NOT NULL,
	"plan_id" bigint NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"trial_ends_at" timestamp with time zone NOT NULL,
	"billing_anchor_date" date NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"past_due_at" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_subscription_status_chk" CHECK ("store_subscription"."status" in ('trial','active','past_due','suspended')),
	CONSTRAINT "store_subscription_period_chk" CHECK (("store_subscription"."current_period_start" is null) = ("store_subscription"."current_period_end" is null) and ("store_subscription"."current_period_start" is null or "store_subscription"."current_period_start" < "store_subscription"."current_period_end")),
	CONSTRAINT "store_subscription_anchor_chk" CHECK ("store_subscription"."billing_anchor_date" = ("store_subscription"."trial_ends_at" at time zone 'Asia/Jakarta')::date),
	CONSTRAINT "store_subscription_grace_chk" CHECK (("store_subscription"."status" in ('past_due','suspended')) = ("store_subscription"."past_due_at" is not null) and ("store_subscription"."past_due_at" is null) = ("store_subscription"."grace_ends_at" is null) and ("store_subscription"."grace_ends_at" is null or "store_subscription"."grace_ends_at" >= "store_subscription"."past_due_at")),
	CONSTRAINT "store_subscription_active_chk" CHECK ("store_subscription"."status" <> 'active' or "store_subscription"."current_period_end" is not null)
);
--> statement-breakpoint
CREATE TABLE "subscription_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subscription_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"invoice_id" uuid,
	"attempt_id" uuid,
	"from_status" text,
	"to_status" text,
	"actor" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_event_kind_chk" CHECK ("subscription_event"."kind" ~ '^[a-z][a-z_]{2,40}$')
);
--> statement-breakpoint
CREATE TABLE "subscription_invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" bigint NOT NULL,
	"number" text NOT NULL,
	"period_index" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"kind" text DEFAULT 'subscription' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"plan_id" bigint NOT NULL,
	"dpp_idr" bigint NOT NULL,
	"ppn_enabled" boolean DEFAULT false NOT NULL,
	"ppn_rate_bps" integer,
	"tax_policy_version_id" bigint,
	"tax_type_code" text,
	"tax_category_code" text,
	"ppn_idr" bigint DEFAULT 0 NOT NULL,
	"total_idr" bigint NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"source" text NOT NULL,
	"created_by" text NOT NULL,
	"reason" text,
	"settlement_source" text,
	"settlement_ref" text,
	"settled_by" text,
	"coverage_applied_at" timestamp with time zone,
	"comp_request_key" text,
	CONSTRAINT "subscription_invoice_number_unique" UNIQUE("number"),
	CONSTRAINT "subscription_invoice_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "subscription_invoice_number_chk" CHECK ("subscription_invoice"."number" ~ '^SUB-[0-9A-Z]{9}[0-9A-F]{3}$'),
	CONSTRAINT "subscription_invoice_period_chk" CHECK ("subscription_invoice"."period_index" >= 0 and "subscription_invoice"."period_end" > "subscription_invoice"."period_start"),
	CONSTRAINT "subscription_invoice_amount_chk" CHECK ("subscription_invoice"."dpp_idr" >= 0 and "subscription_invoice"."ppn_idr" >= 0 and "subscription_invoice"."total_idr" = "subscription_invoice"."dpp_idr" + "subscription_invoice"."ppn_idr" and "subscription_invoice"."total_idr" <= 9007199254740991),
	CONSTRAINT "subscription_invoice_comp_chk" CHECK (("subscription_invoice"."kind" = 'comp') = ("subscription_invoice"."comp_request_key" is not null) and ("subscription_invoice"."kind" <> 'comp' or ("subscription_invoice"."dpp_idr" = 0 and "subscription_invoice"."ppn_idr" = 0 and "subscription_invoice"."total_idr" = 0 and "subscription_invoice"."source" = 'comp' and "subscription_invoice"."status" = 'paid' and "subscription_invoice"."settlement_source" = 'comp'))),
	CONSTRAINT "subscription_invoice_subscription_chk" CHECK ("subscription_invoice"."kind" <> 'subscription' or ("subscription_invoice"."dpp_idr" > 0 and "subscription_invoice"."source" in ('cron','seller','operator') and "subscription_invoice"."settlement_source" is distinct from 'comp')),
	CONSTRAINT "subscription_invoice_ppn_chk" CHECK (("subscription_invoice"."ppn_enabled" = ("subscription_invoice"."tax_policy_version_id" is not null)) and ("subscription_invoice"."ppn_enabled" = ("subscription_invoice"."ppn_rate_bps" is not null)) and ("subscription_invoice"."tax_policy_version_id" is null) = ("subscription_invoice"."tax_type_code" is null) and ("subscription_invoice"."tax_type_code" is null) = ("subscription_invoice"."tax_category_code" is null) and ("subscription_invoice"."tax_type_code" is null or ("subscription_invoice"."tax_type_code" = 'vat_output' and "subscription_invoice"."tax_category_code" = 'subscription')) and ("subscription_invoice"."ppn_enabled" or "subscription_invoice"."ppn_idr" = 0) and ("subscription_invoice"."ppn_rate_bps" is null or "subscription_invoice"."ppn_rate_bps" between 0 and 10000)),
	CONSTRAINT "subscription_invoice_state_chk" CHECK ("subscription_invoice"."status" in ('pending','paid','void') and ("subscription_invoice"."status" = 'paid') = ("subscription_invoice"."paid_at" is not null) and ("subscription_invoice"."status" = 'void') = ("subscription_invoice"."voided_at" is not null) and ("subscription_invoice"."status" <> 'void' or nullif(btrim("subscription_invoice"."void_reason"), '') is not null) and ("subscription_invoice"."status" <> 'paid' or "subscription_invoice"."settlement_source" is not null) and ("subscription_invoice"."status" = 'paid' or "subscription_invoice"."settlement_source" is null)),
	CONSTRAINT "subscription_invoice_coverage_chk" CHECK ("subscription_invoice"."coverage_applied_at" is null or ("subscription_invoice"."status" = 'paid' and "subscription_invoice"."settlement_source" in ('provider','comp','bookkeeping')))
);
--> statement-breakpoint
CREATE TABLE "subscription_notice" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subscription_notice_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"recipients" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_notice_uq" UNIQUE("store_id","kind","ref"),
	CONSTRAINT "subscription_notice_recipients_chk" CHECK ("subscription_notice"."recipients" >= 0)
);
--> statement-breakpoint
CREATE TABLE "subscription_payment_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" bigint NOT NULL,
	"invoice_id" uuid NOT NULL,
	"owner_kind" text DEFAULT 'subscription_invoice' NOT NULL,
	"owner_id" text NOT NULL,
	"local_reference" text NOT NULL,
	"reff_id" text NOT NULL,
	"channel_code" text NOT NULL,
	"customer" jsonb NOT NULL,
	"amount_idr" bigint NOT NULL,
	"admin_fee_idr" bigint NOT NULL,
	"total_idr" bigint NOT NULL,
	"provider_fee_idr" bigint,
	"transaction_id" text,
	"instruction" jsonb,
	"request_state" text DEFAULT 'in_progress' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "subscription_payment_attempt_local_reference_unique" UNIQUE("local_reference"),
	CONSTRAINT "subscription_payment_attempt_reff_id_unique" UNIQUE("reff_id"),
	CONSTRAINT "subscription_payment_attempt_transaction_id_unique" UNIQUE("transaction_id"),
	CONSTRAINT "subscription_payment_attempt_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "subscription_payment_attempt_owner_chk" CHECK ("subscription_payment_attempt"."owner_kind" = 'subscription_invoice' and "subscription_payment_attempt"."owner_id" = "subscription_payment_attempt"."invoice_id"::text),
	CONSTRAINT "subscription_payment_attempt_channel_chk" CHECK ("subscription_payment_attempt"."channel_code" in ('VABCA','VABNI','VABRI','VAMANDIRI','VAPERMATA','QRIS')),
	CONSTRAINT "subscription_payment_attempt_amount_chk" CHECK ("subscription_payment_attempt"."amount_idr" > 0 and "subscription_payment_attempt"."admin_fee_idr" >= 0 and "subscription_payment_attempt"."total_idr" = "subscription_payment_attempt"."amount_idr" + "subscription_payment_attempt"."admin_fee_idr" and "subscription_payment_attempt"."total_idr" <= 9007199254740991 and ("subscription_payment_attempt"."provider_fee_idr" is null or "subscription_payment_attempt"."provider_fee_idr" >= 0)),
	CONSTRAINT "subscription_payment_attempt_state_chk" CHECK ("subscription_payment_attempt"."request_state" in ('in_progress','accepted','failed','unknown') and "subscription_payment_attempt"."status" in ('pending','paid','unknown','expired') and "subscription_payment_attempt"."revision" > 0),
	CONSTRAINT "subscription_payment_attempt_accepted_chk" CHECK (("subscription_payment_attempt"."request_state" <> 'accepted' or ("subscription_payment_attempt"."transaction_id" is not null and "subscription_payment_attempt"."instruction" is not null)) and ("subscription_payment_attempt"."status" <> 'paid') = ("subscription_payment_attempt"."paid_at" is null)),
	CONSTRAINT "subscription_payment_attempt_reference_chk" CHECK ("subscription_payment_attempt"."local_reference" ~ '^SUB-[0-9A-Z]{9}[0-9A-F]{3}$' and "subscription_payment_attempt"."reff_id" ~ '^[0-9]{1,30}$')
);
--> statement-breakpoint
CREATE TABLE "subscription_payment_callback" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subscription_payment_callback_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"attempt_id" uuid NOT NULL,
	"body_sha256" text NOT NULL,
	"body_shape" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_payment_callback_digest_uq" UNIQUE("attempt_id","body_sha256"),
	CONSTRAINT "subscription_payment_callback_digest_chk" CHECK ("subscription_payment_callback"."body_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "subscription_plan" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subscription_plan_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"plan_code" text NOT NULL,
	"version" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"monthly_dpp_idr" bigint NOT NULL,
	"trial_days" integer NOT NULL,
	"grace_days" integer NOT NULL,
	"ppn_enabled" boolean DEFAULT false NOT NULL,
	"entitlements" jsonb DEFAULT '{"allFeatures": true}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plan_version_uq" UNIQUE("plan_code","version"),
	CONSTRAINT "subscription_plan_effective_uq" UNIQUE("plan_code","effective_from"),
	CONSTRAINT "subscription_plan_values_chk" CHECK ("subscription_plan"."monthly_dpp_idr" > 0 and "subscription_plan"."monthly_dpp_idr" <= 9007199254740991 and "subscription_plan"."trial_days" between 0 and 60 and "subscription_plan"."grace_days" between 0 and 60 and "subscription_plan"."version" > 0 and "subscription_plan"."plan_code" ~ '^[a-z][a-z0-9_]{1,31}$')
);
--> statement-breakpoint
CREATE TABLE "buyer" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "buyer_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"status" text DEFAULT 'provisional' NOT NULL,
	"display_name" text,
	"primary_phone_identifier_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "buyer_status_chk" CHECK ("buyer"."status" in ('provisional', 'active', 'restricted', 'closed')),
	CONSTRAINT "buyer_closed_chk" CHECK (("buyer"."closed_at" is not null) = ("buyer"."status" = 'closed')),
	CONSTRAINT "buyer_display_name_chk" CHECK ("buyer"."display_name" is null or char_length("buyer"."display_name") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "buyer_address" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "buyer_address_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"buyer_id" bigint NOT NULL,
	"label" text NOT NULL,
	"recipient_name" text NOT NULL,
	"phone_canonical" text NOT NULL,
	"address_text" text NOT NULL,
	"destination_area_id" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyer_address_text_chk" CHECK (char_length("buyer_address"."label") between 1 and 60 and char_length("buyer_address"."recipient_name") between 2 and 120 and char_length("buyer_address"."address_text") between 10 and 500),
	CONSTRAINT "buyer_address_phone_chk" CHECK ("buyer_address"."phone_canonical" ~ '^628[0-9]{7,12}$'),
	CONSTRAINT "buyer_address_area_chk" CHECK ("buyer_address"."destination_area_id" ~ '^[a-f0-9]{24}$')
);
--> statement-breakpoint
CREATE TABLE "buyer_identifier" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "buyer_identifier_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"buyer_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"canonical_value" text NOT NULL,
	"verified_at" timestamp with time zone,
	"binding_state" text DEFAULT 'observed' NOT NULL,
	"account_bound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "buyer_identifier_value_uq" UNIQUE("kind","canonical_value"),
	CONSTRAINT "buyer_identifier_buyer_id_uq" UNIQUE("buyer_id","id"),
	CONSTRAINT "buyer_identifier_kind_chk" CHECK ("buyer_identifier"."kind" in ('phone', 'email')),
	CONSTRAINT "buyer_identifier_binding_chk" CHECK ("buyer_identifier"."binding_state" in ('observed', 'bound', 'disputed', 'revoked')),
	CONSTRAINT "buyer_identifier_value_chk" CHECK (("buyer_identifier"."kind" = 'phone' and "buyer_identifier"."canonical_value" ~ '^628[0-9]{7,12}$') or ("buyer_identifier"."kind" = 'email' and "buyer_identifier"."canonical_value" ~ '^(?:[A-Za-z0-9_''+-]+\.)*[A-Za-z0-9_''+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$' and "buyer_identifier"."canonical_value" !~ '[A-Z]' and char_length("buyer_identifier"."canonical_value") <= 254)),
	CONSTRAINT "buyer_identifier_proof_chk" CHECK (("buyer_identifier"."binding_state" <> 'observed' or ("buyer_identifier"."verified_at" is null and "buyer_identifier"."account_bound_at" is null)) and ("buyer_identifier"."binding_state" <> 'bound' or ("buyer_identifier"."verified_at" is not null and "buyer_identifier"."account_bound_at" is not null)) and ("buyer_identifier"."account_bound_at" is null or "buyer_identifier"."verified_at" is not null)),
	CONSTRAINT "buyer_identifier_revoked_chk" CHECK (("buyer_identifier"."revoked_at" is not null) = ("buyer_identifier"."binding_state" = 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "buyer_identity_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "buyer_identity_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"buyer_id" bigint NOT NULL,
	"store_id" bigint,
	"order_id" bigint,
	"event_type" text NOT NULL,
	"related_buyer_id" bigint,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyer_identity_event_type_chk" CHECK ("buyer_identity_event"."event_type" in ('buyer_created', 'order_linked', 'identifier_observed', 'phone_email_conflict', 'email_phone_mismatch', 'identifier_bound', 'link_confirmed', 'identity_restricted', 'merge_requested', 'merge_completed')),
	CONSTRAINT "buyer_identity_event_actor_chk" CHECK ("buyer_identity_event"."actor_type" in ('system', 'buyer', 'operator') and ("buyer_identity_event"."actor_id" is null or char_length("buyer_identity_event"."actor_id") <= 120) and ("buyer_identity_event"."request_id" is null or char_length("buyer_identity_event"."request_id") <= 120)),
	CONSTRAINT "buyer_identity_event_related_chk" CHECK ((("buyer_identity_event"."event_type" in ('phone_email_conflict', 'email_phone_mismatch', 'merge_requested', 'merge_completed')) = ("buyer_identity_event"."related_buyer_id" is not null)) and ("buyer_identity_event"."related_buyer_id" is null or "buyer_identity_event"."related_buyer_id" <> "buyer_identity_event"."buyer_id")),
	CONSTRAINT "buyer_identity_event_order_chk" CHECK ("buyer_identity_event"."order_id" is null or "buyer_identity_event"."store_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "buyer_order_link" (
	"buyer_id" bigint NOT NULL,
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"resolved_identifier_id" bigint NOT NULL,
	"resolution_method" text NOT NULL,
	"access_state" text DEFAULT 'unverified' NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "buyer_order_link_pk" PRIMARY KEY("store_id","order_id"),
	CONSTRAINT "buyer_order_link_method_chk" CHECK ("buyer_order_link"."resolution_method" in ('phone', 'email', 'created')),
	CONSTRAINT "buyer_order_link_access_chk" CHECK ("buyer_order_link"."access_state" in ('unverified', 'confirmed', 'restricted')),
	CONSTRAINT "buyer_order_link_confirmed_chk" CHECK (("buyer_order_link"."confirmed_at" is not null) = ("buyer_order_link"."access_state" = 'confirmed'))
);
--> statement-breakpoint
ALTER TABLE "order" DROP CONSTRAINT "order_status_chk";--> statement-breakpoint
ALTER TABLE "platform_operator" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operator_grant" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_review_decision" ADD CONSTRAINT "access_review_decision_reviewer_user_id_platform_operator_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_status_event" ADD CONSTRAINT "account_status_event_case_id_support_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_verification" ADD CONSTRAINT "account_verification_submitted_by_platform_operator_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_verification" ADD CONSTRAINT "account_verification_reviewer_user_id_platform_operator_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_risk_ack" ADD CONSTRAINT "store_risk_ack_store_ref_store_id_fk" FOREIGN KEY ("store_ref") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_risk_ack" ADD CONSTRAINT "store_risk_ack_acknowledged_by_platform_operator_user_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_action" ADD CONSTRAINT "support_action_case_id_support_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_action" ADD CONSTRAINT "support_action_action_key_four_eyes_rule_action_key_fk" FOREIGN KEY ("action_key") REFERENCES "public"."four_eyes_rule"("action_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_action" ADD CONSTRAINT "support_action_requested_by_platform_operator_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_action" ADD CONSTRAINT "support_action_approval_request_id_approval_request_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_assignee_user_id_platform_operator_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_opened_by_user_id_platform_operator_user_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_note" ADD CONSTRAINT "support_case_note_case_id_support_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_note" ADD CONSTRAINT "support_case_note_author_user_id_platform_operator_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_recovery_link" ADD CONSTRAINT "support_recovery_link_support_action_id_support_action_id_fk" FOREIGN KEY ("support_action_id") REFERENCES "public"."support_action"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order_financials"("store_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_payout_fk" FOREIGN KEY ("store_id","payout_id") REFERENCES "public"."payout"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_item_fk" FOREIGN KEY ("reconciliation_item_id","store_id") REFERENCES "public"."reconciliation_batch_item"("id","store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_financials" ADD CONSTRAINT "order_line_financials_fin_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order_financials"("store_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_financials" ADD CONSTRAINT "order_line_financials_line_fk" FOREIGN KEY ("order_id","variant_id") REFERENCES "public"."order_line"("order_id","variant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_destination_fk" FOREIGN KEY ("store_id","destination_id") REFERENCES "public"."payout_destination"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_batch_item" ADD CONSTRAINT "reconciliation_batch_item_batch_id_reconciliation_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."reconciliation_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_batch_item" ADD CONSTRAINT "reconciliation_item_fin_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order_financials"("store_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "refund_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "refund_attempt_fk" FOREIGN KEY ("store_id","payment_attempt_id") REFERENCES "public"."payment_attempt"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cost" ADD CONSTRAINT "shipment_cost_fin_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order_financials"("store_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cost" ADD CONSTRAINT "shipment_cost_entry_fk" FOREIGN KEY ("store_id","shipping_debit_entry_id") REFERENCES "public"."ledger_entry"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_subscription" ADD CONSTRAINT "store_subscription_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_subscription" ADD CONSTRAINT "store_subscription_plan_id_subscription_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_event" ADD CONSTRAINT "subscription_event_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_plan_id_subscription_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_policy_fk" FOREIGN KEY ("tax_policy_version_id","tax_type_code","tax_category_code") REFERENCES "public"."tax_policy_version"("id","tax_type_code","category_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_notice" ADD CONSTRAINT "subscription_notice_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payment_attempt" ADD CONSTRAINT "subscription_payment_attempt_invoice_fk" FOREIGN KEY ("store_id","invoice_id") REFERENCES "public"."subscription_invoice"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payment_callback" ADD CONSTRAINT "subscription_payment_callback_attempt_fk" FOREIGN KEY ("store_id","attempt_id") REFERENCES "public"."subscription_payment_attempt"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer" ADD CONSTRAINT "buyer_primary_phone_fk" FOREIGN KEY ("id","primary_phone_identifier_id") REFERENCES "public"."buyer_identifier"("buyer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_address" ADD CONSTRAINT "buyer_address_buyer_id_buyer_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_identifier" ADD CONSTRAINT "buyer_identifier_buyer_id_buyer_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_identity_event" ADD CONSTRAINT "buyer_identity_event_buyer_id_buyer_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_identity_event" ADD CONSTRAINT "buyer_identity_event_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_identity_event" ADD CONSTRAINT "buyer_identity_event_related_buyer_id_buyer_id_fk" FOREIGN KEY ("related_buyer_id") REFERENCES "public"."buyer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_identity_event" ADD CONSTRAINT "buyer_identity_event_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_order_link" ADD CONSTRAINT "buyer_order_link_buyer_id_buyer_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_order_link" ADD CONSTRAINT "buyer_order_link_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_order_link" ADD CONSTRAINT "buyer_order_link_identifier_fk" FOREIGN KEY ("buyer_id","resolved_identifier_id") REFERENCES "public"."buyer_identifier"("buyer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_review_decision_operator_idx" ON "access_review_decision" USING btree ("operator_user_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "account_status_event_subject_idx" ON "account_status_event" USING btree ("subject_kind","subject_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "account_verification_version_uq" ON "account_verification" USING btree ("subject_kind","subject_id","kind","version");--> statement-breakpoint
CREATE UNIQUE INDEX "account_verification_verified_uq" ON "account_verification" USING btree ("subject_kind","subject_id","kind") WHERE "account_verification"."status" = 'verified';--> statement-breakpoint
CREATE INDEX "account_verification_subject_idx" ON "account_verification" USING btree ("subject_kind","subject_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "store_risk_ack_store_idx" ON "store_risk_ack" USING btree ("store_ref","flag_key","id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "support_action_idempotency_uq" ON "support_action" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "support_action_subject_idx" ON "support_action" USING btree ("subject_kind","subject_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_action_case_idx" ON "support_action" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_case_number_uq" ON "support_case" USING btree ("case_number");--> statement-breakpoint
CREATE INDEX "support_case_subject_idx" ON "support_case" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "support_case_status_idx" ON "support_case" USING btree ("status","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_case_note_case_idx" ON "support_case_note" USING btree ("case_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_recovery_link_token_uq" ON "support_recovery_link" USING btree ("token_sha256");--> statement-breakpoint
CREATE INDEX "support_recovery_link_user_idx" ON "support_recovery_link" USING btree ("user_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_sale_per_order" ON "ledger_entry" USING btree ("store_id","order_id") WHERE "ledger_entry"."kind" = 'sale';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_cashback_per_order" ON "ledger_entry" USING btree ("store_id","order_id") WHERE "ledger_entry"."kind" = 'cashback';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_return_per_order" ON "ledger_entry" USING btree ("store_id","order_id") WHERE "ledger_entry"."kind" = 'return_reversal';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_shipping_debit_per_order" ON "ledger_entry" USING btree ("store_id","order_id") WHERE "ledger_entry"."kind" = 'shipping_debit';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_shipping_reversal_per_order" ON "ledger_entry" USING btree ("store_id","order_id") WHERE "ledger_entry"."kind" = 'shipping_debit_reversal';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_payout_per_payout" ON "ledger_entry" USING btree ("store_id","payout_id") WHERE "ledger_entry"."kind" = 'payout';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_payout_reversal_per_payout" ON "ledger_entry" USING btree ("store_id","payout_id") WHERE "ledger_entry"."kind" = 'payout_reversal';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_adjustment_business_ref" ON "ledger_entry" USING btree ("store_id","business_ref") WHERE "ledger_entry"."kind" = 'adjustment';--> statement-breakpoint
CREATE INDEX "ledger_balance_idx" ON "ledger_entry" USING btree ("store_id","status","amount_idr");--> statement-breakpoint
CREATE INDEX "ledger_store_created_idx" ON "ledger_entry" USING btree ("store_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ledger_release_idx" ON "ledger_entry" USING btree ("store_id") WHERE "ledger_entry"."kind" in ('sale', 'cashback') and "ledger_entry"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "payout_status_idx" ON "payout" USING btree ("status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_evidence_artifact_uq" ON "payout" USING btree ("evidence_artifact_id") WHERE "payout"."evidence_artifact_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_approval_uq" ON "payout" USING btree ("approval_request_id") WHERE "payout"."approval_request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_step_up_uq" ON "payout" USING btree ("step_up_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_destination_one_active_uq" ON "payout_destination" USING btree ("store_id") WHERE "payout_destination"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "payout_destination_one_held_uq" ON "payout_destination" USING btree ("store_id") WHERE "payout_destination"."status" = 'held';--> statement-breakpoint
CREATE INDEX "reconciliation_batch_status_idx" ON "reconciliation_batch" USING btree ("status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_batch_approval_uq" ON "reconciliation_batch" USING btree ("approval_request_id") WHERE "reconciliation_batch"."approval_request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_item_order_live_uq" ON "reconciliation_batch_item" USING btree ("order_id") WHERE "reconciliation_batch_item"."voided_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_one_open_per_payment" ON "refund" USING btree ("payment_attempt_id") WHERE "refund"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "refund_one_per_order" ON "refund" USING btree ("store_id","order_id") WHERE "refund"."status" <> 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX "refund_evidence_artifact_uq" ON "refund" USING btree ("evidence_artifact_id") WHERE "refund"."evidence_artifact_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_approval_uq" ON "refund" USING btree ("approval_request_id") WHERE "refund"."approval_request_id" is not null;--> statement-breakpoint
CREATE INDEX "refund_status_idx" ON "refund" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "store_step_up_user_idx" ON "store_step_up_proof" USING btree ("store_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_evidence_norm_uq" ON "transfer_evidence_registry" USING btree ("norm_ref");--> statement-breakpoint
CREATE INDEX "subscription_event_store_idx" ON "subscription_event" USING btree ("store_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_event_coverage_uq" ON "subscription_event" USING btree ("invoice_id") WHERE "subscription_event"."kind" = 'coverage_applied';--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_event_paid_uq" ON "subscription_event" USING btree ("attempt_id") WHERE "subscription_event"."kind" = 'attempt_paid';--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_invoice_period_index_uq" ON "subscription_invoice" USING btree ("store_id","period_index") WHERE "subscription_invoice"."kind" = 'subscription' and "subscription_invoice"."status" <> 'void';--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_invoice_period_dates_uq" ON "subscription_invoice" USING btree ("store_id","period_start","period_end") WHERE "subscription_invoice"."kind" = 'subscription' and "subscription_invoice"."status" <> 'void';--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_invoice_pending_uq" ON "subscription_invoice" USING btree ("store_id","period_start","period_end") WHERE "subscription_invoice"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_invoice_comp_period_uq" ON "subscription_invoice" USING btree ("store_id","period_index") WHERE "subscription_invoice"."kind" = 'comp' and "subscription_invoice"."status" <> 'void';--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_invoice_comp_key_uq" ON "subscription_invoice" USING btree ("comp_request_key") WHERE "subscription_invoice"."kind" = 'comp';--> statement-breakpoint
CREATE INDEX "subscription_invoice_store_idx" ON "subscription_invoice" USING btree ("store_id","period_index");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payment_attempt_live_uq" ON "subscription_payment_attempt" USING btree ("invoice_id") WHERE "subscription_payment_attempt"."status" in ('pending','unknown') and "subscription_payment_attempt"."request_state" <> 'failed';--> statement-breakpoint
CREATE INDEX "subscription_payment_attempt_invoice_idx" ON "subscription_payment_attempt" USING btree ("invoice_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "buyer_address_default_uq" ON "buyer_address" USING btree ("buyer_id") WHERE "buyer_address"."is_default";--> statement-breakpoint
CREATE INDEX "buyer_address_buyer_idx" ON "buyer_address" USING btree ("buyer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "buyer_identifier_live_phone_uq" ON "buyer_identifier" USING btree ("buyer_id") WHERE "buyer_identifier"."kind" = 'phone' and "buyer_identifier"."binding_state" <> 'revoked';--> statement-breakpoint
CREATE INDEX "buyer_identifier_buyer_idx" ON "buyer_identifier" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "buyer_identity_event_buyer_idx" ON "buyer_identity_event" USING btree ("buyer_id","created_at");--> statement-breakpoint
CREATE INDEX "buyer_identity_event_order_idx" ON "buyer_identity_event" USING btree ("store_id","order_id");--> statement-breakpoint
CREATE INDEX "buyer_order_link_buyer_idx" ON "buyer_order_link" USING btree ("buyer_id","linked_at");--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_status_chk" CHECK ("order"."status" in ('awaiting_confirmation', 'on_hold', 'awaiting_payment', 'placed', 'processing', 'shipped', 'completed', 'cancelled', 'returned'));--> statement-breakpoint

-- ===== T-57 global buyer identity: normalization port, isolation, guards, resolver (hand-written) =====
-- Hand-written: drizzle-kit models neither policies, grants, triggers nor SECURITY DEFINER functions. Appended to the
-- generated statements above; the parent folds the wave 3 migrations into one, keep this section verbatim.
-- ADR-0010 sections 2 to 5, ADR-0005 amendment 4. Class `buyer` for all five tables: own-buyer FORCE RLS on app.buyer_id.
-- The two login roles hold nothing beyond SELECT for the app role on the four buyer-readable tables (the buyer portal reads its own
-- rows, T-58); bukalaris_platform holds NO table privilege and reaches identity only through buyer_resolve_order() below.

-- ── Row-level security: own buyer only; a missing context matches no row (the default privileges gave the platform role every DML right, taken back here) ──
ALTER TABLE "buyer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "buyer" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY buyer_isolation ON "buyer" USING ("id" = app_buyer_id()) WITH CHECK ("id" = app_buyer_id());--> statement-breakpoint
ALTER TABLE "buyer_identifier" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "buyer_identifier" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY buyer_isolation ON "buyer_identifier" USING ("buyer_id" = app_buyer_id()) WITH CHECK ("buyer_id" = app_buyer_id());--> statement-breakpoint
ALTER TABLE "buyer_order_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "buyer_order_link" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY buyer_isolation ON "buyer_order_link" USING ("buyer_id" = app_buyer_id()) WITH CHECK ("buyer_id" = app_buyer_id());--> statement-breakpoint
ALTER TABLE "buyer_identity_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "buyer_identity_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY buyer_isolation ON "buyer_identity_event" USING ("buyer_id" = app_buyer_id()) WITH CHECK ("buyer_id" = app_buyer_id());--> statement-breakpoint
ALTER TABLE "buyer_address" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "buyer_address" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY buyer_isolation ON "buyer_address" USING ("buyer_id" = app_buyer_id()) WITH CHECK ("buyer_id" = app_buyer_id());--> statement-breakpoint

-- ── Grants (the isolation registry columns) ──────────────────────────────────────────────────────────────────
-- app: read-only on four tables (own rows by policy); the identity events are not readable by any login role (restricted service reads only).
-- Address writes arrive with the portal (T-58) together with the service that owns them. platform: nothing at all.
REVOKE ALL ON "buyer", "buyer_identifier", "buyer_order_link", "buyer_identity_event", "buyer_address" FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "buyer", "buyer_identifier", "buyer_order_link", "buyer_address" TO bukalaris_app;--> statement-breakpoint

-- ── Guards ───────────────────────────────────────────────────────────────────────────────────────────────────
-- Events are evidence: never updated or deleted. The one exception is the demo reset below (a transaction-local marker only that
-- owner-side function sets; no login role holds a DELETE privilege on the table anyway).
CREATE OR REPLACE FUNCTION "buyer_event_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.current_setting('bukalaris.buyer_reset', true) = 'demo' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "buyer_identity_event_append_only" ON "buyer_identity_event";--> statement-breakpoint
CREATE TRIGGER "buyer_identity_event_append_only" BEFORE UPDATE OR DELETE ON "buyer_identity_event" FOR EACH ROW EXECUTE FUNCTION "buyer_event_guard"();--> statement-breakpoint
-- An identifier never changes owner, kind or value (no reassignment of an owned identifier, no silent re-keying), and a revoked one stays
-- revoked: reuse of a revoked identifier is OPEN (recycling policy) and needs its own audited service, not an UPDATE.
CREATE OR REPLACE FUNCTION "buyer_identifier_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW."buyer_id", NEW."kind", NEW."canonical_value", NEW."created_at") IS DISTINCT FROM (OLD."buyer_id", OLD."kind", OLD."canonical_value", OLD."created_at") THEN
    RAISE EXCEPTION 'a buyer identifier never changes owner, kind or value' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."binding_state" = 'revoked' AND NEW."binding_state" <> 'revoked' THEN
    RAISE EXCEPTION 'a revoked buyer identifier stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "buyer_identifier_guard" ON "buyer_identifier";--> statement-breakpoint
CREATE TRIGGER "buyer_identifier_guard" BEFORE UPDATE ON "buyer_identifier" FOR EACH ROW EXECUTE FUNCTION "buyer_identifier_guard"();--> statement-breakpoint
-- A link is written once: which buyer, which order and which identifier resolved it never change. Only the access state (confirmation or
-- restriction by their own audited service) moves. A later merge replaces this guard deliberately; nothing here permits one.
CREATE OR REPLACE FUNCTION "buyer_order_link_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW."buyer_id", NEW."store_id", NEW."order_id", NEW."resolved_identifier_id", NEW."resolution_method", NEW."linked_at")
     IS DISTINCT FROM (OLD."buyer_id", OLD."store_id", OLD."order_id", OLD."resolved_identifier_id", OLD."resolution_method", OLD."linked_at") THEN
    RAISE EXCEPTION 'a buyer order link is written once; only its access state can change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "buyer_order_link_guard" ON "buyer_order_link";--> statement-breakpoint
CREATE TRIGGER "buyer_order_link_guard" BEFORE UPDATE ON "buyer_order_link" FOR EACH ROW EXECUTE FUNCTION "buyer_order_link_guard"();--> statement-breakpoint
-- The primary phone is a live phone identifier of the same buyer (the compound FK proves "same buyer"; a foreign key cannot test the kind).
CREATE OR REPLACE FUNCTION "buyer_primary_phone_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."buyer_identifier" i WHERE i."id" = NEW."primary_phone_identifier_id" AND i."buyer_id" = NEW."id" AND i."kind" = 'phone' AND i."binding_state" <> 'revoked') THEN
    RAISE EXCEPTION 'the primary phone of a buyer is a live phone identifier of that buyer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "buyer_primary_phone_guard" ON "buyer";--> statement-breakpoint
CREATE TRIGGER "buyer_primary_phone_guard" BEFORE INSERT OR UPDATE OF "primary_phone_identifier_id" ON "buyer" FOR EACH ROW WHEN (NEW."primary_phone_identifier_id" IS NOT NULL) EXECUTE FUNCTION "buyer_primary_phone_guard"();--> statement-breakpoint

-- ── SQL port of the shared normalization (packages/db/src/buyer/normalize.ts) ─────────────────────────────────────
-- Plain IMMUTABLE functions, no table access, pinned search_path. `t57-normalize.test.ts` runs one table through the TypeScript module
-- and through these three and fails when they disagree. They are used by the risk and privacy lookups (compare a stored snapshot with
-- a typed key; the snapshot itself is never rewritten) and by the resolver below (which must derive its keys from the committed order).
--   buyer_phone_key: digits without '+', 8 to 15 long, starting 1-9: leading '+', '00' or '0' (read as Indonesia) mapped to the country
--   code, one stray '0' after '62' dropped; NULL for anything outside the accepted characters.
CREATE OR REPLACE FUNCTION public.buyer_phone_key(p text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN q.k ~ '^[1-9][0-9]{7,14}$' THEN q.k END
  FROM (
    SELECT CASE WHEN m.k0 ~ '^620' THEN '62' || substr(m.k0, 4) ELSE m.k0 END AS k
    FROM (
      SELECT CASE WHEN s.plus THEN s.digits WHEN s.digits ~ '^00' THEN substr(s.digits, 3) WHEN s.digits ~ '^0' THEN '62' || substr(s.digits, 2) ELSE s.digits END AS k0
      FROM (
        SELECT t.plus, t.body, regexp_replace(t.body, E'[ \t().-]', '', 'g') AS digits
        FROM (
          SELECT left(u.v, 1) = '+' AS plus, CASE WHEN left(u.v, 1) = '+' THEN substr(u.v, 2) ELSE u.v END AS body
          FROM (SELECT btrim(p, E' \t') AS v WHERE p ~ E'^[+0-9 \t().-]{1,32}$') u
        ) t
      ) s
      WHERE s.body !~ '[+]' AND s.digits ~ '^[0-9]+$'
    ) m
  ) q
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.buyer_canonical_phone(p text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT x.k FROM (SELECT public.buyer_phone_key(p) AS k) x WHERE x.k ~ '^628[0-9]{7,12}$'
$$;--> statement-breakpoint
-- Trim, ASCII lower case (translate, not lower(): no locale can fold a letter into another), the checkout validator, at most 254 characters.
-- Non-ASCII input is rejected before folding.
CREATE OR REPLACE FUNCTION public.buyer_canonical_email(p text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.v
  FROM (SELECT translate(btrim(p, E' \t\n\r\f' || chr(11)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS v WHERE p !~ E'[^\\x01-\\x7f]') t
  WHERE char_length(t.v) <= 254 AND t.v ~ '^(?:[A-Za-z0-9_''+-]+\.)*[A-Za-z0-9_''+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$'
$$;--> statement-breakpoint

-- ── The platform resolver (ADR-0010 section 4, JOB-10) ──────────────────────────────────────────────────────────
-- Target-bound: the caller names only (store, order). The function reads that committed order's contact snapshot itself, so no caller can
-- attach a value of its choosing. One statement = one transaction: every effect (buyer, identifiers, link, events) commits together or
-- not at all. Keys are locked in a fixed order (phone, then e-mail) so concurrent resolutions queue instead of deadlocking, and the unique
-- indexes (kind + value, one live phone per buyer, one link per order) stay the final guard under any interleaving: a lost race raises
-- serialization_failure and the job retries.
--   Phone first. A phone identifier that is not revoked decides the buyer. Otherwise an e-mail identifier that is not revoked decides it,
--   unless that buyer already has a different live phone (then a NEW buyer is created, the e-mail stays where it is, `email_phone_mismatch`)
--   or, with p_email_match_needs_bound (the recommended default of ADR-0010 section 4 step 6, OPEN), the e-mail is only observed and a phone is
--   submitted (then a new buyer as well: an email-only buyer is never given a new phone by a checkout). Phone and e-mail of two buyers: the
--   phone buyer wins, nothing is merged or moved, `phone_email_conflict`. Identifiers that nobody owns are attached as `observed`; the
--   phone of a buyer created from it becomes its primary phone. Nothing is verified, bound, confirmed or returned about an existing buyer.
--   Outcomes: linked, already_linked (replay), no_identifier (no usable contact: redacted, landline or foreign number, no e-mail).
CREATE OR REPLACE FUNCTION public.buyer_resolve_order(p_store_id bigint, p_order_id bigint, p_request_id text, p_email_match_needs_bound boolean DEFAULT true)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_raw_phone text;
  v_raw_email text;
  v_phone text;
  v_email text;
  v_p public.buyer_identifier%ROWTYPE;
  v_e public.buyer_identifier%ROWTYPE;
  v_p_found boolean := false;
  v_e_found boolean := false;
  v_e_phone_id bigint;
  v_attach_phone boolean;
  v_attach_email boolean;
  v_buyer bigint;
  v_resolving bigint;
  v_method text;
  v_conflict bigint;
  v_mismatch bigint;
  v_id bigint;
BEGIN
  SELECT o."buyer_phone", o."buyer_email" INTO v_raw_phone, v_raw_email FROM public."order" o WHERE o."store_id" = p_store_id AND o."id" = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'buyer.resolve: the order does not exist in this store' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.buyer_order_link l WHERE l."store_id" = p_store_id AND l."order_id" = p_order_id) THEN
    RETURN 'already_linked';
  END IF;
  v_phone := public.buyer_canonical_phone(v_raw_phone);
  v_email := public.buyer_canonical_email(v_raw_email);
  IF v_phone IS NULL AND v_email IS NULL THEN
    RETURN 'no_identifier';
  END IF;

  IF v_phone IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('buyer.identifier:phone:' || v_phone, 0));
  END IF;
  IF v_email IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('buyer.identifier:email:' || v_email, 0));
  END IF;
  IF EXISTS (SELECT 1 FROM public.buyer_order_link l WHERE l."store_id" = p_store_id AND l."order_id" = p_order_id) THEN
    RETURN 'already_linked';
  END IF;

  IF v_phone IS NOT NULL THEN
    SELECT * INTO v_p FROM public.buyer_identifier i WHERE i."kind" = 'phone' AND i."canonical_value" = v_phone;
    v_p_found := FOUND;
  END IF;
  IF v_email IS NOT NULL THEN
    SELECT * INTO v_e FROM public.buyer_identifier i WHERE i."kind" = 'email' AND i."canonical_value" = v_email;
    v_e_found := FOUND;
  END IF;
  v_attach_phone := v_phone IS NOT NULL AND NOT v_p_found;
  v_attach_email := v_email IS NOT NULL AND NOT v_e_found;

  IF v_p_found AND v_p."binding_state" <> 'revoked' THEN
    v_buyer := v_p."buyer_id";
    v_resolving := v_p."id";
    v_method := 'phone';
    IF v_e_found AND v_e."buyer_id" <> v_buyer THEN
      v_conflict := v_e."buyer_id";
    END IF;
  ELSIF v_e_found AND v_e."binding_state" <> 'revoked' THEN
    SELECT i."id" INTO v_e_phone_id FROM public.buyer_identifier i WHERE i."buyer_id" = v_e."buyer_id" AND i."kind" = 'phone' AND i."binding_state" <> 'revoked';
    IF v_e_phone_id IS NOT NULL AND v_phone IS NOT NULL THEN
      v_mismatch := v_e."buyer_id";
    ELSIF v_e_phone_id IS NULL AND v_phone IS NOT NULL AND p_email_match_needs_bound AND v_e."binding_state" <> 'bound' THEN
      v_mismatch := NULL;
    ELSE
      v_buyer := v_e."buyer_id";
      v_resolving := v_e."id";
      v_method := 'email';
    END IF;
  END IF;

  IF v_buyer IS NULL THEN
    IF NOT v_attach_phone AND NOT v_attach_email THEN
      RAISE EXCEPTION 'buyer.resolve: no identifier of the order can be attached (revoked identifier, recycling policy is open)' USING ERRCODE = 'feature_not_supported';
    END IF;
    INSERT INTO public.buyer (status) VALUES ('provisional') RETURNING "id" INTO v_buyer;
    INSERT INTO public.buyer_identity_event (buyer_id, store_id, order_id, event_type, actor_type, actor_id, request_id)
      VALUES (v_buyer, p_store_id, p_order_id, 'buyer_created', 'system', 'buyer.resolve', p_request_id);
    v_method := 'created';
    IF v_attach_phone THEN
      v_id := NULL;
      INSERT INTO public.buyer_identifier (buyer_id, kind, canonical_value) VALUES (v_buyer, 'phone', v_phone) ON CONFLICT ("kind", "canonical_value") DO NOTHING RETURNING "id" INTO v_id;
      IF v_id IS NULL THEN
        RAISE EXCEPTION 'buyer.resolve: the phone was taken concurrently, retry' USING ERRCODE = 'serialization_failure';
      END IF;
      UPDATE public.buyer SET "primary_phone_identifier_id" = v_id WHERE "id" = v_buyer;
      v_resolving := v_id;
      v_attach_phone := false;
      INSERT INTO public.buyer_identity_event (buyer_id, store_id, order_id, event_type, actor_type, actor_id, request_id)
        VALUES (v_buyer, p_store_id, p_order_id, 'identifier_observed', 'system', 'buyer.resolve', p_request_id);
    END IF;
    IF v_attach_email THEN
      v_id := NULL;
      INSERT INTO public.buyer_identifier (buyer_id, kind, canonical_value) VALUES (v_buyer, 'email', v_email) ON CONFLICT ("kind", "canonical_value") DO NOTHING RETURNING "id" INTO v_id;
      IF v_id IS NULL THEN
        RAISE EXCEPTION 'buyer.resolve: the e-mail was taken concurrently, retry' USING ERRCODE = 'serialization_failure';
      END IF;
      IF v_resolving IS NULL THEN
        v_resolving := v_id;
      END IF;
      v_attach_email := false;
      INSERT INTO public.buyer_identity_event (buyer_id, store_id, order_id, event_type, actor_type, actor_id, request_id)
        VALUES (v_buyer, p_store_id, p_order_id, 'identifier_observed', 'system', 'buyer.resolve', p_request_id);
    END IF;
    IF v_mismatch IS NOT NULL THEN
      INSERT INTO public.buyer_identity_event (buyer_id, store_id, order_id, event_type, related_buyer_id, actor_type, actor_id, request_id)
        VALUES (v_buyer, p_store_id, p_order_id, 'email_phone_mismatch', v_mismatch, 'system', 'buyer.resolve', p_request_id);
    END IF;
  ELSE
    IF v_attach_phone THEN
      v_id := NULL;
      INSERT INTO public.buyer_identifier (buyer_id, kind, canonical_value) VALUES (v_buyer, 'phone', v_phone) ON CONFLICT ("kind", "canonical_value") DO NOTHING RETURNING "id" INTO v_id;
      IF v_id IS NULL THEN
        RAISE EXCEPTION 'buyer.resolve: the phone was taken concurrently, retry' USING ERRCODE = 'serialization_failure';
      END IF;
      INSERT INTO public.buyer_identity_event (buyer_id, store_id, order_id, event_type, actor_type, actor_id, request_id)
        VALUES (v_buyer, p_store_id, p_order_id, 'identifier_observed', 'system', 'buyer.resolve', p_request_id);
    END IF;
    IF v_attach_email THEN
      v_id := NULL;
      INSERT INTO public.buyer_identifier (buyer_id, kind, canonical_value) VALUES (v_buyer, 'email', v_email) ON CONFLICT ("kind", "canonical_value") DO NOTHING RETURNING "id" INTO v_id;
      IF v_id IS NULL THEN
        RAISE EXCEPTION 'buyer.resolve: the e-mail was taken concurrently, retry' USING ERRCODE = 'serialization_failure';
      END IF;
      INSERT INTO public.buyer_identity_event (buyer_id, store_id, order_id, event_type, actor_type, actor_id, request_id)
        VALUES (v_buyer, p_store_id, p_order_id, 'identifier_observed', 'system', 'buyer.resolve', p_request_id);
    END IF;
  END IF;

  INSERT INTO public.buyer_order_link (buyer_id, store_id, order_id, resolved_identifier_id, resolution_method, access_state)
    VALUES (v_buyer, p_store_id, p_order_id, v_resolving, v_method, 'unverified');
  INSERT INTO public.buyer_identity_event (buyer_id, store_id, order_id, event_type, actor_type, actor_id, request_id)
    VALUES (v_buyer, p_store_id, p_order_id, 'order_linked', 'system', 'buyer.resolve', p_request_id);
  IF v_conflict IS NOT NULL THEN
    INSERT INTO public.buyer_identity_event (buyer_id, store_id, order_id, event_type, related_buyer_id, actor_type, actor_id, request_id)
      VALUES (v_buyer, p_store_id, p_order_id, 'phone_email_conflict', v_conflict, 'system', 'buyer.resolve', p_request_id);
  END IF;
  RETURN 'linked';
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.buyer_resolve_order(bigint, bigint, text, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.buyer_resolve_order(bigint, bigint, text, boolean) TO bukalaris_platform;--> statement-breakpoint

-- ── Local demo reset ───────────────────────────────────────────────────────────────────────────────────────────
-- The demo seed (`--reset`) deletes demo stores and their orders; links and events reference those orders and no login role may delete
-- them. This owner-side function removes the links and events of stores whose slug starts with 'demo-' (the seed's reserved prefix), and the
-- buyers that were linked only to those stores and are referenced by no other event. Any other store id is ignored. Owner connection only.
CREATE OR REPLACE FUNCTION public.reset_demo_buyers(p_store_ids bigint[]) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ids bigint[];
  v_buyers bigint[];
  v_orphans bigint[];
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
  PERFORM pg_catalog.set_config('bukalaris.buyer_reset', 'demo', true);
  SELECT pg_catalog.array_agg(DISTINCT l.buyer_id) INTO v_buyers FROM public.buyer_order_link l WHERE l.store_id = ANY (v_ids);
  DELETE FROM public.buyer_identity_event WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.buyer_order_link WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  SELECT pg_catalog.array_agg(b.id) INTO v_orphans FROM public.buyer b
    WHERE b.id = ANY (COALESCE(v_buyers, '{}'::bigint[]))
      AND NOT EXISTS (SELECT 1 FROM public.buyer_order_link l WHERE l.buyer_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM public.buyer_identity_event e WHERE e.buyer_id = b.id OR e.related_buyer_id = b.id);
  IF v_orphans IS NOT NULL THEN
    UPDATE public.buyer SET primary_phone_identifier_id = NULL WHERE id = ANY (v_orphans);
    DELETE FROM public.buyer_address WHERE buyer_id = ANY (v_orphans);
    DELETE FROM public.buyer_identifier WHERE buyer_id = ANY (v_orphans);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;
    DELETE FROM public.buyer WHERE id = ANY (v_orphans);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;
  END IF;
  PERFORM pg_catalog.set_config('bukalaris.buyer_reset', '', true);
  RETURN v_total;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reset_demo_buyers(bigint[]) FROM PUBLIC;--> statement-breakpoint

-- ===== T-37: seller ledger, COD reconciliation, payouts, refunds (hand-written) =====
-- Hand-written: drizzle-kit models neither policies, grants, triggers, views nor SECURITY DEFINER functions. Appended to the
-- generated statements above (generated statements are untouched). The conductor folds the wave 3 migrations into one;
-- keep this section verbatim. Rules of the ADR-0006 ledger that must hold even when a caller is wrong live HERE, not in
-- TypeScript: one sale per order, a release only for a delivered and reconciled parcel, a debit never takes `available`
-- below zero (the guard takes the per-store advisory lock itself), evidence is unique after normalisation, a step-up proof
-- is consumed in the same transaction as the write it authorises.
-- Guard functions that read other tables are SECURITY DEFINER with a pinned search_path and schema-qualified names (the
-- registry kind `guard`); "the app login" below means a session that is member of neither bukalaris_platform nor
-- bukalaris_owner (the same test as payment_event_insert_guard).

-- ── Row-level security (tenant class) ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "order_financials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_financials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "order_financials" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "order_line_financials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_line_financials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "order_line_financials" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "shipment_cost" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipment_cost" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "shipment_cost" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "ledger_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ledger_entry" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "ledger_entry" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "reconciliation_batch_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reconciliation_batch_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "reconciliation_batch_item" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "payout_destination" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payout_destination" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "payout_destination" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "payout" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payout" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "payout" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "refund" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "refund" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "store_step_up_proof" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_step_up_proof" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "store_step_up_proof" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint

-- ── Grants (the isolation registry columns) ──────────────────────────────────────────────────────────────────────
-- app: checkout writes the financial snapshot; the seller reads the ledger and writes only DEBITS of its own balance (the
-- insert guard below), requests payouts, maintains its destination and consumes its own step-up proof. The worker and
-- the Owner console services (platform pool) book credits, release, reconcile, approve and settle.
REVOKE ALL ON "order_financials", "order_line_financials", "shipment_cost", "ledger_entry", "reconciliation_batch", "reconciliation_batch_item", "payout_destination", "payout", "refund", "store_step_up_proof", "courier_service_policy", "transfer_evidence_artifact", "transfer_evidence_registry" FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "order_financials", "order_line_financials", "ledger_entry", "payout" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON "shipment_cost", "courier_service_policy" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "payout_destination", "refund" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, UPDATE ON "store_step_up_proof" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ("id", "store_id", "order_id", "evidence_date", "reconciled_at", "reconciliation_source") ON "reconciliation_batch_item" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "order_financials", "order_line_financials", "shipment_cost", "transfer_evidence_registry" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ledger_entry", "refund", "reconciliation_batch", "reconciliation_batch_item", "courier_service_policy", "transfer_evidence_artifact" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "payout" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "payout_destination", "store_step_up_proof" TO bukalaris_platform;--> statement-breakpoint

-- ── Immutable financial snapshot: written once with the order, never changed or deleted ─────────────────────────
-- order_financials must equal the order it belongs to (total, subtotal, shipping), and its line rows must add up to it
-- by the end of the checkout transaction (deferred constraint trigger). reset_demo_ledger() below is the only deleter.
CREATE OR REPLACE FUNCTION "financial_snapshot_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  o public."order"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.ledger_reset', true) = 'demo' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% is written once and never changed', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'order_financials' THEN
    SELECT * INTO o FROM public."order" WHERE store_id = NEW.store_id AND id = NEW.order_id;
    IF NOT FOUND OR o.total <> NEW.payable_idr OR o.subtotal <> NEW.subtotal_idr OR o.shipping_fee <> NEW.shipping_charged_idr THEN
      RAISE EXCEPTION 'order_financials must equal the totals of its order' USING ERRCODE = 'check_violation';
    END IF;
    IF o.payment_method <> 'cod' AND (NEW.cod_fee_idr <> 0 OR NEW.cod_fee_vat_idr <> 0) THEN
      RAISE EXCEPTION 'a prepaid order carries no COD fee' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'shipment_cost' THEN
    PERFORM 1 FROM public.order_financials f WHERE f.store_id = NEW.store_id AND f.order_id = NEW.order_id AND f.shipping_charged_idr = NEW.shipping_charged_idr;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'shipment_cost copies the shipping charged of the order financials' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.shipping_debit_entry_id IS NULL AND NEW.seller_shipping_debit_idr > 0 THEN
      RAISE EXCEPTION 'a seller shipping debit needs its ledger entry' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.shipping_debit_entry_id IS NOT NULL THEN
      PERFORM 1 FROM public.ledger_entry e WHERE e.store_id = NEW.store_id AND e.id = NEW.shipping_debit_entry_id AND e.order_id = NEW.order_id AND e.kind = 'shipping_debit' AND e.amount_idr = -NEW.seller_shipping_debit_idr;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'the shipping debit entry must be this order''s debit of the same amount' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "financial_snapshot_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "order_financials_guard" ON "order_financials";--> statement-breakpoint
CREATE TRIGGER "order_financials_guard" BEFORE INSERT OR UPDATE OR DELETE ON "order_financials" FOR EACH ROW EXECUTE FUNCTION "financial_snapshot_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "order_line_financials_guard" ON "order_line_financials";--> statement-breakpoint
CREATE TRIGGER "order_line_financials_guard" BEFORE INSERT OR UPDATE OR DELETE ON "order_line_financials" FOR EACH ROW EXECUTE FUNCTION "financial_snapshot_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "shipment_cost_guard" ON "shipment_cost";--> statement-breakpoint
CREATE TRIGGER "shipment_cost_guard" BEFORE INSERT OR UPDATE OR DELETE ON "shipment_cost" FOR EACH ROW EXECUTE FUNCTION "financial_snapshot_guard"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "financial_lines_check"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n_fin integer;
  n_order integer;
  s_gross bigint;
  s_disc bigint;
  s_inc bigint;
  s_add bigint;
  s_proceeds bigint;
  s_order bigint;
BEGIN
  SELECT count(*), COALESCE(sum(line_gross_idr), 0), COALESCE(sum(discount_alloc_idr), 0), COALESCE(sum(included_tax_idr), 0), COALESCE(sum(added_tax_idr), 0), COALESCE(sum(commission_base_idr), 0)
    INTO n_fin, s_gross, s_disc, s_inc, s_add, s_proceeds
    FROM public.order_line_financials WHERE store_id = NEW.store_id AND order_id = NEW.order_id;
  SELECT count(*), COALESCE(sum(line_total), 0) INTO n_order, s_order FROM public.order_line WHERE store_id = NEW.store_id AND order_id = NEW.order_id;
  IF n_fin <> n_order OR n_fin = 0 OR s_gross <> NEW.subtotal_idr OR s_order <> NEW.subtotal_idr OR s_disc <> NEW.goods_discount_idr
     OR s_inc <> NEW.included_sales_tax_idr OR s_add <> NEW.added_sales_tax_idr OR s_proceeds <> NEW.goods_proceeds_idr THEN
    RAISE EXCEPTION 'the line allocations of order % do not add up to its financial snapshot', NEW.order_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "financial_lines_check"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "order_financials_lines_check" ON "order_financials";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "order_financials_lines_check" AFTER INSERT ON "order_financials" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "financial_lines_check"();--> statement-breakpoint

-- ── The order status writer's database backstop (CRMON-02, ADR-0006 decision 8) ─────────────────────────────────
-- completed, cancelled and returned are terminal; returned is reachable only from shipped (in transit); a delivered parcel is
-- never cancelled or returned (post-delivery claims are four-eyes adjustments). Same-status writes are allowed (no-op).
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
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "order_status_guard" ON "order";--> statement-breakpoint
CREATE TRIGGER "order_status_guard" BEFORE UPDATE OF "status" ON "order" FOR EACH ROW EXECUTE FUNCTION "order_status_guard"();--> statement-breakpoint

-- ── ledger_entry: insert guard ─────────────────────────────────────────────────────────────────────────────────
-- Takes the per-store lock itself (same two-key form as the services, re-entrant), so "available never negative" holds even
-- for a writer that forgot the lock. The seller (app login) may only DEBIT its own balance: payout request or return reversal.
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
REVOKE ALL ON FUNCTION "ledger_entry_insert_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "ledger_entry_insert_guard" ON "ledger_entry";--> statement-breakpoint
CREATE TRIGGER "ledger_entry_insert_guard" BEFORE INSERT ON "ledger_entry" FOR EACH ROW EXECUTE FUNCTION "ledger_entry_insert_guard"();--> statement-breakpoint

-- ── ledger_entry: the one legal change is a pending -> available release ────────────────────────────────────────
-- A COD sale or cashback reaches available only through an applied reconciliation item; a prepaid one only when its order is
-- completed; never for an order that has a return reversal. A debit (or its reversal) follows its own sale, or nets against
-- the next release of the store when its parcel never earned a sale (OPEN-F6), and never takes available below zero.
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
      IF o.status NOT IN ('cancelled', 'returned') OR (s.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ledger_entry r WHERE r.store_id = NEW.store_id AND r.order_id = NEW.order_id AND r.kind = 'return_reversal')) THEN
        RAISE EXCEPTION 'only the debit of a parcel that earned no sale is netted' USING ERRCODE = 'check_violation';
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
REVOKE ALL ON FUNCTION "ledger_entry_change_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "ledger_entry_change_guard" ON "ledger_entry";--> statement-breakpoint
CREATE TRIGGER "ledger_entry_change_guard" BEFORE UPDATE OR DELETE ON "ledger_entry" FOR EACH ROW EXECUTE FUNCTION "ledger_entry_change_guard"();--> statement-breakpoint

-- ── Reconciliation batch and items ──────────────────────────────────────────────────────────────────────────────
-- States draft -> pending_approval -> applied | void (draft -> void too). An applied or void batch is immutable. Applying needs
-- every live item to match its COD amount (a mismatch is a break, never released) and the preparer is not the approver (CHECK).
-- A `provider` batch exists only while the transaction-local flag bukalaris.provider_reconciliation = on (the service sets it
-- from PROVIDER_RECONCILIATION_ENABLED, OPEN-F8, default false).
CREATE OR REPLACE FUNCTION "reconciliation_batch_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n integer;
  v_sum bigint;
  v_bad integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reconciliation batches are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a reconciliation batch starts as a draft' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.source = 'provider' AND pg_catalog.current_setting('bukalaris.provider_reconciliation', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'provider reconciliation is off (OPEN-F8)' USING ERRCODE = 'feature_not_supported';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('applied', 'void') THEN
    RAISE EXCEPTION 'an applied or void reconciliation batch is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (OLD.status = NEW.status OR (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'void')) OR (OLD.status = 'pending_approval' AND NEW.status IN ('applied', 'void'))) THEN
    RAISE EXCEPTION 'illegal batch move % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.source, NEW.evidence_ref, NEW.prepared_by_user_id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.source, OLD.evidence_ref, OLD.prepared_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'the identity of a reconciliation batch is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IN ('pending_approval', 'applied') THEN
    SELECT count(*), COALESCE(sum(evidence_amount_idr), 0), count(*) FILTER (WHERE evidence_amount_idr <> cod_amount_idr)
      INTO n, v_sum, v_bad FROM public.reconciliation_batch_item WHERE batch_id = NEW.id AND voided_at IS NULL;
    IF n = 0 OR n <> NEW.item_count OR v_sum <> NEW.evidence_total_idr OR NEW.payload_sha256 IS NULL THEN
      RAISE EXCEPTION 'the batch header must equal its items (count, evidence total, payload hash)' USING ERRCODE = 'check_violation';
    END IF;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'a batch with an amount break is never submitted or applied' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "reconciliation_batch_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "reconciliation_batch_guard" ON "reconciliation_batch";--> statement-breakpoint
CREATE TRIGGER "reconciliation_batch_guard" BEFORE INSERT OR UPDATE OR DELETE ON "reconciliation_batch" FOR EACH ROW EXECUTE FUNCTION "reconciliation_batch_guard"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reconciliation_item_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  o public."order"%ROWTYPE;
  f public.order_financials%ROWTYPE;
  b public.reconciliation_batch%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.ledger_reset', true) = 'demo' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'reconciliation items are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO o FROM public."order" WHERE store_id = NEW.store_id AND id = NEW.order_id;
    SELECT * INTO f FROM public.order_financials WHERE store_id = NEW.store_id AND order_id = NEW.order_id;
    SELECT * INTO b FROM public.reconciliation_batch WHERE id = NEW.batch_id;
    IF o.id IS NULL OR o.payment_method <> 'cod' OR o.status <> 'completed' THEN
      RAISE EXCEPTION 'a reconciliation item needs a delivered COD order' USING ERRCODE = 'check_violation';
    END IF;
    IF f.order_id IS NULL OR NEW.cod_amount_idr <> f.payable_idr THEN
      RAISE EXCEPTION 'the item COD amount is the order payable' USING ERRCODE = 'check_violation';
    END IF;
    IF b.id IS NULL OR b.status <> 'draft' OR NEW.reconciliation_source <> b.source OR NEW.reconciled_at IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'items are added unreconciled to a draft batch of the same source' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.batch_id, NEW.order_id, NEW.store_id, NEW.cod_amount_idr, NEW.evidence_line_ref, NEW.evidence_amount_idr, NEW.evidence_date, NEW.reconciliation_source)
     IS DISTINCT FROM (OLD.id, OLD.batch_id, OLD.order_id, OLD.store_id, OLD.cod_amount_idr, OLD.evidence_line_ref, OLD.evidence_amount_idr, OLD.evidence_date, OLD.reconciliation_source) THEN
    RAISE EXCEPTION 'reconciliation evidence is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at THEN
    SELECT * INTO b FROM public.reconciliation_batch WHERE id = NEW.batch_id;
    IF OLD.reconciled_at IS NOT NULL OR b.status <> 'applied' THEN
      RAISE EXCEPTION 'an item is reconciled once, when its batch is applied' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS DISTINCT FROM OLD.voided_at THEN
    RAISE EXCEPTION 'an item is voided once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL AND OLD.reconciled_at IS NOT NULL THEN
    RAISE EXCEPTION 'an applied item is never voided' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "reconciliation_item_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "reconciliation_item_guard" ON "reconciliation_batch_item";--> statement-breakpoint
CREATE TRIGGER "reconciliation_item_guard" BEFORE INSERT OR UPDATE OR DELETE ON "reconciliation_batch_item" FOR EACH ROW EXECUTE FUNCTION "reconciliation_item_guard"();--> statement-breakpoint

-- ── Step-up proof (seller): single use, bound, and only ever consumed once ─────────────────────────────────────
-- Issued only by issue_store_step_up(); the app login can only move consumed_at from NULL to now(), and not after expiry.
CREATE OR REPLACE FUNCTION "store_step_up_proof_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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
DROP TRIGGER IF EXISTS "store_step_up_proof_guard" ON "store_step_up_proof";--> statement-breakpoint
CREATE TRIGGER "store_step_up_proof_guard" BEFORE UPDATE OR DELETE ON "store_step_up_proof" FOR EACH ROW EXECUTE FUNCTION "store_step_up_proof_guard"();--> statement-breakpoint

-- The only way to obtain a proof. Trusts nothing the caller says about itself: the session must exist, belong to the user and
-- be live, the user must own the store, and THIS session must have verified a second factor within the window.
CREATE OR REPLACE FUNCTION issue_store_step_up(p_store_id bigint, p_user_id text, p_session_id text, p_action text, p_subject_kind text, p_subject_id text, p_window_seconds integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid step-up window' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.membership m WHERE m.store_id = p_store_id AND m.user_id = p_user_id AND m.role = 'owner') THEN
    RAISE EXCEPTION 'reauth_required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.store_step_up_proof (store_id, user_id, session_id, action_key, subject_kind, subject_id, expires_at)
  SELECT p_store_id, p_user_id, p_session_id, p_action, p_subject_kind, p_subject_id, pg_catalog.now() + pg_catalog.make_interval(secs => p_window_seconds)
    FROM public.session s JOIN public.session_mfa mf ON mf.session_id = s.id AND mf.user_id = s.user_id
   WHERE s.id = p_session_id AND s.user_id = p_user_id AND s.expires_at > pg_catalog.now()
     AND mf.verified_at > pg_catalog.now() - pg_catalog.make_interval(secs => p_window_seconds)
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'reauth_required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_id;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION issue_store_step_up(bigint, text, text, text, text, text, integer) FROM PUBLIC, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION issue_store_step_up(bigint, text, text, text, text, text, integer) TO bukalaris_app;--> statement-breakpoint

-- ── Payout destination ───────────────────────────────────────────────────────────────────────────────────────────
-- A new destination starts `held` for a hold in the future (the service applies PAYOUT_DESTINATION_HOLD_HOURS, D-19), and only
-- with a proof of this store and user for this action that was consumed in THIS transaction. It becomes active only after its
-- hold, and a destination is never edited: a change is a new row that supersedes the previous one.
CREATE OR REPLACE FUNCTION "payout_destination_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.ledger_reset', true) = 'demo' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payout destinations are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'held' OR NEW.hold_until IS NULL OR NEW.hold_until <= pg_catalog.now() THEN
      RAISE EXCEPTION 'a new payout destination is held until a future time' USING ERRCODE = 'check_violation';
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
REVOKE ALL ON FUNCTION "payout_destination_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payout_destination_guard" ON "payout_destination";--> statement-breakpoint
CREATE TRIGGER "payout_destination_guard" BEFORE INSERT OR UPDATE OR DELETE ON "payout_destination" FOR EACH ROW EXECUTE FUNCTION "payout_destination_guard"();--> statement-breakpoint

-- ── Payout ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Insert: requested, snapshot equal to an ACTIVE destination whose hold elapsed, proof consumed in this transaction.
-- Change: only the legal moves (requested -> processing needs the approval, processing -> paid needs a LIVE claim of the same
-- operator, rejection from processing needs the no-transfer evidence), an exclusive claim lease, and the unknown-outcome marker
-- (which only a final move clears). Pairing with the ledger is a deferred constraint trigger.
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
  IF NEW.status = 'processing' AND OLD.status = 'requested' AND (NEW.claimed_by_user_id IS NOT NULL OR NEW.transfer_unknown_at IS NOT NULL) THEN
    RAISE EXCEPTION 'approval and claim are separate steps' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.claimed_by_user_id IS DISTINCT FROM OLD.claimed_by_user_id AND NEW.claimed_by_user_id IS NOT NULL AND OLD.status = 'processing'
     AND OLD.claimed_by_user_id IS NOT NULL AND OLD.claim_expires_at > pg_catalog.now() AND OLD.claimed_by_user_id <> NEW.claimed_by_user_id THEN
    RAISE EXCEPTION 'PAYOUT_ALREADY_CLAIMED' USING ERRCODE = 'lock_not_available';
  END IF;
  IF OLD.transfer_unknown_at IS NOT NULL AND NEW.transfer_unknown_at IS NULL AND NEW.status = 'processing' THEN
    RAISE EXCEPTION 'an unknown transfer outcome stays until a final decision' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'paid' AND (OLD.claimed_by_user_id IS NULL OR OLD.claim_expires_at <= pg_catalog.now() OR OLD.claimed_by_user_id <> NEW.processed_by_user_id) THEN
    RAISE EXCEPTION 'a payout is marked paid only by the operator holding a live claim' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "payout_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payout_guard" ON "payout";--> statement-breakpoint
CREATE TRIGGER "payout_guard" BEFORE INSERT OR UPDATE OR DELETE ON "payout" FOR EACH ROW EXECUTE FUNCTION "payout_guard"();--> statement-breakpoint

-- A payout is always paired with its ledger rows by the end of the transaction: the debit when it is created, and the
-- reversal if and only if it is rejected.
CREATE OR REPLACE FUNCTION "payout_pairing_check"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n_debit integer;
  n_rev integer;
BEGIN
  SELECT count(*) FILTER (WHERE kind = 'payout' AND amount_idr = -NEW.amount_idr), count(*) FILTER (WHERE kind = 'payout_reversal' AND amount_idr = NEW.amount_idr)
    INTO n_debit, n_rev FROM public.ledger_entry WHERE store_id = NEW.store_id AND payout_id = NEW.id;
  IF n_debit <> 1 OR n_rev <> (CASE WHEN NEW.status = 'rejected' THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'payout % must be paired with exactly its debit, and its reversal only when rejected', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "payout_pairing_check"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payout_pairing_check" ON "payout";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "payout_pairing_check" AFTER INSERT OR UPDATE OF "status" ON "payout" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "payout_pairing_check"();--> statement-breakpoint

-- ── Refund ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Created for a paid prepaid order that is terminal (cancelled/returned) or for a late payment; the full attempt total, split
-- as BILL-5 says. The buyer's destination may be set while pending; once approved it is frozen (the payload hash covers it).
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
  IF v_app AND (NEW.status, NEW.approval_request_id, NEW.approved_at, NEW.claimed_by_user_id, NEW.claim_expires_at, NEW.transfer_unknown_at, NEW.transfer_evidence_ref, NEW.evidence_artifact_id, NEW.no_transfer_evidence_ref, NEW.processed_by_user_id, NEW.failure_reason)
     IS DISTINCT FROM (OLD.status, OLD.approval_request_id, OLD.approved_at, OLD.claimed_by_user_id, OLD.claim_expires_at, OLD.transfer_unknown_at, OLD.transfer_evidence_ref, OLD.evidence_artifact_id, OLD.no_transfer_evidence_ref, OLD.processed_by_user_id, OLD.failure_reason) THEN
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
  IF OLD.transfer_unknown_at IS NOT NULL AND NEW.transfer_unknown_at IS NULL AND NEW.status = 'processing' THEN
    RAISE EXCEPTION 'an unknown transfer outcome stays until a final decision' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'completed' AND (OLD.claimed_by_user_id IS NULL OR OLD.claim_expires_at <= pg_catalog.now() OR OLD.claimed_by_user_id <> NEW.processed_by_user_id) THEN
    RAISE EXCEPTION 'a refund is completed only by the operator holding a live claim' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'failed' AND OLD.status = 'processing' AND NEW.no_transfer_evidence_ref IS NULL THEN
    RAISE EXCEPTION 'a refund in processing fails only with evidence that no transfer was sent' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "refund_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "refund_guard" ON "refund";--> statement-breakpoint
CREATE TRIGGER "refund_guard" BEFORE INSERT OR UPDATE OR DELETE ON "refund" FOR EACH ROW EXECUTE FUNCTION "refund_guard"();--> statement-breakpoint

-- ── Transfer evidence: a reference is unique AFTER normalisation (database-computed), a file is unique by digest ─
-- Normalisation = lower-case, keep letters and digits only; a normalised reference shorter than 6 is not a reference.
CREATE OR REPLACE FUNCTION "transfer_evidence_registry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the transfer evidence registry is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."norm_ref" := pg_catalog.regexp_replace(pg_catalog.lower(NEW."ref_raw"), '[^a-z0-9]', '', 'g');
  IF pg_catalog.length(NEW."norm_ref") < 6 THEN
    RAISE EXCEPTION 'a transfer reference needs at least 6 letters or digits' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "transfer_evidence_registry_guard" ON "transfer_evidence_registry";--> statement-breakpoint
CREATE TRIGGER "transfer_evidence_registry_guard" BEFORE INSERT OR UPDATE OR DELETE ON "transfer_evidence_registry" FOR EACH ROW EXECUTE FUNCTION "transfer_evidence_registry_guard"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "transfer_evidence_artifact_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.ledger_reset', true) = 'demo' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'receipt files are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."claimed_by" IS NOT NULL OR NEW."claimed_by" IS NULL
     OR (NEW."id", NEW."sha256", NEW."kind", NEW."size_bytes", NEW."content_base64", NEW."uploaded_by_user_id", NEW."created_at")
        IS DISTINCT FROM (OLD."id", OLD."sha256", OLD."kind", OLD."size_bytes", OLD."content_base64", OLD."uploaded_by_user_id", OLD."created_at") THEN
    RAISE EXCEPTION 'a receipt file is claimed once by one payout or refund and never edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "transfer_evidence_artifact_guard" ON "transfer_evidence_artifact";--> statement-breakpoint
CREATE TRIGGER "transfer_evidence_artifact_guard" BEFORE UPDATE OR DELETE ON "transfer_evidence_artifact" FOR EACH ROW EXECUTE FUNCTION "transfer_evidence_artifact_guard"();--> statement-breakpoint

-- ── COD service allow-list: data, not code (ADR-0006 decision 4). SPX only, UNVERIFIED (OPEN-F7, live gate) ────────
INSERT INTO "courier_service_policy" ("courier_code", "service_code", "cod_allowed", "return_free", "return_free_evidence_ref", "status", "updated_by")
VALUES ('SPX', '', true, true, NULL, 'active', 'migration:t37') ON CONFLICT ("courier_code", "service_code") DO NOTHING;--> statement-breakpoint

-- ── Periodic job kinds (JOB-24 ledger.release, JOB-33 cod.reconciliation.poll: a no-op while provider reconciliation is off) ──
INSERT INTO "platform_job_kind" ("kind") VALUES ('ledger.release'), ('cod.reconciliation.poll') ON CONFLICT ("kind") DO NOTHING;--> statement-breakpoint

-- ── Read-only views (security_invoker: the caller's own privileges and row-level security apply) ────────────────
-- seller_order_entitlement is derived, never stored: sale + cashback + the shipping debit entries (ADR-0006 decision 2).
-- platform_money_position classifies the money by liability class from the append-only tables; it is not a second ledger.
-- Neither joins "order". Affiliate classes arrive with T-53 (no affiliate table exists yet).
CREATE OR REPLACE VIEW "seller_order_entitlement" WITH (security_invoker = true) AS
SELECT f.store_id, f.order_id,
       f.sale_amount_idr + f.seller_cashback_idr + COALESCE((SELECT sum(e.amount_idr) FROM public.ledger_entry e WHERE e.store_id = f.store_id AND e.order_id = f.order_id AND e.kind IN ('shipping_debit', 'shipping_debit_reversal')), 0) AS entitlement_idr
  FROM public.order_financials f;--> statement-breakpoint
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
UNION ALL SELECT 'platform_payment_fee_margin', COALESCE(sum(admin_fee_idr - provider_fee_idr), 0)::bigint FROM public.payment_attempt WHERE status = 'paid' AND provider_fee_idr IS NOT NULL;--> statement-breakpoint
REVOKE ALL ON "seller_order_entitlement", "platform_money_position" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON "seller_order_entitlement" TO bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "platform_money_position" TO bukalaris_platform;--> statement-breakpoint

-- ── Local demo reset (packages/db/src/demo/seed-demo.ts) ─────────────────────────────────────────────────────────
-- The ledger tables refuse DELETE for every login role. Like reset_demo_payments this owner-side function removes the rows of
-- stores whose slug starts with 'demo-' only, with the transaction-local marker the guards honour, and NO login role may call it.
-- It must run BEFORE reset_demo_payments (refunds reference payment attempts).
CREATE OR REPLACE FUNCTION reset_demo_ledger(p_store_ids bigint[]) RETURNS bigint
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
  PERFORM pg_catalog.set_config('bukalaris.ledger_reset', 'demo', true);
  DELETE FROM public.transfer_evidence_registry WHERE (subject_kind = 'payout' AND subject_id IN (SELECT id FROM public.payout WHERE store_id = ANY (v_ids))) OR (subject_kind = 'refund' AND subject_id IN (SELECT id FROM public.refund WHERE store_id = ANY (v_ids)));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.shipment_cost WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.ledger_entry WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.reconciliation_batch_item WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.refund WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payout WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payout_destination WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.store_step_up_proof WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.order_line_financials WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.order_financials WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  PERFORM pg_catalog.set_config('bukalaris.ledger_reset', '', true);
  RETURN v_total;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION reset_demo_ledger(bigint[]) FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint

-- ===== T-63: account governance guards, grants, definer functions, four-eyes seed (hand-written) =====
-- Everything below is written by hand and idempotent where Postgres allows it. The generated statements above are untouched.

-- 1. Four-eyes: the staff-target variant of `mfa.reset` (IAM-15). Capability staff.manage, never accounts.*. A migration is the only writer of the matrix.
INSERT INTO "four_eyes_rule" ("action_key", "capability", "phase", "max_validity", "active") VALUES
  ('staff.mfa_reset', 'staff.manage', 'P1', interval '24 hours', true)
ON CONFLICT ("action_key") DO NOTHING;--> statement-breakpoint

-- 2. Platform-class grants (no bukalaris_app privilege anywhere). Default privileges would hand the platform role everything:
--    reduce to the registry's per-table privileges. History and decision tables get INSERT only.
REVOKE ALL ON "support_case", "support_case_note", "account_status_event", "support_action", "account_verification", "store_risk_ack", "support_recovery_link", "access_review_decision" FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "support_case" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "support_case_note" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "account_status_event" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "support_action" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "account_verification" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "store_risk_ack" TO bukalaris_platform;--> statement-breakpoint
-- Wave 3 review (T-63 P2): the platform login has SELECT only; links are created by support_recovery_create() below, so a compromised
-- platform login cannot insert a link with a token hash it chose and redeem it at the public page.
GRANT SELECT ON "support_recovery_link" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "access_review_decision" TO bukalaris_platform;--> statement-breakpoint
-- Staff deactivation (SA-38) is the one new write the platform pool gets on an existing table.
GRANT SELECT, UPDATE ON "platform_operator" TO bukalaris_platform;--> statement-breakpoint

-- 3. Append-only history and decisions (also against the table owner, who the REVOKE above does not bind).
DROP TRIGGER IF EXISTS "support_case_note_append_only" ON "support_case_note";--> statement-breakpoint
CREATE TRIGGER "support_case_note_append_only" BEFORE UPDATE OR DELETE ON "support_case_note" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "account_status_event_append_only" ON "account_status_event";--> statement-breakpoint
CREATE TRIGGER "account_status_event_append_only" BEFORE UPDATE OR DELETE ON "account_status_event" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "access_review_decision_append_only" ON "access_review_decision";--> statement-breakpoint
CREATE TRIGGER "access_review_decision_append_only" BEFORE UPDATE OR DELETE ON "access_review_decision" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "store_risk_ack_append_only" ON "store_risk_ack";--> statement-breakpoint
CREATE TRIGGER "store_risk_ack_append_only" BEFORE UPDATE OR DELETE ON "store_risk_ack" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();--> statement-breakpoint

-- 4. support_case: identity fields are immutable, only the legal moves of DATA-14 happen, a closed case never changes again.
CREATE OR REPLACE FUNCTION "support_case_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support_case rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."id", NEW."kind", NEW."subject_kind", NEW."subject_id", NEW."opened_by_user_id", NEW."source", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."kind", OLD."subject_kind", OLD."subject_id", OLD."opened_by_user_id", OLD."source", OLD."created_at") THEN
    RAISE EXCEPTION 'the identity of a support case is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'closed' THEN
    RAISE EXCEPTION 'a closed support case never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'open' AND NEW."status" = 'in_progress')
    OR (OLD."status" = 'in_progress' AND NEW."status" IN ('waiting', 'resolved'))
    OR (OLD."status" = 'waiting' AND NEW."status" = 'in_progress')
    OR (OLD."status" = 'resolved' AND NEW."status" IN ('closed', 'open'))) THEN
    RAISE EXCEPTION 'illegal support case transition % -> %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "support_case_guard" ON "support_case";--> statement-breakpoint
CREATE TRIGGER "support_case_guard" BEFORE UPDATE OR DELETE ON "support_case" FOR EACH ROW EXECUTE FUNCTION "support_case_guard"();--> statement-breakpoint

-- 5. support_action: derived from the four-eyes matrix through four_eyes_rule (no hard-coded kind list). A row with an action_key
--    can only become executed when its own approval request, made by the same person for the same action key, was executed.
CREATE OR REPLACE FUNCTION "support_action_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support_action rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('requested', 'awaiting_approval') THEN
      RAISE EXCEPTION 'a support action starts requested or awaiting approval' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."action_key" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."four_eyes_rule" r WHERE r."action_key" = NEW."action_key" AND r."active") THEN
      RAISE EXCEPTION 'four-eyes action % is not active', NEW."action_key" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."case_id", NEW."subject_kind", NEW."subject_id", NEW."action_kind", NEW."action_key", NEW."requested_by", NEW."idempotency_key", NEW."reason_code", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."case_id", OLD."subject_kind", OLD."subject_id", OLD."action_kind", OLD."action_key", OLD."requested_by", OLD."idempotency_key", OLD."reason_code", OLD."created_at") THEN
    RAISE EXCEPTION 'the identity of a support action is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."approval_request_id" IS NOT NULL AND NEW."approval_request_id" IS DISTINCT FROM OLD."approval_request_id" THEN
    RAISE EXCEPTION 'the approval of a support action is bound once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'requested' AND NEW."status" IN ('awaiting_approval', 'executed', 'failed', 'cancelled'))
    OR (OLD."status" = 'awaiting_approval' AND NEW."status" IN ('approved', 'cancelled', 'failed'))
    OR (OLD."status" = 'approved' AND NEW."status" IN ('executed', 'failed', 'cancelled'))) THEN
    RAISE EXCEPTION 'illegal support action transition % -> %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = OLD."status" AND OLD."status" IN ('executed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'a finished support action never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'executed' AND NEW."action_key" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public."approval_request" a
       WHERE a."id" = NEW."approval_request_id" AND a."action_key" = NEW."action_key" AND a."status" = 'executed' AND a."requested_by" = NEW."requested_by") THEN
    RAISE EXCEPTION 'a four-eyes support action needs its own executed approval' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "support_action_guard" ON "support_action";--> statement-breakpoint
CREATE TRIGGER "support_action_guard" BEFORE INSERT OR UPDATE OR DELETE ON "support_action" FOR EACH ROW EXECUTE FUNCTION "support_action_guard"();--> statement-breakpoint

-- 6. account_verification: a submitted version is immutable; only the review fields move, forward only. Never deleted.
CREATE OR REPLACE FUNCTION "account_verification_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account_verification rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."id", NEW."subject_kind", NEW."subject_id", NEW."kind", NEW."version", NEW."submitted_by", NEW."submitted_at", NEW."evidence_ref", NEW."verified_name", NEW."contact_email", NEW."contact_phone", NEW."contact_confirmed_at", NEW."registration_number", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."subject_kind", OLD."subject_id", OLD."kind", OLD."version", OLD."submitted_by", OLD."submitted_at", OLD."evidence_ref", OLD."verified_name", OLD."contact_email", OLD."contact_phone", OLD."contact_confirmed_at", OLD."registration_number", OLD."created_at") THEN
    RAISE EXCEPTION 'a submitted verification version is immutable; submit a new version' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'submitted' AND NEW."status" IN ('in_review', 'verified', 'rejected'))
    OR (OLD."status" = 'in_review' AND NEW."status" IN ('verified', 'rejected'))
    OR (OLD."status" = 'verified' AND NEW."status" IN ('revoked', 'expired'))) THEN
    RAISE EXCEPTION 'illegal verification transition % -> %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."decided_at" IS NOT NULL AND (NEW."reviewer_user_id", NEW."decided_at", NEW."decision_reason_code") IS DISTINCT FROM (OLD."reviewer_user_id", OLD."decided_at", OLD."decision_reason_code") AND OLD."status" <> 'verified' THEN
    RAISE EXCEPTION 'the decision of a verification version cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "account_verification_guard" ON "account_verification";--> statement-breakpoint
CREATE TRIGGER "account_verification_guard" BEFORE UPDATE OR DELETE ON "account_verification" FOR EACH ROW EXECUTE FUNCTION "account_verification_guard"();--> statement-breakpoint

-- 7. support_recovery_link: the only change is consumed_at going from NULL to a time, once. Never deleted.
CREATE OR REPLACE FUNCTION "support_recovery_link_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support_recovery_link rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."consumed_at" IS NOT NULL OR NEW."consumed_at" IS NULL
     OR (NEW."id", NEW."token_sha256", NEW."user_id", NEW."support_action_id", NEW."expires_at", NEW."created_at") IS DISTINCT FROM (OLD."id", OLD."token_sha256", OLD."user_id", OLD."support_action_id", OLD."expires_at", OLD."created_at") THEN
    RAISE EXCEPTION 'a support recovery link is consumed once and otherwise immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "support_recovery_link_guard" ON "support_recovery_link";--> statement-breakpoint
CREATE TRIGGER "support_recovery_link_guard" BEFORE UPDATE OR DELETE ON "support_recovery_link" FOR EACH ROW EXECUTE FUNCTION "support_recovery_link_guard"();--> statement-breakpoint

-- 8. History backfill: every store already has exactly one status event, so "every change has an event" holds from the first row.
INSERT INTO "account_status_event" ("subject_kind", "subject_id", "from_status", "to_status", "reason_code", "reason_note", "actor_user_id")
SELECT 'store', s."id"::text, NULL, s."status", 'migration_backfill', 'status at the time account governance (T-63) was introduced', NULL
FROM "store" s
WHERE NOT EXISTS (SELECT 1 FROM "account_status_event" e WHERE e."subject_kind" = 'store' AND e."subject_id" = s."id"::text);--> statement-breakpoint

-- 9. Identity suspension. Only the owner-side function writes user.suspended_at; the platform login holds EXECUTE and the function
--    re-checks that the actor holds accounts.suspend now and that the target is not a staff identity (defence in depth: the
--    service checks both too). The caller (service) records the event and revokes the sessions in the same transaction.
CREATE OR REPLACE FUNCTION console_set_user_suspension(p_actor text, p_user text, p_suspend boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.operator_grant g JOIN public.platform_operator o ON o.user_id = g.user_id
    WHERE g.user_id = p_actor AND o.deactivated_at IS NULL AND g.capability = 'accounts.suspend' AND (g.expires_at IS NULL OR g.expires_at > pg_catalog.now())
  ) THEN
    RAISE EXCEPTION 'the actor does not hold accounts.suspend' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_operator o WHERE o.user_id = p_user) THEN
    RAISE EXCEPTION 'a staff identity is not an account-support target' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_suspend THEN
    UPDATE public."user" SET suspended_at = pg_catalog.now() WHERE id = p_user AND suspended_at IS NULL;
  ELSE
    UPDATE public."user" SET suspended_at = NULL WHERE id = p_user AND suspended_at IS NOT NULL;
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION console_set_user_suspension(text, text, boolean) FROM PUBLIC, bukalaris_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION console_set_user_suspension(text, text, boolean) TO bukalaris_platform;--> statement-breakpoint

-- 10. Second-factor reset. p_capability names the power the actor used: accounts.support for a seller or affiliate account,
--     staff.manage for a staff identity. The target class must match the capability (a staff identity is never reset through
--     accounts.*, an account never through staff.manage). The second factor and every session of the user go in one statement block.
CREATE OR REPLACE FUNCTION console_reset_user_mfa(p_actor text, p_user text, p_capability text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_capability IS NULL OR p_capability NOT IN ('accounts.support', 'staff.manage') THEN
    RAISE EXCEPTION 'unsupported capability for a second-factor reset' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_actor IS NULL OR p_actor = p_user OR NOT EXISTS (
    SELECT 1 FROM public.operator_grant g JOIN public.platform_operator o ON o.user_id = g.user_id
    WHERE g.user_id = p_actor AND o.deactivated_at IS NULL AND g.capability = p_capability AND (g.expires_at IS NULL OR g.expires_at > pg_catalog.now())
  ) THEN
    RAISE EXCEPTION 'the actor may not reset this second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_operator o WHERE o.user_id = p_user) <> (p_capability = 'staff.manage') THEN
    RAISE EXCEPTION 'the target is not of the class this capability serves' USING ERRCODE = 'no_data_found';
  END IF;
  -- Wave 3 review (T-63 P2): a staff identity and a store owner are reset only against a four-eyes approval that the service has just
  -- consumed (executed in the last two minutes, requested by this actor, decided by somebody else who is not the target). A caller that
  -- only knows an operator id cannot skip the second person any more. (The approval rows themselves are still writable by the platform
  -- login until operator identity is restricted, T-59b: this raises the bar, it does not close it.)
  IF p_capability = 'staff.manage' OR EXISTS (SELECT 1 FROM public.membership m WHERE m.user_id = p_user AND m.role = 'owner') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.approval_request a
      WHERE a.action_key = CASE WHEN p_capability = 'staff.manage' THEN 'staff.mfa_reset' ELSE 'mfa.reset' END
        AND a.target_kind = CASE WHEN p_capability = 'staff.manage' THEN 'staff' ELSE 'user' END
        AND a.target_id = p_user AND a.status = 'executed' AND a.requested_by = p_actor
        AND a.decided_by IS NOT NULL AND a.decided_by <> p_actor AND a.decided_by <> p_user
        AND a.executed_at > pg_catalog.now() - interval '2 minutes'
    ) THEN
      RAISE EXCEPTION 'this second-factor reset needs an executed four-eyes approval' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  DELETE FROM public.two_factor WHERE user_id = p_user;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public."user" SET two_factor_enabled = false WHERE id = p_user;
  DELETE FROM public.session WHERE user_id = p_user;
  RETURN n;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION console_reset_user_mfa(text, text, text) FROM PUBLIC, bukalaris_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION console_reset_user_mfa(text, text, text) TO bukalaris_platform;--> statement-breakpoint

-- 10b. Recovery link creation: the only way a row enters support_recovery_link (the platform login has no INSERT). The function checks that
--      the actor holds accounts.support now and that the support action is that actor's own start_recovery action for the same user.
CREATE OR REPLACE FUNCTION support_recovery_create(p_actor text, p_support_action bigint, p_user text, p_token_sha256 text, p_expires timestamptz) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.operator_grant g JOIN public.platform_operator o ON o.user_id = g.user_id
    WHERE g.user_id = p_actor AND o.deactivated_at IS NULL AND g.capability = 'accounts.support' AND (g.expires_at IS NULL OR g.expires_at > pg_catalog.now())
  ) THEN
    RAISE EXCEPTION 'the actor does not hold accounts.support' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.support_action s
    WHERE s.id = p_support_action AND s.action_kind = 'start_recovery' AND s.requested_by = p_actor AND s.subject_id = p_user AND s.status = 'requested'
  ) THEN
    RAISE EXCEPTION 'no matching open recovery action for this actor and user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_operator o WHERE o.user_id = p_user) THEN
    RAISE EXCEPTION 'a staff identity has no support recovery link' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.support_recovery_link (token_sha256, user_id, support_action_id, expires_at)
  VALUES (p_token_sha256, p_user, p_support_action, p_expires) RETURNING id INTO v_id;
  RETURN v_id;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION support_recovery_create(text, bigint, text, text, timestamptz) FROM PUBLIC, bukalaris_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION support_recovery_create(text, bigint, text, text, timestamptz) TO bukalaris_platform;--> statement-breakpoint

-- 11. Support recovery link redemption (single use, expiry). The app role runs the identity page and cannot read the table; this is
--     its only path. The function hashes the presented token itself, so knowing a stored hash is worth nothing. A suspended
--     identity and a staff identity never redeem. It returns the user id once, or NULL.
CREATE OR REPLACE FUNCTION support_recovery_redeem(p_token text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v text;
BEGIN
  IF p_token IS NULL OR pg_catalog.length(p_token) NOT BETWEEN 20 AND 200 THEN
    RETURN NULL;
  END IF;
  UPDATE public.support_recovery_link l SET consumed_at = pg_catalog.now()
  FROM public."user" u
  WHERE l.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex')
    AND l.consumed_at IS NULL AND l.expires_at > pg_catalog.now()
    AND u.id = l.user_id AND u.suspended_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.platform_operator o WHERE o.user_id = u.id)
  RETURNING l.user_id INTO v;
  RETURN v;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION support_recovery_redeem(text) FROM PUBLIC, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION support_recovery_redeem(text) TO bukalaris_app;--> statement-breakpoint

-- 12. Identity suspension lookup for the seller scope on the app pool (the app role cannot read user.suspended_at's reason or any other column of another user).
CREATE OR REPLACE FUNCTION resolve_user_suspended(p_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM public."user" u WHERE u.id = p_user AND u.suspended_at IS NOT NULL) $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_user_suspended(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_user_suspended(text) TO bukalaris_app, bukalaris_platform;--> statement-breakpoint

-- 13. Reveal window lookup (PRIV-9): the latest unexpired `full` access event of this actor for this exact target and field class.
--     Read path of the restricted table, like console_access_events; without a free-text reason.
GRANT CREATE ON SCHEMA public TO bukalaris_restricted;--> statement-breakpoint
CREATE OR REPLACE FUNCTION console_active_reveal(p_actor text, p_target_kind text, p_target_id text, p_field_class text) RETURNS TABLE (case_id text, purpose_code text, expires_at timestamptz, break_glass_grant_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT e.case_id, e.purpose_code, e.expires_at, e.break_glass_grant_id
  FROM public.personal_data_access_event e
  WHERE e.actor_user_id = p_actor AND e.target_kind = p_target_kind AND e.target_id = p_target_id AND e.field_class = p_field_class
    AND e.access_level = 'full' AND e.expires_at > pg_catalog.now()
  ORDER BY e.id DESC
  LIMIT 1
$$;--> statement-breakpoint
ALTER FUNCTION console_active_reveal(text, text, text, text) OWNER TO bukalaris_restricted;--> statement-breakpoint
REVOKE ALL ON FUNCTION console_active_reveal(text, text, text, text) FROM PUBLIC, bukalaris_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION console_active_reveal(text, text, text, text) TO bukalaris_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM bukalaris_restricted;--> statement-breakpoint

-- ===== T-50: platform subscription billing, invoices and seller access policy (hand-written) =====
-- Hand-written: drizzle-kit models neither policies, grants, triggers, SECURITY DEFINER functions nor seeds. Appended to the
-- generated statements above; the conductor folds the wave 3 migrations into one and keeps this section verbatim.
-- Assumes 0011/0012: app_store_id(), platform_job_kind, the roles bukalaris_owner / bukalaris_resolver / bukalaris_platform / bukalaris_app,
-- tax_policy_version (T-65) and its unique key (id, tax_type_code, category_code).

-- ── Seeds: the one all-feature plan (owner decision 2026-10-27, D-17, BILL-7) and the billing controls ───────────────────────────────────
-- effective_from is far in the past so the row is in force for every instant a test or a restore can reach. 3-day trial and grace, PPN off.
INSERT INTO "subscription_plan" ("plan_code", "version", "effective_from", "monthly_dpp_idr", "trial_days", "grace_days", "ppn_enabled", "reason", "created_by")
  VALUES ('all_feature', 1, '2000-01-01 00:00:00+07', 175000, 3, 3, false, 'Keputusan pemilik 2026-10-27: satu paket semua fitur, Rp175.000 per toko per bulan (DPP), PPN mati, trial dan grace 3 hari (D-17, BILL-7)', 'system:migration');--> statement-breakpoint
INSERT INTO "billing_control" ("id", "jobs_frozen", "dunning_enabled", "reason", "changed_by") VALUES (1, false, false, 'initial: dunning stays off until real mail delivery has evidence (T-73, Q-16)', 'system:migration');--> statement-breakpoint
INSERT INTO "platform_job_kind" ("kind") VALUES ('billing.cycle') ON CONFLICT ("kind") DO NOTHING;--> statement-breakpoint

-- ── Row-level security: the five tenant-class tables follow the store policy ─────────────────────────────────────────────────────────────
ALTER TABLE "store_subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_subscription" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "store_subscription" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "subscription_invoice" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_invoice" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "subscription_invoice" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "subscription_payment_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_payment_attempt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "subscription_payment_attempt" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "subscription_payment_callback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_payment_callback" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "subscription_payment_callback" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "subscription_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "subscription_event" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint

-- ── Grants (the isolation registry columns) ───────────────────────────────────────────────────────────────────────────────────────────
-- app (seller Pay, the callback route, the seller views): reads the plan, the subscription, its invoices and attempts; INSERTs an invoice and an
-- attempt (the guards below pin what a row may start as) and callback digests. It never updates anything and holds nothing on events/notices/controls.
-- platform (worker, Owner console): updates state, appends events and notices, flips the controls. It deletes nothing and writes no plan row but an INSERT.
REVOKE ALL ON "subscription_plan", "store_subscription", "subscription_invoice", "subscription_payment_attempt", "subscription_payment_callback", "subscription_event", "subscription_notice", "billing_control" FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "subscription_plan", "store_subscription" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "subscription_invoice", "subscription_payment_attempt", "subscription_payment_callback" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "subscription_plan" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON "store_subscription", "billing_control" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "subscription_invoice", "subscription_payment_attempt" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "subscription_payment_callback" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "subscription_event", "subscription_notice" TO bukalaris_platform;--> statement-breakpoint

-- ── store.suspended_at: the independent operator restriction (DATA-10) ───────────────────────────────────────────────────────────────────
-- It moves only together with "status" (the operator's suspend/reactivate), never with billing: payment, comp and a lapsed period cannot touch
-- it and lifting it cannot touch a debt. The trigger makes the column unwritable on its own; the CHECK says the two never disagree.
UPDATE "store" SET "suspended_at" = now() WHERE "status" = 'suspended' AND "suspended_at" IS NULL;--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_suspended_chk" CHECK (("status" = 'suspended') = ("suspended_at" IS NOT NULL));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "store_suspension_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'suspended' THEN
    IF TG_OP = 'UPDATE' AND OLD."status" = 'suspended' THEN NEW."suspended_at" := OLD."suspended_at"; ELSE NEW."suspended_at" := pg_catalog.now(); END IF;
  ELSE
    NEW."suspended_at" := NULL;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "store_suspension_sync" ON "store";--> statement-breakpoint
CREATE TRIGGER "store_suspension_sync" BEFORE INSERT OR UPDATE ON "store" FOR EACH ROW EXECUTE FUNCTION "store_suspension_sync"();--> statement-breakpoint

-- ── subscription_plan: append-only versions; PPN may only be ON while an effective vat_output policy exists ─────────────────────────────
-- Plain trigger functions: the writers are the migrator and the platform role, both of which read tax_policy_version.
CREATE OR REPLACE FUNCTION "subscription_plan_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d date;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'subscription_plan versions are append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public."subscription_plan" p WHERE p."plan_code" = NEW."plan_code" AND (p."effective_from" >= NEW."effective_from" OR p."version" >= NEW."version")) THEN
    RAISE EXCEPTION 'a plan version must be later than every earlier one (prospective only)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ppn_enabled" THEN
    d := (NEW."effective_from" AT TIME ZONE 'Asia/Jakarta')::date;
    IF NOT EXISTS (
      SELECT 1 FROM public."tax_policy_version" v
       WHERE v."tax_type_code" = 'vat_output' AND v."category_code" = 'subscription' AND v."status" = 'confirmed' AND v."rate_method" = 'per_payment'
         AND v."effective_from" <= d AND (v."effective_to" IS NULL OR d < v."effective_to")
         AND pg_catalog.jsonb_array_length(v."brackets") = 1 AND (v."brackets" -> 0 ->> 'up_to_idr') IS NULL) THEN
      RAISE EXCEPTION 'PPN needs an effective confirmed vat_output policy for the subscription line' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "subscription_plan_guard_ins" ON "subscription_plan";--> statement-breakpoint
CREATE TRIGGER "subscription_plan_guard_ins" BEFORE INSERT ON "subscription_plan" FOR EACH ROW EXECUTE FUNCTION "subscription_plan_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "subscription_plan_guard_mut" ON "subscription_plan";--> statement-breakpoint
CREATE TRIGGER "subscription_plan_guard_mut" BEFORE UPDATE OR DELETE ON "subscription_plan" FOR EACH ROW EXECUTE FUNCTION "subscription_plan_guard"();--> statement-breakpoint

-- ── store_subscription: one per store, bootstrapped by the store itself ────────────────────────────────────────────────────────────────────
-- AFTER INSERT on "store" creates the trial row for EVERY creation path (platform createStore, seller onboarding, seeds): trial_ends_at is the
-- store's creation instant plus the plan's trial days, the anchor is the Jakarta date of it. Definer: the app role may create a store but cannot write this table.
CREATE OR REPLACE FUNCTION "subscription_bootstrap"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p public."subscription_plan"%ROWTYPE; t timestamptz;
BEGIN
  SELECT * INTO p FROM public."subscription_plan" WHERE "plan_code" = 'all_feature' AND "effective_from" <= pg_catalog.now() ORDER BY "effective_from" DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'no subscription plan is in force' USING ERRCODE = 'check_violation'; END IF;
  t := NEW."created_at" + pg_catalog.make_interval(secs => p."trial_days" * 86400);
  INSERT INTO public."store_subscription" ("store_id", "plan_id", "status", "trial_ends_at", "billing_anchor_date", "created_at", "updated_at")
    VALUES (NEW."id", p."id", 'trial', t, (t AT TIME ZONE 'Asia/Jakarta')::date, NEW."created_at", NEW."created_at");
  INSERT INTO public."subscription_event" ("store_id", "kind", "to_status", "actor", "detail")
    VALUES (NEW."id", 'subscription_created', 'trial', 'system:billing', pg_catalog.jsonb_build_object('trialEndsAt', t, 'planId', p."id"));
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "subscription_bootstrap"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "subscription_bootstrap" ON "store";--> statement-breakpoint
CREATE TRIGGER "subscription_bootstrap" AFTER INSERT ON "store" FOR EACH ROW EXECUTE FUNCTION "subscription_bootstrap"();--> statement-breakpoint
-- Stores that exist when this migration runs start a fresh trial now (no lock-out of an existing store; the owner may decide otherwise later).
INSERT INTO "store_subscription" ("store_id", "plan_id", "status", "trial_ends_at", "billing_anchor_date")
  SELECT s."id", p."id", 'trial', now() + pg_catalog.make_interval(secs => p."trial_days" * 86400), ((now() + pg_catalog.make_interval(secs => p."trial_days" * 86400)) AT TIME ZONE 'Asia/Jakarta')::date
    FROM "store" s CROSS JOIN "subscription_plan" p WHERE p."plan_code" = 'all_feature' AND p."version" = 1;--> statement-breakpoint
INSERT INTO "subscription_event" ("store_id", "kind", "to_status", "actor", "detail")
  SELECT "store_id", 'subscription_created', 'trial', 'system:migration', '{"backfill": true}'::jsonb FROM "store_subscription";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "store_subscription_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.billing_evidence_reset', true) = 'demo' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'a store subscription is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."store_id", NEW."plan_id", NEW."trial_ends_at", NEW."billing_anchor_date", NEW."created_at")
     IS DISTINCT FROM (OLD."store_id", OLD."plan_id", OLD."trial_ends_at", OLD."billing_anchor_date", OLD."created_at") THEN
    RAISE EXCEPTION 'the plan, trial end and billing anchor of a subscription are written once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."current_period_end" IS NOT NULL AND NEW."current_period_end" < OLD."current_period_end" THEN
    RAISE EXCEPTION 'covered time never moves backwards' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "store_subscription_guard" ON "store_subscription";--> statement-breakpoint
CREATE TRIGGER "store_subscription_guard" BEFORE UPDATE OR DELETE ON "store_subscription" FOR EACH ROW EXECUTE FUNCTION "store_subscription_guard"();--> statement-breakpoint

-- ── subscription_invoice: what a row may start as (definer), and what may change afterwards ───────────────────────────────────────────────
-- The period follows the BILL-7 formula for (billing_anchor_date, period_index) computed here in SQL from the anchor (never from a previous
-- end), the plan is the version in force now, the DPP is that plan's price, PPN is on only when the plan says so and then equals the
-- effective vat_output policy's flat rate on the policy's base with its rounding. A login without platform membership (the seller Pay path)
-- can only start a pending seller-sourced subscription invoice, so a forged row cannot lower a price, skip tax or grant itself coverage.
CREATE OR REPLACE FUNCTION "subscription_invoice_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  s public."store_subscription"%ROWTYPE;
  p public."subscription_plan"%ROWTYPE;
  v public."tax_policy_version"%ROWTYPE;
  d date;
  v_start date;
  v_end date;
  v_base numeric;
  v_tax numeric;
  v_internal boolean := pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER');
BEGIN
  SELECT * INTO s FROM public."store_subscription" WHERE "store_id" = NEW."store_id";
  IF NOT FOUND THEN RAISE EXCEPTION 'the store has no subscription' USING ERRCODE = 'check_violation'; END IF;
  v_start := (s."billing_anchor_date" + (NEW."period_index" * INTERVAL '1 month'))::date;
  v_end := (s."billing_anchor_date" + ((NEW."period_index" + 1) * INTERVAL '1 month'))::date;
  IF NEW."period_start" <> v_start OR NEW."period_end" <> v_end THEN
    RAISE EXCEPTION 'the period does not follow the billing period formula for this subscription anchor' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO p FROM public."subscription_plan" WHERE "id" = NEW."plan_id";
  IF NOT FOUND OR p."effective_from" > pg_catalog.now()
     OR EXISTS (SELECT 1 FROM public."subscription_plan" q WHERE q."plan_code" = p."plan_code" AND q."effective_from" > p."effective_from" AND q."effective_from" <= pg_catalog.now()) THEN
    RAISE EXCEPTION 'the invoice must use the plan version in force now' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_internal AND (NEW."kind" <> 'subscription' OR NEW."source" <> 'seller' OR NEW."status" <> 'pending' OR NEW."paid_at" IS NOT NULL OR NEW."settlement_source" IS NOT NULL
                         OR NEW."settlement_ref" IS NOT NULL OR NEW."settled_by" IS NOT NULL OR NEW."coverage_applied_at" IS NOT NULL OR NEW."voided_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'a seller can only start a pending subscription invoice' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."kind" = 'subscription' THEN
    IF NEW."status" <> 'pending' OR NEW."coverage_applied_at" IS NOT NULL THEN
      RAISE EXCEPTION 'a subscription invoice starts pending and uncovered' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."dpp_idr" <> p."monthly_dpp_idr" OR NEW."ppn_enabled" <> p."ppn_enabled" THEN
      RAISE EXCEPTION 'the invoice amounts must be the plan version snapshot' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."ppn_enabled" THEN
      d := (pg_catalog.now() AT TIME ZONE 'Asia/Jakarta')::date;
      SELECT * INTO v FROM public."tax_policy_version" t
       WHERE t."id" = NEW."tax_policy_version_id" AND t."tax_type_code" = 'vat_output' AND t."category_code" = 'subscription' AND t."status" = 'confirmed' AND t."rate_method" = 'per_payment'
         AND t."effective_from" <= d AND (t."effective_to" IS NULL OR d < t."effective_to");
      IF NOT FOUND OR pg_catalog.jsonb_array_length(v."brackets") <> 1 OR (v."brackets" -> 0 ->> 'up_to_idr') IS NOT NULL THEN
        RAISE EXCEPTION 'the PPN snapshot needs the effective flat vat_output policy' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."ppn_rate_bps" <> (v."brackets" -> 0 ->> 'rate_bps')::integer THEN
        RAISE EXCEPTION 'the PPN rate snapshot does not match the policy' USING ERRCODE = 'check_violation';
      END IF;
      v_base := NEW."dpp_idr"::numeric * v."base_fraction_bps" / 10000;
      v_base := CASE v."rounding" WHEN 'floor' THEN pg_catalog.floor(v_base) WHEN 'ceil' THEN pg_catalog.ceil(v_base) ELSE pg_catalog.floor(v_base + 0.5) END;
      v_tax := v_base * NEW."ppn_rate_bps" / 10000;
      v_tax := CASE v."rounding" WHEN 'floor' THEN pg_catalog.floor(v_tax) WHEN 'ceil' THEN pg_catalog.ceil(v_tax) ELSE pg_catalog.floor(v_tax + 0.5) END;
      IF NEW."ppn_idr" <> v_tax THEN
        RAISE EXCEPTION 'the PPN amount does not match the effective policy' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NOT v_internal THEN
    RAISE EXCEPTION 'only the platform grants comp coverage' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "subscription_invoice_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "subscription_invoice_guard" ON "subscription_invoice";--> statement-breakpoint
CREATE TRIGGER "subscription_invoice_guard" BEFORE INSERT ON "subscription_invoice" FOR EACH ROW EXECUTE FUNCTION "subscription_invoice_guard"();--> statement-breakpoint
-- Identity and money are immutable; pending moves to paid or void once; the settlement and the coverage marker are written once; void is final.
CREATE OR REPLACE FUNCTION "subscription_invoice_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.billing_evidence_reset', true) = 'demo' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'a subscription invoice is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."id", NEW."store_id", NEW."number", NEW."period_index", NEW."period_start", NEW."period_end", NEW."kind", NEW."plan_id", NEW."dpp_idr", NEW."ppn_enabled", NEW."ppn_rate_bps", NEW."tax_policy_version_id", NEW."ppn_idr", NEW."total_idr", NEW."due_at", NEW."created_at", NEW."source", NEW."created_by", NEW."comp_request_key")
     IS DISTINCT FROM (OLD."id", OLD."store_id", OLD."number", OLD."period_index", OLD."period_start", OLD."period_end", OLD."kind", OLD."plan_id", OLD."dpp_idr", OLD."ppn_enabled", OLD."ppn_rate_bps", OLD."tax_policy_version_id", OLD."ppn_idr", OLD."total_idr", OLD."due_at", OLD."created_at", OLD."source", OLD."created_by", OLD."comp_request_key") THEN
    RAISE EXCEPTION 'the identity and amount snapshot of an invoice are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'void' THEN
    RAISE EXCEPTION 'a void invoice is final' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'paid' AND (NEW."status" <> 'paid' OR NEW."paid_at" IS DISTINCT FROM OLD."paid_at" OR NEW."settlement_source" IS DISTINCT FROM OLD."settlement_source") THEN
    RAISE EXCEPTION 'a paid invoice is never changed or regressed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."coverage_applied_at" IS NOT NULL AND NEW."coverage_applied_at" IS DISTINCT FROM OLD."coverage_applied_at" THEN
    RAISE EXCEPTION 'coverage is applied once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "subscription_invoice_immutable" ON "subscription_invoice";--> statement-breakpoint
CREATE TRIGGER "subscription_invoice_immutable" BEFORE UPDATE OR DELETE ON "subscription_invoice" FOR EACH ROW EXECUTE FUNCTION "subscription_invoice_immutable"();--> statement-breakpoint

-- ── subscription_payment_attempt ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Insert: pending and empty, on a pending subscription invoice of the same store with the same total (plain trigger: the inserting login reads its
-- own store's invoice under RLS). Update: identity and money immutable, paid never regresses, `expired` only once the instruction really expired.
CREATE OR REPLACE FUNCTION "subscription_attempt_insert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'pending' OR NEW."request_state" <> 'in_progress' OR NEW."transaction_id" IS NOT NULL OR NEW."instruction" IS NOT NULL
     OR NEW."paid_at" IS NOT NULL OR NEW."revision" <> 1 OR NEW."provider_fee_idr" IS NOT NULL THEN
    RAISE EXCEPTION 'a subscription payment attempt starts pending and empty' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."subscription_invoice" i WHERE i."store_id" = NEW."store_id" AND i."id" = NEW."invoice_id" AND i."kind" = 'subscription' AND i."status" = 'pending' AND i."total_idr" = NEW."amount_idr") THEN
    RAISE EXCEPTION 'an attempt needs a pending subscription invoice of the same store with the same total' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "subscription_attempt_insert_guard" ON "subscription_payment_attempt";--> statement-breakpoint
CREATE TRIGGER "subscription_attempt_insert_guard" BEFORE INSERT ON "subscription_payment_attempt" FOR EACH ROW EXECUTE FUNCTION "subscription_attempt_insert_guard"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "subscription_attempt_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.billing_evidence_reset', true) = 'demo' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'a subscription payment attempt is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."id", NEW."store_id", NEW."invoice_id", NEW."owner_kind", NEW."owner_id", NEW."local_reference", NEW."reff_id", NEW."channel_code", NEW."customer", NEW."amount_idr", NEW."admin_fee_idr", NEW."total_idr", NEW."expires_at", NEW."created_at", NEW."created_by")
     IS DISTINCT FROM (OLD."id", OLD."store_id", OLD."invoice_id", OLD."owner_kind", OLD."owner_id", OLD."local_reference", OLD."reff_id", OLD."channel_code", OLD."customer", OLD."amount_idr", OLD."admin_fee_idr", OLD."total_idr", OLD."expires_at", OLD."created_at", OLD."created_by") THEN
    RAISE EXCEPTION 'the identity and amounts of a payment attempt are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'paid' AND NEW."status" <> 'paid' THEN
    RAISE EXCEPTION 'a paid payment is never regressed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'expired' AND NEW."status" NOT IN ('expired', 'paid') THEN
    RAISE EXCEPTION 'an expired attempt can only end as paid (a late payment)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'expired' AND OLD."status" <> 'expired' AND NEW."expires_at" > pg_catalog.now() THEN
    RAISE EXCEPTION 'an attempt expires only after its expiry instant' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."paid_at" IS NOT NULL AND NEW."paid_at" IS DISTINCT FROM OLD."paid_at" THEN
    RAISE EXCEPTION 'paid_at is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."transaction_id" IS NOT NULL AND NEW."transaction_id" IS DISTINCT FROM OLD."transaction_id" THEN
    RAISE EXCEPTION 'the provider transaction id is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."instruction" IS NOT NULL AND NEW."instruction" IS DISTINCT FROM OLD."instruction" THEN
    RAISE EXCEPTION 'the payment instruction is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."request_state" IN ('accepted', 'failed') AND NEW."request_state" <> OLD."request_state" THEN
    RAISE EXCEPTION 'a resolved creation outcome does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revision" < OLD."revision" THEN
    RAISE EXCEPTION 'the revision only moves forward' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "subscription_attempt_guard" ON "subscription_payment_attempt";--> statement-breakpoint
CREATE TRIGGER "subscription_attempt_guard" BEFORE UPDATE OR DELETE ON "subscription_payment_attempt" FOR EACH ROW EXECUTE FUNCTION "subscription_attempt_guard"();--> statement-breakpoint

-- ── Creation events are written by the database itself (so the seller path needs no event privilege) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION "subscription_event_writer"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'subscription_invoice' THEN
    INSERT INTO public."subscription_event" ("store_id", "kind", "invoice_id", "to_status", "actor", "detail")
      VALUES (NEW."store_id", 'invoice_created', NEW."id", NEW."status", NEW."created_by",
              pg_catalog.jsonb_build_object('kind', NEW."kind", 'source', NEW."source", 'periodIndex', NEW."period_index", 'totalIdr', NEW."total_idr", 'number', NEW."number"));
  ELSE
    INSERT INTO public."subscription_event" ("store_id", "kind", "invoice_id", "attempt_id", "to_status", "actor", "detail")
      VALUES (NEW."store_id", 'attempt_created', NEW."invoice_id", NEW."id", NEW."status", NEW."created_by",
              pg_catalog.jsonb_build_object('channel', NEW."channel_code", 'totalIdr', NEW."total_idr", 'reference', NEW."local_reference"));
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "subscription_event_writer"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "subscription_invoice_event" ON "subscription_invoice";--> statement-breakpoint
CREATE TRIGGER "subscription_invoice_event" AFTER INSERT ON "subscription_invoice" FOR EACH ROW EXECUTE FUNCTION "subscription_event_writer"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "subscription_attempt_event" ON "subscription_payment_attempt";--> statement-breakpoint
CREATE TRIGGER "subscription_attempt_event" AFTER INSERT ON "subscription_payment_attempt" FOR EACH ROW EXECUTE FUNCTION "subscription_event_writer"();--> statement-breakpoint

-- ── Append-only evidence: events, notices and callback digests are never updated; deleted only by the local demo reset below ───────────────
CREATE OR REPLACE FUNCTION "subscription_evidence_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.current_setting('bukalaris.billing_evidence_reset', true) = 'demo' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "subscription_event_append_only" ON "subscription_event";--> statement-breakpoint
CREATE TRIGGER "subscription_event_append_only" BEFORE UPDATE OR DELETE ON "subscription_event" FOR EACH ROW EXECUTE FUNCTION "subscription_evidence_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "subscription_notice_append_only" ON "subscription_notice";--> statement-breakpoint
CREATE TRIGGER "subscription_notice_append_only" BEFORE UPDATE OR DELETE ON "subscription_notice" FOR EACH ROW EXECUTE FUNCTION "subscription_evidence_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "subscription_callback_append_only" ON "subscription_payment_callback";--> statement-breakpoint
CREATE TRIGGER "subscription_callback_append_only" BEFORE UPDATE OR DELETE ON "subscription_payment_callback" FOR EACH ROW EXECUTE FUNCTION "subscription_evidence_guard"();--> statement-breakpoint
-- The singleton control row can be flipped, never deleted or re-keyed.
CREATE OR REPLACE FUNCTION "billing_control_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'the billing control row is never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "billing_control_guard" ON "billing_control";--> statement-breakpoint
CREATE TRIGGER "billing_control_guard" BEFORE DELETE ON "billing_control" FOR EACH ROW EXECUTE FUNCTION "billing_control_guard"();--> statement-breakpoint

-- ── Resolvers (ADR-0005 amendment 4): both owned by bukalaris_resolver, fixed search_path, one statement ────────────────────────────────────
-- The signed callback reference of a subscription attempt resolves to its store on the app pool. The effective vat_output policies (public tax
-- configuration, no personal data) are read through an owner-owned function (next statement) because the seller Pay path cannot read tax_policy_version.
GRANT SELECT ON "subscription_payment_attempt" TO bukalaris_resolver;--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_subscription_attempt_store(p_reff_id text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT a.store_id FROM public.subscription_payment_attempt a WHERE a.reff_id = p_reff_id $$;--> statement-breakpoint
-- Owner-owned read function (not a resolver: it returns policy rows, not a store): the seller Pay path cannot read tax_policy_version itself.
CREATE OR REPLACE FUNCTION billing_effective_vat(p_on date)
RETURNS TABLE(id bigint, effective_from date, effective_to date, base_fraction_bps integer, brackets jsonb, rounding text, rate_method text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT v.id, v.effective_from, v.effective_to, v.base_fraction_bps, v.brackets, v.rounding, v.rate_method
        FROM public.tax_policy_version v
       WHERE v.tax_type_code = 'vat_output' AND v.category_code = 'subscription' AND v.status = 'confirmed'
         AND v.effective_from <= p_on AND (v.effective_to IS NULL OR p_on < v.effective_to)
       ORDER BY v.id $$;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO bukalaris_resolver;--> statement-breakpoint
ALTER FUNCTION resolve_subscription_attempt_store(text) OWNER TO bukalaris_resolver;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM bukalaris_resolver;--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_subscription_attempt_store(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_effective_vat(date) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_subscription_attempt_store(text) TO bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_effective_vat(date) TO bukalaris_app, bukalaris_platform;--> statement-breakpoint

-- ── Expiring a stale instruction (seller Pay replaces it with a new controlled attempt on the same invoice) ──────────────────────────────────
-- The app role holds no UPDATE on attempts. This definer expires ONE accepted attempt of the caller's own store (app_store_id(), never an argument)
-- and only once its expiry plus the caller's margin has passed; the guard trigger independently refuses an expiry before the expiry instant.
CREATE OR REPLACE FUNCTION subscription_expire_attempt(p_attempt uuid, p_margin_ms integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_rows integer;
BEGIN
  IF p_margin_ms IS NULL OR p_margin_ms < 0 THEN
    RAISE EXCEPTION 'the expiry margin must be zero or more' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.subscription_payment_attempt a
     SET status = 'expired', revision = a.revision + 1
   WHERE a.id = p_attempt AND a.store_id = public.app_store_id() AND a.status IN ('pending', 'unknown') AND a.request_state = 'accepted'
     AND a.expires_at + pg_catalog.make_interval(secs => p_margin_ms / 1000.0) <= pg_catalog.now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 1 THEN
    INSERT INTO public.subscription_event (store_id, kind, invoice_id, attempt_id, to_status, actor, detail)
      SELECT a.store_id, 'attempt_expired', a.invoice_id, a.id, 'expired', 'system:billing', pg_catalog.jsonb_build_object('expiredAt', a.expires_at) FROM public.subscription_payment_attempt a WHERE a.id = p_attempt;
  END IF;
  RETURN v_rows = 1;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION subscription_expire_attempt(uuid, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION subscription_expire_attempt(uuid, integer) TO bukalaris_app, bukalaris_platform;--> statement-breakpoint

-- ── Local demo reset (packages/db/src/demo/seed-demo.ts) ──────────────────────────────────────────────────────────────────────────────────────
-- Same pattern as reset_demo_payments: the platform role cannot delete billing evidence, so an owner-side function removes the rows of stores
-- whose slug starts with 'demo-' (the seed's reserved prefix) and nothing else; it sets the transaction-local marker the guards honour.
CREATE OR REPLACE FUNCTION reset_demo_billing(p_store_ids bigint[]) RETURNS bigint
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
  IF v_ids IS NULL THEN RETURN 0; END IF;
  PERFORM pg_catalog.set_config('bukalaris.billing_evidence_reset', 'demo', true);
  DELETE FROM public.subscription_event WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.subscription_notice WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.subscription_payment_callback WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.subscription_payment_attempt WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.subscription_invoice WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM public.store_subscription WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  PERFORM pg_catalog.set_config('bukalaris.billing_evidence_reset', '', true);
  RETURN v_total;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION reset_demo_billing(bigint[]) FROM PUBLIC, bukalaris_app, bukalaris_platform;
