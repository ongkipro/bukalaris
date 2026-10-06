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
ALTER TABLE "job" ADD CONSTRAINT "job_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_claim_idx" ON "job" USING btree ("next_attempt_at","id") WHERE "job"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "job_store_idx" ON "job" USING btree ("store_id","id");