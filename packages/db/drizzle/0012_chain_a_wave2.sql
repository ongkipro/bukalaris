CREATE TABLE "late_payment_obligation" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"amount_idr" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "late_payment_obligation_chk" CHECK ("late_payment_obligation"."amount_idr" >= 0 and "late_payment_obligation"."status" = 'open')
);
--> statement-breakpoint
CREATE TABLE "payment_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"owner_kind" text DEFAULT 'order' NOT NULL,
	"owner_id" text NOT NULL,
	"request_key" text NOT NULL,
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
	"advice_polls" integer DEFAULT 0 NOT NULL,
	"next_advice_at" timestamp with time zone NOT NULL,
	"final_advice_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempt_reff_id_unique" UNIQUE("reff_id"),
	CONSTRAINT "payment_attempt_transaction_id_unique" UNIQUE("transaction_id"),
	CONSTRAINT "payment_attempt_order_uq" UNIQUE("store_id","order_id"),
	CONSTRAINT "payment_attempt_request_uq" UNIQUE("store_id","request_key"),
	CONSTRAINT "payment_attempt_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "payment_attempt_owner_chk" CHECK ("payment_attempt"."owner_kind" = 'order' and "payment_attempt"."owner_id" = "payment_attempt"."order_id"::text),
	CONSTRAINT "payment_attempt_amount_chk" CHECK ("payment_attempt"."amount_idr" >= 0 and "payment_attempt"."admin_fee_idr" >= 0 and "payment_attempt"."total_idr" = "payment_attempt"."amount_idr" + "payment_attempt"."admin_fee_idr" and "payment_attempt"."total_idr" <= 9007199254740991 and ("payment_attempt"."provider_fee_idr" is null or "payment_attempt"."provider_fee_idr" >= 0)),
	CONSTRAINT "payment_attempt_state_chk" CHECK ("payment_attempt"."request_state" in ('in_progress','accepted','failed','unknown') and "payment_attempt"."status" in ('pending','paid','unknown') and "payment_attempt"."revision" > 0 and "payment_attempt"."advice_polls" >= 0),
	CONSTRAINT "payment_attempt_accepted_chk" CHECK (("payment_attempt"."request_state" <> 'accepted' or ("payment_attempt"."transaction_id" is not null and "payment_attempt"."instruction" is not null)) and ("payment_attempt"."status" <> 'paid' or "payment_attempt"."paid_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "payment_attempt_event" (
	"store_id" bigint NOT NULL,
	"attempt_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempt_event_attempt_id_revision_pk" PRIMARY KEY("attempt_id","revision")
);
--> statement-breakpoint
CREATE TABLE "payment_callback" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_callback_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"attempt_id" uuid NOT NULL,
	"body_sha256" text NOT NULL,
	"raw_body" text,
	"body_shape" jsonb NOT NULL,
	"quarantined" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "payment_callback_digest_uq" UNIQUE("attempt_id","body_sha256"),
	CONSTRAINT "payment_callback_digest_chk" CHECK ("payment_callback"."body_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "payment_observation" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_observation_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"attempt_id" uuid NOT NULL,
	"source" text NOT NULL,
	"classification" text NOT NULL,
	"response_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_observation_class_chk" CHECK ("payment_observation"."classification" in ('paid','pending','unknown'))
);
--> statement-breakpoint
CREATE TABLE "issue_report" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "issue_report_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"surface" text DEFAULT 'owner' NOT NULL,
	"reporter_kind" text DEFAULT 'operator' NOT NULL,
	"reporter_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"page_id" text NOT NULL,
	"route" text NOT NULL,
	"subject_kind" text,
	"subject_id" text,
	"control_id" text,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"description" text NOT NULL,
	"scrubbed" boolean NOT NULL,
	"context" jsonb NOT NULL,
	"linked_log_event_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"duplicate_of" bigint,
	"assignee_id" text,
	"resolution_note" text,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "issue_report_surface_chk" CHECK ("issue_report"."surface" = 'owner' and "issue_report"."reporter_kind" = 'operator'),
	CONSTRAINT "issue_report_category_chk" CHECK ("issue_report"."category" in ('no_response','wrong_result','error_message','page_broken','other')),
	CONSTRAINT "issue_report_severity_chk" CHECK ("issue_report"."severity" in ('low','medium','high','blocking')),
	CONSTRAINT "issue_report_status_chk" CHECK ("issue_report"."status" in ('new','triaged','in_progress','resolved','wont_fix','duplicate')),
	CONSTRAINT "issue_report_description_chk" CHECK (length("issue_report"."description") between 1 and 2000),
	CONSTRAINT "issue_report_context_chk" CHECK (octet_length("issue_report"."context"::text) <= 16384),
	CONSTRAINT "issue_report_duplicate_chk" CHECK (("issue_report"."status" = 'duplicate') = ("issue_report"."duplicate_of" is not null))
);
--> statement-breakpoint
CREATE TABLE "issue_report_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "issue_report_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"report_id" bigint NOT NULL,
	"actor_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_event_kind_chk" CHECK ("issue_report_event"."kind" in ('status','assign','note','view','export'))
);
--> statement-breakpoint
CREATE TABLE "personal_data_access_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "personal_data_access_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_user_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"field_class" text NOT NULL,
	"purpose_code" text NOT NULL,
	"case_id" text,
	"break_glass_grant_id" bigint,
	"reason" text NOT NULL,
	"access_level" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_event_class_chk" CHECK ("personal_data_access_event"."field_class" in ('tax_identity','bank','phone','email','name','address','verification_evidence','buyer_store_links')),
	CONSTRAINT "access_event_level_chk" CHECK ("personal_data_access_event"."access_level" in ('masked','full','export')),
	CONSTRAINT "access_event_purpose_chk" CHECK (length(btrim("personal_data_access_event"."purpose_code")) > 0 and length(btrim("personal_data_access_event"."reason")) > 0),
	CONSTRAINT "access_event_full_chk" CHECK ("personal_data_access_event"."access_level" = 'masked' or ("personal_data_access_event"."case_id" is not null and "personal_data_access_event"."expires_at" is not null and "personal_data_access_event"."expires_at" > "personal_data_access_event"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "tax_computation" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tax_type_code" text NOT NULL,
	"category_code" text NOT NULL,
	"affiliate_id" bigint NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" text DEFAULT 'original' NOT NULL,
	"corrects_computation_id" bigint,
	"correction_key" text,
	"status" text DEFAULT 'computed' NOT NULL,
	"tax_year" integer NOT NULL,
	"tax_identity_id" bigint NOT NULL,
	"policy_version_id" bigint NOT NULL,
	"tax_setting_version_id" bigint NOT NULL,
	"gross_idr" bigint NOT NULL,
	"base_idr" bigint NOT NULL,
	"ytd_base_before_idr" bigint NOT NULL,
	"ytd_tax_before_idr" bigint NOT NULL,
	"tax_idr" bigint NOT NULL,
	"net_idr" bigint NOT NULL,
	"clamped" boolean NOT NULL,
	"inputs" jsonb NOT NULL,
	"inputs_sha256" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recognized_at" timestamp with time zone,
	CONSTRAINT "tax_computation_payout_ref" UNIQUE("id","affiliate_id","gross_idr","tax_idr","net_idr"),
	CONSTRAINT "tax_computation_amounts" CHECK ("tax_computation"."gross_idr" = "tax_computation"."tax_idr" + "tax_computation"."net_idr" and ("tax_computation"."kind" <> 'original' or ("tax_computation"."gross_idr" >= 0 and "tax_computation"."base_idr" >= 0 and "tax_computation"."tax_idr" >= 0 and "tax_computation"."net_idr" >= 0))),
	CONSTRAINT "tax_computation_kind" CHECK ("tax_computation"."source_kind" = 'affiliate_payout' and (("tax_computation"."kind" = 'original' and "tax_computation"."corrects_computation_id" is null and "tax_computation"."correction_key" is null) or ("tax_computation"."kind" = 'correction' and "tax_computation"."corrects_computation_id" is not null and "tax_computation"."correction_key" is not null))),
	CONSTRAINT "tax_computation_state" CHECK ("tax_computation"."status" in ('computed','recognized','void') and (("tax_computation"."status" = 'recognized') = ("tax_computation"."recognized_at" is not null)))
);
--> statement-breakpoint
CREATE TABLE "tax_document" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject_kind" text NOT NULL,
	"affiliate_id" bigint,
	"store_id" bigint,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"number" text NOT NULL,
	"replaces_document_id" bigint,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"tax_computation_id" bigint,
	"subscription_invoice_id" bigint,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" text,
	"delivered_at" timestamp with time zone,
	"official_number" text,
	"filed_on" date,
	CONSTRAINT "tax_document_number" UNIQUE("kind","number"),
	CONSTRAINT "tax_document_subject" CHECK (("tax_document"."subject_kind" = 'affiliate' and coalesce("tax_document"."affiliate_id" > 0, false) and "tax_document"."store_id" is null) or ("tax_document"."subject_kind" = 'store' and coalesce("tax_document"."store_id" > 0, false) and "tax_document"."affiliate_id" is null)),
	CONSTRAINT "tax_document_state" CHECK ("tax_document"."status" in ('issued','replaced','cancelled') and "tax_document"."revision" > 0 and "tax_document"."period_end" > "tax_document"."period_start"),
	CONSTRAINT "tax_document_kind" CHECK ("tax_document"."kind" in ('earnings_statement','withholding_slip','vat_invoice','credit_note','annual_tax_statement') and ("tax_document"."kind" = 'earnings_statement' or "tax_document"."tax_computation_id" is not null or "tax_document"."subscription_invoice_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "tax_document_sequence" (
	"kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"last_value" bigint NOT NULL,
	CONSTRAINT "tax_document_sequence_kind_scope_key_pk" PRIMARY KEY("kind","scope_key"),
	CONSTRAINT "tax_document_sequence_positive" CHECK ("tax_document_sequence"."last_value" > 0)
);
--> statement-breakpoint
CREATE TABLE "tax_entity_profile" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"legal_name" text,
	"entity_kind_label" text,
	"npwp_sealed" text,
	"npwp_key_version" text,
	"pkp_status" text DEFAULT 'unknown' NOT NULL,
	"pkp_since" date,
	"registered_address" text,
	"accountant_label" text,
	"ebupot_access_confirmed_at" timestamp with time zone,
	"efaktur_access_confirmed_at" timestamp with time zone,
	"deposit_account_label" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"confirmed_by" text,
	"advisor_ref" text,
	CONSTRAINT "tax_entity_profile_version_unique" UNIQUE("version"),
	CONSTRAINT "tax_entity_profile_state" CHECK ("tax_entity_profile"."status" in ('draft','confirmed') and "tax_entity_profile"."pkp_status" in ('unknown','pkp','non_pkp')),
	CONSTRAINT "tax_entity_profile_confirmed" CHECK ("tax_entity_profile"."status" <> 'confirmed' or ("tax_entity_profile"."legal_name" is not null and "tax_entity_profile"."entity_kind_label" is not null and "tax_entity_profile"."npwp_sealed" is not null and "tax_entity_profile"."npwp_key_version" is not null and "tax_entity_profile"."pkp_status" <> 'unknown' and "tax_entity_profile"."confirmed_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "tax_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" bigint NOT NULL,
	"event" text NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"evidence_ref" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_identity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"subject_kind" text NOT NULL,
	"affiliate_id" bigint,
	"store_id" bigint,
	"version" integer NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"payee_class" text NOT NULL,
	"id_kind" text NOT NULL,
	"id_sealed" text,
	"id_key_version" text,
	"id_last4" text NOT NULL,
	"id_fingerprint" text,
	"fingerprint_key_id" text,
	"registered_name_sealed" text,
	"pkp_status" text,
	"pkp_since" date,
	"pkp_evidence_ref" text,
	"client_request_key" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"rejection_reason_code" text,
	CONSTRAINT "tax_identity_subject_ref" UNIQUE("id","affiliate_id"),
	CONSTRAINT "tax_identity_affiliate_version" UNIQUE("affiliate_id","version"),
	CONSTRAINT "tax_identity_store_version" UNIQUE("store_id","version"),
	CONSTRAINT "tax_identity_affiliate_request" UNIQUE("affiliate_id","client_request_key"),
	CONSTRAINT "tax_identity_store_request" UNIQUE("store_id","client_request_key"),
	CONSTRAINT "tax_identity_subject" CHECK (("tax_identity"."subject_kind" = 'affiliate' and coalesce("tax_identity"."affiliate_id" > 0, false) and "tax_identity"."store_id" is null) or ("tax_identity"."subject_kind" = 'store' and coalesce("tax_identity"."store_id" > 0, false) and "tax_identity"."affiliate_id" is null)),
	CONSTRAINT "tax_identity_class" CHECK ("tax_identity"."payee_class" in ('individual','entity') and "tax_identity"."id_kind" in ('npwp','nik') and ("tax_identity"."payee_class" <> 'entity' or "tax_identity"."id_kind" = 'npwp')),
	CONSTRAINT "tax_identity_status" CHECK ("tax_identity"."status" in ('submitted','in_review','approved','rejected','superseded','revoked','withdrawn') and "tax_identity"."version" > 0),
	CONSTRAINT "tax_identity_sealed" CHECK (("tax_identity"."id_sealed" is not null and "tax_identity"."id_key_version" is not null and "tax_identity"."registered_name_sealed" is not null and "tax_identity"."id_fingerprint" is not null and "tax_identity"."fingerprint_key_id" is not null) or ("tax_identity"."status" = 'withdrawn' and "tax_identity"."id_sealed" is null and "tax_identity"."id_key_version" is null and "tax_identity"."registered_name_sealed" is null and "tax_identity"."id_fingerprint" is null and "tax_identity"."fingerprint_key_id" is null))
);
--> statement-breakpoint
CREATE TABLE "tax_policy_version" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tax_type_code" text NOT NULL,
	"category_code" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"tax_label" text NOT NULL,
	"source_citation" text NOT NULL,
	"base_fraction_bps" integer NOT NULL,
	"rate_method" text NOT NULL,
	"brackets" jsonb NOT NULL,
	"rounding" text NOT NULL,
	"recognition_event" text NOT NULL,
	"deposit_due_day" integer,
	"report_due_day" integer,
	"identity_kinds_accepted" text[] NOT NULL,
	"clawback_treatment" text DEFAULT 'manual_review' NOT NULL,
	"confirmation_basis" text,
	"advisor_confirmation_ref" text,
	"authored_by" text NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"supersedes_version_id" bigint,
	CONSTRAINT "tax_policy_version_series" UNIQUE("tax_type_code","category_code","version"),
	CONSTRAINT "tax_policy_version_ref" UNIQUE("id","tax_type_code","category_code"),
	CONSTRAINT "tax_policy_type" CHECK (("tax_policy_version"."tax_type_code" = 'commission_withholding' and "tax_policy_version"."category_code" in ('individual','entity') and "tax_policy_version"."recognition_event" = 'payout_paid') or ("tax_policy_version"."tax_type_code" = 'vat_output' and "tax_policy_version"."category_code" in ('subscription','cod_fee') and "tax_policy_version"."recognition_event" in ('invoice_created','payment_confirmed'))),
	CONSTRAINT "tax_policy_parameters" CHECK ("tax_policy_version"."base_fraction_bps" between 0 and 10000 and "tax_policy_version"."rate_method" in ('per_payment','cumulative_true_up') and "tax_policy_version"."rounding" in ('floor','half_up','ceil') and jsonb_typeof("tax_policy_version"."brackets") = 'array' and jsonb_array_length("tax_policy_version"."brackets") > 0 and ("tax_policy_version"."deposit_due_day" is null or "tax_policy_version"."deposit_due_day" between 1 and 31) and ("tax_policy_version"."report_due_day" is null or "tax_policy_version"."report_due_day" between 1 and 31)),
	CONSTRAINT "tax_policy_state" CHECK ("tax_policy_version"."status" in ('draft','submitted','confirmed','rejected','retired') and "tax_policy_version"."version" > 0 and ("tax_policy_version"."effective_to" is null or "tax_policy_version"."effective_to" > "tax_policy_version"."effective_from")),
	CONSTRAINT "tax_policy_confirmation" CHECK ("tax_policy_version"."status" not in ('confirmed','retired') or ("tax_policy_version"."confirmed_by" is not null and "tax_policy_version"."confirmed_at" is not null and coalesce("tax_policy_version"."confirmation_basis" in ('advisor','owner_decision'), false) and ("tax_policy_version"."confirmation_basis" is distinct from 'advisor' or nullif(btrim("tax_policy_version"."advisor_confirmation_ref"), '') is not null) and ("tax_policy_version"."tax_type_code" <> 'commission_withholding' or ("tax_policy_version"."confirmation_basis" is not distinct from 'advisor' and "tax_policy_version"."authored_by" <> "tax_policy_version"."confirmed_by" and "tax_policy_version"."deposit_due_day" is not null and "tax_policy_version"."report_due_day" is not null))))
);
--> statement-breakpoint
CREATE TABLE "tax_setting" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"statements_enabled" boolean DEFAULT true NOT NULL,
	"identity_capture_enabled" boolean DEFAULT false NOT NULL,
	"tax_identity_required_for_payout" boolean DEFAULT false NOT NULL,
	"withholding_enabled" boolean DEFAULT false NOT NULL,
	"pkp_gate_enabled" boolean DEFAULT false NOT NULL,
	"activation_ref" text,
	"entity_profile_id" bigint,
	"notice_approval_ref" text,
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_setting_version_unique" UNIQUE("version"),
	CONSTRAINT "tax_setting_effective_from_unique" UNIQUE("effective_from"),
	CONSTRAINT "tax_setting_withholding" CHECK (not "tax_setting"."withholding_enabled" or ("tax_setting"."tax_identity_required_for_payout" and nullif(btrim("tax_setting"."activation_ref"), '') is not null and "tax_setting"."entity_profile_id" is not null)),
	CONSTRAINT "tax_setting_pkp" CHECK (not "tax_setting"."pkp_gate_enabled" or "tax_setting"."entity_profile_id" is not null),
	CONSTRAINT "tax_setting_notice" CHECK (not "tax_setting"."identity_capture_enabled" or nullif(btrim("tax_setting"."notice_approval_ref"), '') is not null)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_capability" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "purpose_code" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "case_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "subject_kind" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "access_level" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "one_time_purpose" text;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "order_id" bigint;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "recipient" text;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "delivery_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "bodies_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "late_payment_obligation" ADD CONSTRAINT "late_payment_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_payment_obligation" ADD CONSTRAINT "late_payment_attempt_fk" FOREIGN KEY ("store_id","attempt_id") REFERENCES "public"."payment_attempt"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempt_event" ADD CONSTRAINT "payment_event_attempt_fk" FOREIGN KEY ("store_id","attempt_id") REFERENCES "public"."payment_attempt"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_callback" ADD CONSTRAINT "payment_callback_attempt_fk" FOREIGN KEY ("store_id","attempt_id") REFERENCES "public"."payment_attempt"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_observation" ADD CONSTRAINT "payment_observation_attempt_fk" FOREIGN KEY ("store_id","attempt_id") REFERENCES "public"."payment_attempt"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_report" ADD CONSTRAINT "issue_report_reporter_id_platform_operator_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."platform_operator"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_report_event" ADD CONSTRAINT "issue_report_event_report_id_issue_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."issue_report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_computation" ADD CONSTRAINT "tax_computation_tax_setting_version_id_tax_setting_id_fk" FOREIGN KEY ("tax_setting_version_id") REFERENCES "public"."tax_setting"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_computation" ADD CONSTRAINT "tax_computation_identity_fk" FOREIGN KEY ("tax_identity_id","affiliate_id") REFERENCES "public"."tax_identity"("id","affiliate_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_computation" ADD CONSTRAINT "tax_computation_policy_fk" FOREIGN KEY ("policy_version_id","tax_type_code","category_code") REFERENCES "public"."tax_policy_version"("id","tax_type_code","category_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_computation" ADD CONSTRAINT "tax_computation_correction_fk" FOREIGN KEY ("corrects_computation_id") REFERENCES "public"."tax_computation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_document" ADD CONSTRAINT "tax_document_tax_computation_id_tax_computation_id_fk" FOREIGN KEY ("tax_computation_id") REFERENCES "public"."tax_computation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_setting" ADD CONSTRAINT "tax_setting_entity_profile_id_tax_entity_profile_id_fk" FOREIGN KEY ("entity_profile_id") REFERENCES "public"."tax_entity_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_attempt_poll_idx" ON "payment_attempt" USING btree ("next_advice_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_report_idempotency_uq" ON "issue_report" USING btree ("reporter_id","client_request_id");--> statement-breakpoint
CREATE INDEX "issue_report_status_idx" ON "issue_report" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "issue_report_page_idx" ON "issue_report" USING btree ("page_id","status");--> statement-breakpoint
CREATE INDEX "issue_report_dedupe_idx" ON "issue_report" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "issue_event_report_idx" ON "issue_report_event" USING btree ("report_id","id");--> statement-breakpoint
CREATE INDEX "access_event_target_idx" ON "personal_data_access_event" USING btree ("target_kind","target_id","created_at");--> statement-breakpoint
CREATE INDEX "access_event_actor_idx" ON "personal_data_access_event" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "access_event_case_idx" ON "personal_data_access_event" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_computation_original" ON "tax_computation" USING btree ("source_kind","source_id") WHERE "tax_computation"."kind" = 'original';--> statement-breakpoint
CREATE UNIQUE INDEX "tax_computation_correction" ON "tax_computation" USING btree ("corrects_computation_id","correction_key") WHERE "tax_computation"."kind" = 'correction';--> statement-breakpoint
CREATE UNIQUE INDEX "tax_document_affiliate_revision" ON "tax_document" USING btree ("kind","affiliate_id","period_start","period_end","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_document_store_revision" ON "tax_document" USING btree ("kind","store_id","period_start","period_end","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_document_affiliate_issued" ON "tax_document" USING btree ("kind","affiliate_id","period_start","period_end") WHERE "tax_document"."status" = 'issued';--> statement-breakpoint
CREATE UNIQUE INDEX "tax_document_store_issued" ON "tax_document" USING btree ("kind","store_id","period_start","period_end") WHERE "tax_document"."status" = 'issued';--> statement-breakpoint
CREATE UNIQUE INDEX "tax_document_invoice_issued" ON "tax_document" USING btree ("subscription_invoice_id","kind") WHERE "tax_document"."status" = 'issued';--> statement-breakpoint
CREATE INDEX "tax_event_entity" ON "tax_event" USING btree ("entity_kind","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_identity_affiliate_approved" ON "tax_identity" USING btree ("affiliate_id") WHERE "tax_identity"."status" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "tax_identity_store_approved" ON "tax_identity" USING btree ("store_id") WHERE "tax_identity"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "tax_identity_duplicates" ON "tax_identity" USING btree ("id_kind","id_fingerprint") WHERE "tax_identity"."status" in ('submitted','in_review','approved');--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_subject_idx" ON "audit_log" USING btree ("subject_kind","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "mail_outbox_expiry_idx" ON "mail_outbox" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "order" DROP COLUMN "payment_reference";--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_access_level_chk" CHECK ("audit_log"."access_level" is null or "audit_log"."access_level" in ('masked', 'full', 'export', 'write'));--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_outcome_chk" CHECK ("audit_log"."outcome" is null or "audit_log"."outcome" in ('allowed', 'denied'));--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_purpose_chk" CHECK ("mail_outbox"."one_time_purpose" is null or "mail_outbox"."one_time_purpose" in ('invitation', 'recovery', 'buyer_proof', 'support_recovery'));--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_expiry_chk" CHECK ("mail_outbox"."one_time_purpose" is null or "mail_outbox"."expires_at" is not null);--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_status_chk" CHECK ("mail_outbox"."delivery_status" in ('pending', 'accepted', 'bounced', 'failed', 'expired'));--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_recipient_chk" CHECK (("mail_outbox"."order_id" is null and "mail_outbox"."recipient" is null) or ("mail_outbox"."order_id" is not null and "mail_outbox"."recipient" in ('buyer', 'seller') and "mail_outbox"."one_time_purpose" is null));--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_purged_chk" CHECK ("mail_outbox"."bodies_purged_at" is null or ("mail_outbox"."text_body" = '' or "mail_outbox"."text_body" = '[dihapus]') and "mail_outbox"."html_body" is null);--> statement-breakpoint

-- ===== T-73: durable mail, closed app grants and credential-body lifecycle =====
-- Existing order copies gain explicit provenance. Never infer provenance from subject text at runtime.
UPDATE public.mail_outbox m SET order_id = n.order_id, recipient = n.recipient
FROM public.order_notification n
WHERE m.to_email = n.to_email AND m.subject ~ ('#' || n.order_id::text || '([^0-9]|$)');
--> statement-breakpoint
-- Legacy credential bodies have no trusted expiry metadata. Remove them at cutover rather than retain indefinitely.
UPDATE public.mail_outbox SET text_body = '', html_body = NULL, bodies_purged_at = now(), delivery_status = 'failed'
WHERE order_id IS NULL;
--> statement-breakpoint
REVOKE ALL ON public.mail_outbox FROM bukalaris_app;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE public.mail_outbox_id_seq FROM bukalaris_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.mail_outbox TO bukalaris_platform;
--> statement-breakpoint
INSERT INTO public.platform_job_kind(kind) VALUES ('mail.deliver'), ('mail.purge') ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION public.mail_enqueue(p_to text, p_subject text, p_text text, p_html text, p_purpose text, p_expires timestamptz, p_order bigint, p_recipient text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE mid bigint;
BEGIN
  IF p_purpose IS NOT NULL AND (p_expires IS NULL OR p_expires <= now()) THEN
    RAISE EXCEPTION 'one-time mail needs a future expiry' USING ERRCODE = '22023';
  END IF;
  IF p_order IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public."order" o WHERE o.id = p_order
      AND (pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER') OR o.store_id = public.app_store_id())) THEN
      RAISE EXCEPTION 'mail order outside scope' USING ERRCODE = '42501';
    END IF;
    -- Erasure wins over delayed notification rendering.
    IF EXISTS (SELECT 1 FROM public.order_redaction r WHERE r.order_id = p_order) THEN RETURN NULL; END IF;
  END IF;
  INSERT INTO public.mail_outbox(to_email, subject, text_body, html_body, one_time_purpose, expires_at, order_id, recipient)
    VALUES (p_to, p_subject, p_text, p_html, p_purpose, p_expires, p_order, p_recipient) RETURNING id INTO mid;
  INSERT INTO public.job(kind, store_id, key, payload, priority)
    VALUES ('mail.deliver', NULL, 'mail:' || mid::text, jsonb_build_object('mailId', mid), 1);
  PERFORM pg_notify('bukalaris_jobs', 'mail.deliver');
  RETURN mid;
END $$;
--> statement-breakpoint
ALTER FUNCTION public.mail_enqueue(text,text,text,text,text,timestamptz,bigint,text) OWNER TO bukalaris_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mail_enqueue(text,text,text,text,text,timestamptz,bigint,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mail_enqueue(text,text,text,text,text,timestamptz,bigint,text) TO bukalaris_app, bukalaris_platform;
--> statement-breakpoint
CREATE FUNCTION public.mail_privacy_export(p_orders bigint[])
RETURNS TABLE(order_id bigint, to_email text, subject text, text_body text, created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.order_id, m.to_email, m.subject, m.text_body, m.created_at
  FROM public.mail_outbox m JOIN public."order" o ON o.id = m.order_id
  WHERE o.store_id = public.app_store_id() AND o.id = ANY(p_orders)
    AND m.recipient = 'buyer' AND m.one_time_purpose IS NULL
  ORDER BY m.id
$$;
--> statement-breakpoint
ALTER FUNCTION public.mail_privacy_export(bigint[]) OWNER TO bukalaris_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mail_privacy_export(bigint[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mail_privacy_export(bigint[]) TO bukalaris_app, bukalaris_platform;
--> statement-breakpoint
CREATE FUNCTION public.mail_privacy_redact(p_orders bigint[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE public.mail_outbox m SET text_body = '[dihapus]', html_body = NULL,
    to_email = CASE WHEN m.recipient = 'buyer' THEN '[dihapus]' ELSE m.to_email END,
    delivery_status = CASE WHEN m.delivery_status = 'pending' THEN 'failed' ELSE m.delivery_status END,
    bodies_purged_at = now()
  FROM public."order" o
  WHERE o.id = m.order_id AND o.store_id = public.app_store_id() AND o.id = ANY(p_orders)
    AND m.one_time_purpose IS NULL AND (m.text_body <> '[dihapus]' OR m.html_body IS NOT NULL OR (m.recipient = 'buyer' AND m.to_email <> '[dihapus]'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
--> statement-breakpoint
ALTER FUNCTION public.mail_privacy_redact(bigint[]) OWNER TO bukalaris_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mail_privacy_redact(bigint[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mail_privacy_redact(bigint[]) TO bukalaris_app, bukalaris_platform;
--> statement-breakpoint
CREATE FUNCTION public.mail_purge_expired(p_batch integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ids bigint[]; n integer;
BEGIN
  IF p_batch < 1 OR p_batch > 10000 OR p_batch IS NULL THEN
    RAISE EXCEPTION 'mail purge batch must be 1..10000' USING ERRCODE = '22023';
  END IF;
  -- Bodies only, never delivery rows. Expiry is the token's own lifetime.
  SELECT array_agg(m.id) INTO ids FROM public.mail_outbox m
  WHERE m.id IN (SELECT candidate.id FROM public.mail_outbox candidate
    WHERE candidate.one_time_purpose IS NOT NULL AND candidate.expires_at <= now() AND candidate.bodies_purged_at IS NULL
    ORDER BY candidate.id LIMIT p_batch FOR UPDATE SKIP LOCKED);
  UPDATE public.mail_outbox m SET text_body = '', html_body = NULL, bodies_purged_at = now(),
    delivery_status = CASE WHEN m.delivery_status = 'pending' THEN 'expired' ELSE m.delivery_status END
  WHERE m.id = ANY(ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
--> statement-breakpoint
ALTER FUNCTION public.mail_purge_expired(integer) OWNER TO bukalaris_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mail_purge_expired(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mail_purge_expired(integer) TO bukalaris_platform;--> statement-breakpoint

-- ===== T-65 tax foundation: guards, isolation, grants and startup seed =====
-- No extension is required. BILL-9 W2 advisory-lock + constraint-trigger fallback is used.
-- Every confirmed writer, including direct SQL, takes the same transaction lock before checking
-- ranges. The volatile trigger's query after lock acquisition sees the preceding committer.
CREATE FUNCTION public.tax_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN RAISE EXCEPTION 'tax record is append-only' USING ERRCODE = '42501'; END $$;
--> statement-breakpoint
CREATE TRIGGER tax_setting_append_only BEFORE UPDATE OR DELETE ON public.tax_setting FOR EACH ROW EXECUTE FUNCTION public.tax_append_only();
CREATE TRIGGER tax_event_append_only BEFORE UPDATE OR DELETE ON public.tax_event FOR EACH ROW EXECUTE FUNCTION public.tax_append_only();
--> statement-breakpoint
CREATE FUNCTION public.tax_setting_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.withholding_enabled AND NOT EXISTS (SELECT 1 FROM public.tax_entity_profile p WHERE p.id = NEW.entity_profile_id AND p.status = 'confirmed') THEN
    RAISE EXCEPTION 'confirmed entity profile required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_setting_guard BEFORE INSERT ON public.tax_setting FOR EACH ROW EXECUTE FUNCTION public.tax_setting_guard();
--> statement-breakpoint
CREATE FUNCTION public.tax_profile_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'confirmed' THEN RAISE EXCEPTION 'confirmed profile immutable' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_profile_guard BEFORE UPDATE OR DELETE ON public.tax_entity_profile FOR EACH ROW EXECUTE FUNCTION public.tax_profile_guard();
--> statement-breakpoint
CREATE FUNCTION public.tax_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE b jsonb; previous_bound numeric := 0; bound numeric; position integer := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'policy cannot be deleted' USING ERRCODE = '42501'; END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN RAISE EXCEPTION 'policy versions start as draft' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) = to_jsonb(OLD) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status NOT IN ('draft','submitted') THEN RAISE EXCEPTION 'draft policy must be submitted first' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF (to_jsonb(NEW) - ARRAY['status','confirmed_by','confirmed_at','confirmation_basis','advisor_confirmation_ref','effective_to']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','confirmed_by','confirmed_at','confirmation_basis','advisor_confirmation_ref','effective_to']) THEN
      RAISE EXCEPTION 'submitted policy content immutable' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'submitted' THEN
      IF NEW.status NOT IN ('confirmed','rejected') OR NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN RAISE EXCEPTION 'invalid policy transition' USING ERRCODE = '23514'; END IF;
    ELSIF NOT (OLD.status = 'confirmed' AND NEW.status = 'retired' AND NEW.effective_to IS NOT NULL AND (OLD.effective_to IS NULL OR NEW.effective_to <= OLD.effective_to)
      AND (to_jsonb(NEW) - ARRAY['status','effective_to']) = (to_jsonb(OLD) - ARRAY['status','effective_to'])) THEN
      RAISE EXCEPTION 'confirmed policy immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  FOR b IN SELECT value FROM jsonb_array_elements(NEW.brackets) LOOP
    position := position + 1;
    -- NULL-safe (wave 2 review): a bracket without rate_bps must fail here, not only later in the TypeScript module.
    IF NOT coalesce(CASE WHEN jsonb_typeof(b->'rate_bps') = 'number' AND (b->>'rate_bps') ~ '^[0-9]+$' THEN (b->>'rate_bps')::numeric BETWEEN 0 AND 10000 END, false) THEN
      RAISE EXCEPTION 'invalid bracket rate' USING ERRCODE = '23514';
    END IF;
    IF b->'up_to_idr' = 'null'::jsonb THEN
      IF position <> jsonb_array_length(NEW.brackets) THEN RAISE EXCEPTION 'unbounded bracket must be last' USING ERRCODE = '23514'; END IF;
    ELSE
      IF b->>'up_to_idr' IS NULL OR (b->>'up_to_idr') !~ '^[0-9]+$' OR position = jsonb_array_length(NEW.brackets) THEN RAISE EXCEPTION 'last bracket must be unbounded' USING ERRCODE = '23514'; END IF;
      bound := (b->>'up_to_idr')::numeric;
      IF bound <= previous_bound THEN RAISE EXCEPTION 'brackets must ascend' USING ERRCODE = '23514'; END IF;
      previous_bound := bound;
    END IF;
  END LOOP;
  -- The confirmation instant is the database's, never the caller's (wave 2 review): a back-dated confirmed_at must not unlock a past effective_from.
  IF NEW.status = 'confirmed' AND (TG_OP = 'INSERT' OR OLD.status <> 'confirmed') THEN NEW.confirmed_at := pg_catalog.now(); END IF;
  IF NEW.status = 'confirmed' AND NEW.effective_from < (NEW.confirmed_at AT TIME ZONE 'Asia/Jakarta')::date THEN
    RAISE EXCEPTION 'retroactive confirmation refused' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tax_policy_version FOR EACH ROW EXECUTE FUNCTION public.tax_policy_guard();
--> statement-breakpoint
CREATE FUNCTION public.tax_policy_no_overlap() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status = 'confirmed' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('tax.policy:' || NEW.tax_type_code || ':' || NEW.category_code, 0));
    IF EXISTS (SELECT 1 FROM public.tax_policy_version p WHERE p.id <> NEW.id AND p.status = 'confirmed'
      AND p.tax_type_code = NEW.tax_type_code AND p.category_code = NEW.category_code
      AND daterange(p.effective_from, p.effective_to, '[)') && daterange(NEW.effective_from, NEW.effective_to, '[)')) THEN
      RAISE EXCEPTION 'confirmed policy ranges overlap' USING ERRCODE = '23P01';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER tax_policy_no_overlap AFTER INSERT OR UPDATE ON public.tax_policy_version NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION public.tax_policy_no_overlap();
--> statement-breakpoint
CREATE FUNCTION public.tax_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'identity cannot be deleted' USING ERRCODE = '42501'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status','reviewed_by','reviewed_at','rejection_reason_code','id_sealed','registered_name_sealed','id_key_version','id_fingerprint','fingerprint_key_id']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','reviewed_by','reviewed_at','rejection_reason_code','id_sealed','registered_name_sealed','id_key_version','id_fingerprint','fingerprint_key_id']) THEN
    RAISE EXCEPTION 'identity versions immutable' USING ERRCODE = '42501';
  END IF;
  -- Review evidence changes only together with a status change (wave 2 review).
  IF NEW.status = OLD.status AND (NEW.reviewed_by, NEW.reviewed_at, NEW.rejection_reason_code) IS DISTINCT FROM (OLD.reviewed_by, OLD.reviewed_at, OLD.rejection_reason_code) THEN
    RAISE EXCEPTION 'review evidence changes only with a status change' USING ERRCODE = '42501';
  END IF;
  IF ROW(NEW.id_sealed,NEW.registered_name_sealed,NEW.id_key_version,NEW.id_fingerprint,NEW.fingerprint_key_id)
     IS DISTINCT FROM ROW(OLD.id_sealed,OLD.registered_name_sealed,OLD.id_key_version,OLD.id_fingerprint,OLD.fingerprint_key_id) THEN
    IF NEW.status = 'withdrawn' AND NEW.id_sealed IS NULL AND NEW.registered_name_sealed IS NULL AND NEW.id_key_version IS NULL AND NEW.id_fingerprint IS NULL AND NEW.fingerprint_key_id IS NULL THEN
      IF EXISTS (SELECT 1 FROM public.tax_computation c WHERE c.tax_identity_id = OLD.id) THEN RAISE EXCEPTION 'referenced identity retained' USING ERRCODE = '23514'; END IF;
    ELSIF NOT (current_user = 'bukalaris_owner' AND NEW.id_key_version IS DISTINCT FROM OLD.id_key_version
      AND NEW.id_fingerprint IS NOT DISTINCT FROM OLD.id_fingerprint AND NEW.fingerprint_key_id IS NOT DISTINCT FROM OLD.fingerprint_key_id
      AND NEW.status = OLD.status) THEN RAISE EXCEPTION 'sealed identity immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'submitted' AND NEW.status IN ('in_review','withdrawn','superseded')) OR
    (OLD.status = 'in_review' AND NEW.status IN ('approved','rejected')) OR
    (OLD.status = 'approved' AND NEW.status IN ('superseded','revoked')) OR
    (OLD.status IN ('superseded','rejected','revoked') AND NEW.status = 'withdrawn')) THEN
    RAISE EXCEPTION 'invalid identity transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_identity_guard BEFORE UPDATE OR DELETE ON public.tax_identity FOR EACH ROW EXECUTE FUNCTION public.tax_identity_guard();
--> statement-breakpoint
CREATE FUNCTION public.tax_identity_reseal(identity_id bigint, previous_key text, next_key text, identifier_envelope text, name_envelope text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF next_key IS NULL OR next_key !~ '^[a-z0-9._:-]{1,64}$' THEN RAISE EXCEPTION 'invalid key id' USING ERRCODE = '22023'; END IF;
  UPDATE public.tax_identity SET id_key_version = next_key, id_sealed = identifier_envelope, registered_name_sealed = name_envelope
    WHERE id = identity_id AND id_key_version = previous_key AND previous_key <> next_key;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.tax_identity_reseal(bigint,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tax_identity_reseal(bigint,text,text,text,text) TO bukalaris_platform;
--> statement-breakpoint
CREATE FUNCTION public.tax_computation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'computation cannot be deleted' USING ERRCODE = '42501'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.tax_setting s WHERE s.id = NEW.tax_setting_version_id AND s.withholding_enabled) THEN RAISE EXCEPTION 'withholding disabled' USING ERRCODE = '23514'; END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['status','recognized_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','recognized_at'])
      OR (NEW.status <> OLD.status AND NOT (OLD.status = 'computed' AND NEW.status IN ('recognized','void')))
      OR (NEW.status = OLD.status AND NEW.recognized_at IS DISTINCT FROM OLD.recognized_at) THEN
      RAISE EXCEPTION 'computation snapshot immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_computation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tax_computation FOR EACH ROW EXECUTE FUNCTION public.tax_computation_guard();
--> statement-breakpoint
CREATE FUNCTION public.tax_document_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'document cannot be deleted' USING ERRCODE = '42501'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status','delivered_at','official_number','filed_on']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','delivered_at','official_number','filed_on'])
    OR (NEW.status <> OLD.status AND NOT (OLD.status = 'issued' AND NEW.status IN ('replaced','cancelled'))) THEN
    RAISE EXCEPTION 'issued document immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_document_guard BEFORE UPDATE OR DELETE ON public.tax_document FOR EACH ROW EXECUTE FUNCTION public.tax_document_guard();
--> statement-breakpoint
ALTER TABLE public.tax_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY affiliate_isolation ON public.tax_identity USING (affiliate_id = public.app_affiliate_id()) WITH CHECK (affiliate_id = public.app_affiliate_id());
ALTER TABLE public.tax_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_document FORCE ROW LEVEL SECURITY;
CREATE POLICY affiliate_isolation ON public.tax_document USING (affiliate_id = public.app_affiliate_id()) WITH CHECK (affiliate_id = public.app_affiliate_id());
--> statement-breakpoint
REVOKE ALL ON public.tax_setting, public.tax_entity_profile, public.tax_identity, public.tax_policy_version, public.tax_computation, public.tax_document, public.tax_document_sequence, public.tax_event FROM bukalaris_app, bukalaris_platform;
GRANT SELECT, INSERT ON public.tax_setting, public.tax_event TO bukalaris_platform;
GRANT SELECT, INSERT, UPDATE ON public.tax_entity_profile, public.tax_identity, public.tax_policy_version, public.tax_computation, public.tax_document, public.tax_document_sequence TO bukalaris_platform;
GRANT USAGE, SELECT ON SEQUENCE public.tax_setting_id_seq, public.tax_entity_profile_id_seq, public.tax_identity_id_seq, public.tax_policy_version_id_seq, public.tax_computation_id_seq, public.tax_document_id_seq, public.tax_event_id_seq TO bukalaris_platform;
GRANT SELECT (id, subject_kind, affiliate_id, store_id, version, status, payee_class, id_kind, id_last4, submitted_at) ON public.tax_identity TO bukalaris_app;
GRANT SELECT ON public.tax_document TO bukalaris_app;
--> statement-breakpoint
INSERT INTO public.tax_setting (version, effective_from, reason) VALUES (1, 'epoch', 'ADR-0012 startup: statements only');--> statement-breakpoint

-- ===== T-49: payment attempt isolation, grants, guards, resolver, retention, job kinds (hand-written) =====
-- Hand-written: drizzle-kit models neither policies, grants, triggers nor SECURITY DEFINER functions. Appended to the
-- generated statements above. The parent folds the wave 2 migrations into one; keep this section verbatim.
-- Dropping "order"."payment_reference" (first statement of this file) retires the old fake-only reference: instructions
-- are structured rows of "payment_attempt" now. Existing awaiting_payment transfer orders hold only old fake references
-- (no provider was ever called) and get no attempt; a payment.instruction job for such an order finds no attempt and ends.

-- ── Row-level security: every payment table carries the store key and follows the tenant policy ──────────────
ALTER TABLE "payment_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_attempt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "payment_attempt" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "payment_attempt_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_attempt_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "payment_attempt_event" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "payment_callback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_callback" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "payment_callback" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "payment_observation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_observation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "payment_observation" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "late_payment_obligation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "late_payment_obligation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "late_payment_obligation" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint

-- ── Grants (the isolation registry columns) ──────────────────────────────────────────────────────────────────
-- app: checkout inserts the attempt and its first event; the callback route inserts the callback evidence and the
-- buyer/seller views read the attempt. Everything after that (state, observations, obligations) is the worker's.
-- platform: the worker updates the attempt, appends events/observations and opens obligations; it never deletes, and it
-- cannot touch a callback row at all (the raw body is blanked only by redact_payment_callbacks() below).
REVOKE ALL ON "payment_attempt", "payment_attempt_event", "payment_callback", "payment_observation", "late_payment_obligation" FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "payment_attempt", "payment_attempt_event", "payment_callback" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "payment_attempt" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "payment_attempt_event", "payment_observation", "late_payment_obligation" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON "payment_callback" TO bukalaris_platform;--> statement-breakpoint

-- ── Guards ───────────────────────────────────────────────────────────────────────────────────────────────────
-- Identity and money are immutable once the attempt exists, `paid` never regresses, the provider transaction and the
-- instruction are written once, and a terminal creation state never changes. Plain trigger function (reads only OLD/NEW).
CREATE OR REPLACE FUNCTION "payment_attempt_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."store_id", NEW."order_id", NEW."owner_kind", NEW."owner_id", NEW."request_key", NEW."reff_id", NEW."channel_code", NEW."customer", NEW."amount_idr", NEW."admin_fee_idr", NEW."total_idr", NEW."expires_at", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."store_id", OLD."order_id", OLD."owner_kind", OLD."owner_id", OLD."request_key", OLD."reff_id", OLD."channel_code", OLD."customer", OLD."amount_idr", OLD."admin_fee_idr", OLD."total_idr", OLD."expires_at", OLD."created_at") THEN
    RAISE EXCEPTION 'the identity and amounts of a payment attempt are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'paid' AND NEW."status" <> 'paid' THEN
    RAISE EXCEPTION 'a paid payment is never regressed' USING ERRCODE = 'check_violation';
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
DROP TRIGGER IF EXISTS "payment_attempt_guard" ON "payment_attempt";--> statement-breakpoint
CREATE TRIGGER "payment_attempt_guard" BEFORE UPDATE ON "payment_attempt" FOR EACH ROW EXECUTE FUNCTION "payment_attempt_guard"();--> statement-breakpoint
-- Wave 2 review (P3): an app-role INSERT cannot start an attempt in a settled state or point it at a link of its choice: it begins
-- pending and empty, on a non-COD order of the same store whose total it carries. Definer guard (reads "order" under RLS as owner).
CREATE OR REPLACE FUNCTION "payment_attempt_insert_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."status" <> 'pending' OR NEW."request_state" <> 'in_progress' OR NEW."transaction_id" IS NOT NULL OR NEW."instruction" IS NOT NULL
     OR NEW."paid_at" IS NOT NULL OR NEW."revision" <> 1 OR NEW."advice_polls" <> 0 OR NEW."provider_fee_idr" IS NOT NULL THEN
    RAISE EXCEPTION 'a payment attempt starts pending and empty' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."order" o WHERE o."store_id" = NEW."store_id" AND o."id" = NEW."order_id" AND o."payment_method" <> 'cod' AND o."total" = NEW."amount_idr") THEN
    RAISE EXCEPTION 'a payment attempt needs a non-COD order of the same store with the same total' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "payment_attempt_insert_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_attempt_insert_guard" ON "payment_attempt";--> statement-breakpoint
CREATE TRIGGER "payment_attempt_insert_guard" BEFORE INSERT ON "payment_attempt" FOR EACH ROW EXECUTE FUNCTION "payment_attempt_insert_guard"();--> statement-breakpoint
-- Only the first event ("created", revision 1) may come from the app login; later revisions are the worker's (allow-list by role membership).
CREATE OR REPLACE FUNCTION "payment_event_insert_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW."revision" <> 1 OR NEW."kind" <> 'created')
     AND NOT (pg_catalog.pg_has_role(session_user, 'bukalaris_platform', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'bukalaris_owner', 'MEMBER')) THEN
    RAISE EXCEPTION 'only the creation event may be written outside the worker' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "payment_event_insert_guard"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_event_insert_guard" ON "payment_attempt_event";--> statement-breakpoint
CREATE TRIGGER "payment_event_insert_guard" BEFORE INSERT ON "payment_attempt_event" FOR EACH ROW EXECUTE FUNCTION "payment_event_insert_guard"();--> statement-breakpoint
-- The app role inserts callback evidence but never reads the raw body or any column but the ones below ("sellers never receive callback bodies").
REVOKE SELECT ON "payment_callback" FROM bukalaris_app;--> statement-breakpoint
GRANT SELECT ("id", "store_id", "attempt_id", "body_sha256", "body_shape", "quarantined", "created_at", "redacted_at") ON "payment_callback" TO bukalaris_app;--> statement-breakpoint

-- Events, observations and obligations are append-only evidence: never updated, and deleted only by reset_demo_payments() below
-- (a transaction-local marker that only that owner-side function sets; the platform role holds no DELETE privilege anyway).
CREATE OR REPLACE FUNCTION "payment_evidence_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.current_setting('bukalaris.payment_evidence_reset', true) = 'demo' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_attempt_event_append_only" ON "payment_attempt_event";--> statement-breakpoint
CREATE TRIGGER "payment_attempt_event_append_only" BEFORE UPDATE OR DELETE ON "payment_attempt_event" FOR EACH ROW EXECUTE FUNCTION "payment_evidence_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_observation_append_only" ON "payment_observation";--> statement-breakpoint
CREATE TRIGGER "payment_observation_append_only" BEFORE UPDATE OR DELETE ON "payment_observation" FOR EACH ROW EXECUTE FUNCTION "payment_evidence_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "late_payment_obligation_no_delete" ON "late_payment_obligation";--> statement-breakpoint
CREATE TRIGGER "late_payment_obligation_no_delete" BEFORE DELETE ON "late_payment_obligation" FOR EACH ROW EXECUTE FUNCTION "payment_evidence_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_attempt_no_delete" ON "payment_attempt";--> statement-breakpoint
CREATE TRIGGER "payment_attempt_no_delete" BEFORE DELETE ON "payment_attempt" FOR EACH ROW EXECUTE FUNCTION "payment_evidence_guard"();--> statement-breakpoint
-- A callback row is evidence: never deleted, and the only update is blanking the raw body (digest, shape and times stay).
CREATE OR REPLACE FUNCTION "payment_callback_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.payment_evidence_reset', true) = 'demo' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payment_callback rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."id", NEW."store_id", NEW."attempt_id", NEW."body_sha256", NEW."body_shape", NEW."quarantined", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."store_id", OLD."attempt_id", OLD."body_sha256", OLD."body_shape", OLD."quarantined", OLD."created_at")
     OR NEW."raw_body" IS NOT NULL THEN
    RAISE EXCEPTION 'a callback row can only be redacted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_callback_guard" ON "payment_callback";--> statement-breakpoint
CREATE TRIGGER "payment_callback_guard" BEFORE UPDATE OR DELETE ON "payment_callback" FOR EACH ROW EXECUTE FUNCTION "payment_callback_guard"();--> statement-breakpoint

-- ── Resolver: the signed callback reference -> its store (ADR-0005 amendment 4) ────────────────────────────────
-- Same shape as the 0011 resolvers: owned by bukalaris_resolver, fixed search_path, one statement, the store id only.
GRANT SELECT ON "payment_attempt" TO bukalaris_resolver;--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_payment_attempt_store(p_reff_id text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT a.store_id FROM public.payment_attempt a WHERE a.reff_id = p_reff_id $$;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO bukalaris_resolver;--> statement-breakpoint
ALTER FUNCTION resolve_payment_attempt_store(text) OWNER TO bukalaris_resolver;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM bukalaris_resolver;--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_payment_attempt_store(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_payment_attempt_store(text) TO bukalaris_app, bukalaris_platform;--> statement-breakpoint

-- ── Platform job kinds (JOB-25 advice poll, callback redaction sweep) ──────────────────────────────────────────
INSERT INTO "platform_job_kind" ("kind") VALUES ('payment.advice_poll'), ('payment.callback_redact') ON CONFLICT ("kind") DO NOTHING;--> statement-breakpoint

-- ── Callback body retention: redaction, not deletion; OFF until the owner records a period (the period is OPEN) ──
-- Registered as a retention class so retention_set_period() (audited, needs ops.jobs.manage) can hold its period. The
-- generic purge can never delete this class (row_filter is false); only redact_payment_callbacks() touches the table,
-- as the table owner with a fixed search_path, and it blanks raw_body only (the digest stays).
INSERT INTO "retention_class" ("class", "table_name", "time_column", "row_filter") VALUES ('payment_callback', 'payment_callback', 'created_at', 'false') ON CONFLICT ("class") DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION redact_payment_callbacks(p_batch integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_days integer;
  v_done bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname LIKE 'pg\_%') THEN
    RAISE EXCEPTION 'redaction refused: a temporary relation shadows a system catalog' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION 'redaction: batch must be between 1 and 10000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT period_days INTO v_days FROM public.retention_policy WHERE class = 'payment_callback';
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  UPDATE public.payment_callback c SET raw_body = NULL, redacted_at = pg_catalog.now()
   WHERE c.id IN (
     SELECT s.id FROM public.payment_callback s
      WHERE s.raw_body IS NOT NULL AND s.created_at < pg_catalog.now() - pg_catalog.make_interval(days => v_days)
      ORDER BY s.id LIMIT p_batch FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_done = ROW_COUNT;
  RETURN v_done;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION redact_payment_callbacks(integer) FROM PUBLIC, bukalaris_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION redact_payment_callbacks(integer) TO bukalaris_platform;
--> statement-breakpoint

-- ── Local demo reset (packages/db/src/demo/seed-demo.ts) ────────────────────────────────────────────────────────
-- The demo seed runs on the platform pool, which holds no DELETE on payment evidence. This owner-side function deletes the
-- payment rows of stores whose slug starts with 'demo-' only (the seed's reserved prefix); any other store id is ignored.
-- It sets the transaction-local marker the evidence guards honour and clears it again.
CREATE OR REPLACE FUNCTION reset_demo_payments(p_store_ids bigint[]) RETURNS bigint
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
REVOKE ALL ON FUNCTION reset_demo_payments(bigint[]) FROM PUBLIC, bukalaris_app;--> statement-breakpoint
-- Wave 2 review (P1): NO EXECUTE for any login role. The platform login can write store.slug, so a slug guard alone let it
-- rename a store to 'demo-*' and erase payment evidence. The local demo seed calls this on the OWNER connection.
REVOKE ALL ON FUNCTION reset_demo_payments(bigint[]) FROM bukalaris_platform;--> statement-breakpoint

-- ===== T-62: Owner console tables, access evidence, retention class (hand-written) =====
-- Statements below are idempotent where Postgres allows it. Order matters: triggers are created while the migrator
-- still owns the table, then personal_data_access_event is handed to bukalaris_restricted (ADR-0005 amendment 4).

-- 1. issue_report / issue_report_event: platform class, no app or affiliate grant, written through the ops service.
--    The report row can be inserted and read; triage (UPDATE) arrives with the queue task (T-68). Events are append-only.
REVOKE ALL ON "issue_report", "issue_report_event" FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "issue_report" TO bukalaris_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "issue_report_event" TO bukalaris_platform;--> statement-breakpoint
DROP TRIGGER IF EXISTS "issue_report_event_append_only" ON "issue_report_event";--> statement-breakpoint
CREATE TRIGGER "issue_report_event_append_only" BEFORE UPDATE OR DELETE ON "issue_report_event" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();--> statement-breakpoint

-- 2. personal_data_access_event (DATA-14, PRIV-9): class restricted. Evidence rows are never updated; deletion is only the
--    retention purge (runs as the migrator, a member of bukalaris_restricted). No login role holds any privilege.
DROP TRIGGER IF EXISTS "personal_data_access_event_append_only" ON "personal_data_access_event";--> statement-breakpoint
CREATE TRIGGER "personal_data_access_event_append_only" BEFORE UPDATE ON "personal_data_access_event" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO bukalaris_restricted;--> statement-breakpoint
ALTER TABLE "personal_data_access_event" OWNER TO bukalaris_restricted;--> statement-breakpoint
REVOKE ALL ON "personal_data_access_event" FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint

-- The only write path: one INSERT. It returns after the row exists; the caller returns protected values only after the
-- surrounding transaction (which contains this call) commits, so a failed insert returns nothing (fail closed).
CREATE OR REPLACE FUNCTION console_record_access(p_actor text, p_target_kind text, p_target_id text, p_field_class text, p_purpose text, p_case text, p_reason text, p_level text, p_expires timestamptz, p_break_glass bigint) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.personal_data_access_event (actor_user_id, target_kind, target_id, field_class, purpose_code, case_id, break_glass_grant_id, reason, access_level, expires_at)
  VALUES (p_actor, p_target_kind, p_target_id, p_field_class, p_purpose, p_case, p_break_glass, p_reason, p_level, p_expires)
  RETURNING id
$$;--> statement-breakpoint
ALTER FUNCTION console_record_access(text, text, text, text, text, text, text, text, timestamptz, bigint) OWNER TO bukalaris_restricted;--> statement-breakpoint
REVOKE ALL ON FUNCTION console_record_access(text, text, text, text, text, text, text, text, timestamptz, bigint) FROM PUBLIC, bukalaris_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION console_record_access(text, text, text, text, text, text, text, text, timestamptz, bigint) TO bukalaris_platform;--> statement-breakpoint

-- The only read path: bounded, newest first, and without the free-text reason (the audit viewer shows evidence, not rationale).
CREATE OR REPLACE FUNCTION console_access_events(p_limit integer, p_before bigint) RETURNS TABLE (id bigint, actor_user_id text, target_kind text, target_id text, field_class text, purpose_code text, case_id text, access_level text, expires_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT e.id, e.actor_user_id, e.target_kind, e.target_id, e.field_class, e.purpose_code, e.case_id, e.access_level, e.expires_at, e.created_at
  FROM public.personal_data_access_event e
  WHERE p_before IS NULL OR e.id < p_before
  ORDER BY e.id DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;--> statement-breakpoint
ALTER FUNCTION console_access_events(integer, bigint) OWNER TO bukalaris_restricted;--> statement-breakpoint
REVOKE ALL ON FUNCTION console_access_events(integer, bigint) FROM PUBLIC, bukalaris_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION console_access_events(integer, bigint) TO bukalaris_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM bukalaris_restricted;--> statement-breakpoint

-- 3. Retention class (JOB-31): follows audit_log. No period is seeded (D-22 item 3); like audit_log it has no setter until
--    operator identity is restricted (T-59b), because a forged actor could otherwise shorten the evidence trail.
INSERT INTO "retention_class" ("class", "table_name", "time_column", "row_filter") VALUES ('access_event', 'personal_data_access_event', 'created_at', 'true')
ON CONFLICT ("class") DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION retention_purge_access_event(p_batch integer) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT public.retention_purge('access_event', p_batch) $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION retention_purge_access_event(integer) FROM PUBLIC, bukalaris_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION retention_purge_access_event(integer) TO bukalaris_platform;--> statement-breakpoint
CREATE OR REPLACE FUNCTION retention_set_period(p_class text, p_days integer, p_actor text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'retention: a reason is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_days IS NOT NULL AND p_days < 1 THEN
    RAISE EXCEPTION 'retention: the period must be a whole number of days >= 1' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.retention_class c WHERE c.class = p_class) THEN
    RAISE EXCEPTION 'retention: unknown class %', p_class USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_class IN ('audit_log', 'access_event') THEN
    RAISE EXCEPTION 'retention: the % period cannot be set until operator identity is restricted (T-59b)', p_class USING ERRCODE = 'feature_not_supported';
  END IF;
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.operator_grant g
    WHERE g.user_id = p_actor AND g.capability = 'ops.jobs.manage' AND (g.expires_at IS NULL OR g.expires_at > pg_catalog.now())
  ) THEN
    RAISE EXCEPTION 'retention: the actor does not hold ops.jobs.manage' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_days IS NULL THEN
    DELETE FROM public.retention_policy WHERE class = p_class;
  ELSE
    INSERT INTO public.retention_policy (class, period_days) VALUES (p_class, p_days)
    ON CONFLICT (class) DO UPDATE SET period_days = EXCLUDED.period_days, updated_at = pg_catalog.now();
  END IF;
  INSERT INTO public.retention_policy_event (class, period_days, actor_user_id, reason)
  VALUES (p_class, p_days, p_actor, pg_catalog.left(pg_catalog.btrim(p_reason), 500));
END
$$;--> statement-breakpoint

-- 4. Platform-wide periodic kinds of this task: the retention sweep of the access evidence and JOB-12 approval expiry.
INSERT INTO "platform_job_kind" ("kind") VALUES ('retention.access_event'), ('approval.expire')
ON CONFLICT ("kind") DO NOTHING;
