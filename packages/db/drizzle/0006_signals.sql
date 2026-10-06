CREATE TABLE "order_signal_context" (
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"fbp" text,
	"fbc" text,
	"ttclid" text,
	"ttp" text,
	"gclid" text,
	"gbraid" text,
	"wbraid" text,
	"utm" jsonb,
	"client_ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_signal_context_store_id_order_id_pk" PRIMARY KEY("store_id","order_id")
);
--> statement-breakpoint
CREATE TABLE "signal_destination" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "signal_destination_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"pixel_id" text NOT NULL,
	"conversion_label" text,
	"token_ciphertext" text,
	"token_set_at" timestamp with time zone,
	"test_event_code" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_destination_store_provider_uq" UNIQUE("store_id","provider"),
	CONSTRAINT "signal_destination_provider_chk" CHECK ("signal_destination"."provider" in ('meta', 'tiktok', 'google')),
	CONSTRAINT "signal_destination_token_chk" CHECK (("signal_destination"."token_ciphertext" is null) = ("signal_destination"."token_set_at" is null))
);
--> statement-breakpoint
CREATE TABLE "signal_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "signal_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_name" text NOT NULL,
	"order_id" bigint,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_event_dedup_uq" UNIQUE("store_id","provider","event_id"),
	CONSTRAINT "signal_event_provider_chk" CHECK ("signal_event"."provider" in ('meta', 'tiktok', 'google')),
	CONSTRAINT "signal_event_status_chk" CHECK ("signal_event"."status" in ('pending', 'sent', 'simulated', 'failed')),
	CONSTRAINT "signal_event_payload_chk" CHECK (octet_length("signal_event"."payload"::text) <= 16384)
);
--> statement-breakpoint
ALTER TABLE "order_signal_context" ADD CONSTRAINT "order_signal_context_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_destination" ADD CONSTRAINT "signal_destination_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_event" ADD CONSTRAINT "signal_event_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_signal_context_created_idx" ON "order_signal_context" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "signal_event_store_created_idx" ON "signal_event" USING btree ("store_id","created_at");