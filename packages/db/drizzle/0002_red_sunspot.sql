ALTER TABLE "order" ADD COLUMN "courier_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "origin_area_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "destination_area_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "destination_area_label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "weight_kg" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "shipping_provider_cost" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "shipping_margin" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_shipping_fee_chk" CHECK ("order"."shipping_fee" = "order"."shipping_provider_cost" + "order"."shipping_margin" and "order"."shipping_provider_cost" >= 0 and "order"."shipping_margin" >= 0 and "order"."weight_kg" >= 1);--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_area_chk" CHECK ("order"."origin_area_id" ~ '^[a-f0-9]{24}$' and "order"."destination_area_id" ~ '^[a-f0-9]{24}$');