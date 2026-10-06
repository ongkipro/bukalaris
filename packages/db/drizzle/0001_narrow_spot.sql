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
ALTER TABLE "operator_grant" ADD CONSTRAINT "operator_grant_user_id_platform_operator_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."platform_operator"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "system_log_time_idx" ON "system_log" USING btree ("time" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "system_log_request_idx" ON "system_log" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "system_log_module_time_idx" ON "system_log" USING btree ("module","time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "system_log_store_time_idx" ON "system_log" USING btree ("store_id","time" DESC NULLS LAST);