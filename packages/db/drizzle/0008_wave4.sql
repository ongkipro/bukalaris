CREATE TABLE "shipment" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "shipment_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"courier_code" text NOT NULL,
	"origin_area_id" text NOT NULL,
	"destination_area_id" text NOT NULL,
	"weight_kg" integer NOT NULL,
	"cod_amount" bigint DEFAULT 0 NOT NULL,
	"provider_order_id" text,
	"provider_batch_id" text,
	"tracking_number" text,
	"provider_status" text,
	"paid" boolean DEFAULT false NOT NULL,
	"tracking_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"booking_attempts" integer DEFAULT 0 NOT NULL,
	"manual_polls" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"booked_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_tracked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_order_uq" UNIQUE("store_id","order_id"),
	CONSTRAINT "shipment_status_chk" CHECK ("shipment"."status" in ('queued', 'booking', 'awaiting_balance', 'booked', 'in_transit', 'delivered', 'returned', 'problem', 'cancelled', 'failed')),
	CONSTRAINT "shipment_amounts_chk" CHECK ("shipment"."cod_amount" >= 0 and "shipment"."weight_kg" >= 1 and "shipment"."booking_attempts" >= 0 and "shipment"."manual_polls" >= 0),
	CONSTRAINT "shipment_booked_chk" CHECK ("shipment"."status" in ('queued', 'booking', 'failed') or "shipment"."provider_order_id" is not null),
	CONSTRAINT "shipment_resi_chk" CHECK ("shipment"."tracking_number" is null or "shipment"."paid"),
	CONSTRAINT "shipment_history_chk" CHECK (octet_length("shipment"."tracking_history"::text) <= 16384)
);
--> statement-breakpoint
CREATE TABLE "feed_token" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feed_token_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "feed_token_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "feed_token_status_chk" CHECK ("feed_token"."status" in ('active', 'revoked')),
	CONSTRAINT "feed_token_revoked_chk" CHECK (("feed_token"."status" = 'revoked') = ("feed_token"."revoked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_token" ADD CONSTRAINT "feed_token_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipment_store_status_idx" ON "shipment" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "feed_token_prefix_idx" ON "feed_token" USING btree ("token_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_token_store_active_uq" ON "feed_token" USING btree ("store_id") WHERE "feed_token"."status" = 'active';