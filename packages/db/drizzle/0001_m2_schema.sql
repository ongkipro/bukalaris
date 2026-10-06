CREATE TABLE "order_status_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_adjustment" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_adjustment_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"variant_id" bigint NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"order_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustment_delta_chk" CHECK ("stock_adjustment"."delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "operator_grant" (
	"user_id" text NOT NULL,
	"capability" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_grant_user_id_capability_pk" PRIMARY KEY("user_id","capability"),
	CONSTRAINT "operator_grant_cap_chk" CHECK ("operator_grant"."capability" in ('logs.read'))
);
--> statement-breakpoint
CREATE TABLE "system_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "system_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"time" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"module" text NOT NULL,
	"operation" text,
	"page_id" text,
	"store_id" bigint,
	"request_id" text,
	"code" text,
	"message" text NOT NULL,
	"route" text,
	"environment" text NOT NULL,
	"release_revision" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "system_log_level_chk" CHECK ("system_log"."level" in ('debug', 'info', 'warn', 'error', 'fatal'))
);
--> statement-breakpoint
CREATE TABLE "checkout_handoff" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checkout_handoff_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"cart_id" uuid NOT NULL,
	"channel_id" bigint NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_handoff_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "storefront_channel" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "storefront_channel_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"return_path" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storefront_channel_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "storefront_channel_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "storefront_channel_status_chk" CHECK ("storefront_channel"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"store_id" bigint NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_kind_key_uq" UNIQUE("kind","key"),
	CONSTRAINT "job_status_chk" CHECK ("job"."status" in ('pending', 'running', 'done', 'failed')),
	CONSTRAINT "job_attempts_chk" CHECK ("job"."attempts" >= 0),
	CONSTRAINT "job_payload_chk" CHECK (octet_length("job"."payload"::text) <= 4096),
	CONSTRAINT "job_lock_chk" CHECK (("job"."status" = 'running') = ("job"."locked_by" is not null and "job"."locked_until" is not null))
);
--> statement-breakpoint
ALTER TABLE "order" DROP CONSTRAINT "order_status_chk";--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "tracking_number" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_variant_fk" FOREIGN KEY ("store_id","variant_id") REFERENCES "public"."variant"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_grant" ADD CONSTRAINT "operator_grant_user_id_platform_operator_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."platform_operator"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_handoff" ADD CONSTRAINT "checkout_handoff_cart_fk" FOREIGN KEY ("store_id","cart_id") REFERENCES "public"."cart"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_handoff" ADD CONSTRAINT "checkout_handoff_channel_fk" FOREIGN KEY ("store_id","channel_id") REFERENCES "public"."storefront_channel"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_channel" ADD CONSTRAINT "storefront_channel_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_status_history_order_idx" ON "order_status_history" USING btree ("store_id","order_id");--> statement-breakpoint
CREATE INDEX "stock_adjustment_variant_idx" ON "stock_adjustment" USING btree ("store_id","variant_id");--> statement-breakpoint
CREATE INDEX "system_log_time_idx" ON "system_log" USING btree ("time" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "system_log_request_idx" ON "system_log" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "system_log_module_time_idx" ON "system_log" USING btree ("module","time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "system_log_store_time_idx" ON "system_log" USING btree ("store_id","time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checkout_handoff_cart_idx" ON "checkout_handoff" USING btree ("store_id","cart_id");--> statement-breakpoint
CREATE INDEX "storefront_channel_prefix_idx" ON "storefront_channel" USING btree ("token_prefix");--> statement-breakpoint
CREATE INDEX "job_claim_idx" ON "job" USING btree ("next_attempt_at","id") WHERE "job"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "job_store_idx" ON "job" USING btree ("store_id","id");--> statement-breakpoint
CREATE INDEX "order_store_status_idx" ON "order" USING btree ("store_id","status","id");--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_shipped_chk" CHECK ("order"."status" not in ('shipped', 'completed') or "order"."tracking_number" is not null);--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_status_chk" CHECK ("order"."status" in ('awaiting_payment', 'placed', 'processing', 'shipped', 'completed', 'cancelled'));