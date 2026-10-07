CREATE TABLE "order_redaction" (
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"actor_user_id" text NOT NULL,
	"source" text NOT NULL,
	"override" boolean DEFAULT false NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_redaction_store_id_order_id_pk" PRIMARY KEY("store_id","order_id"),
	CONSTRAINT "order_redaction_source_chk" CHECK ("order_redaction"."source" in ('seller', 'retention')),
	CONSTRAINT "order_redaction_override_chk" CHECK (not "order_redaction"."override" or "order_redaction"."reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "order_redaction" ADD CONSTRAINT "order_redaction_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;