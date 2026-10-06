CREATE TABLE "rate_limit" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rate_limit_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "order" DROP CONSTRAINT "order_status_chk";--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "courier_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "origin_area_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "destination_area_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "destination_area_label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "weight_kg" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "shipping_provider_cost" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "shipping_margin" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_shipping_fee_chk" CHECK ("order"."shipping_fee" = "order"."shipping_provider_cost" + "order"."shipping_margin" and "order"."shipping_provider_cost" >= 0 and "order"."shipping_margin" >= 0 and "order"."weight_kg" >= 1);--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_area_chk" CHECK ("order"."origin_area_id" ~ '^[a-f0-9]{24}$' and "order"."destination_area_id" ~ '^[a-f0-9]{24}$');--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_cod_state_chk" CHECK ("order"."payment_method" = 'cod' or "order"."status" not in ('awaiting_confirmation', 'on_hold'));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_status_chk" CHECK ("order"."status" in ('awaiting_confirmation', 'on_hold', 'awaiting_payment', 'placed', 'processing', 'shipped', 'completed', 'cancelled'));