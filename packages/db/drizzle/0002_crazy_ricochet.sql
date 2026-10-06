CREATE TABLE "shipping_margin_rule" (
	"key" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"fixed_idr" bigint DEFAULT 0 NOT NULL,
	"percent_bps" integer DEFAULT 0 NOT NULL,
	"round_to" integer DEFAULT 500 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_margin_rule_key_chk" CHECK ("shipping_margin_rule"."key" = 'default'),
	CONSTRAINT "shipping_margin_rule_values_chk" CHECK ("shipping_margin_rule"."fixed_idr" >= 0 and "shipping_margin_rule"."percent_bps" between 0 and 10000 and "shipping_margin_rule"."round_to" in (1, 100, 500, 1000))
);
--> statement-breakpoint
CREATE TABLE "store_pickup_area" (
	"store_id" bigint PRIMARY KEY NOT NULL,
	"area_id" text NOT NULL,
	"area_label" text NOT NULL,
	"address_text" text DEFAULT '' NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "store_pickup_area" ADD CONSTRAINT "store_pickup_area_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;