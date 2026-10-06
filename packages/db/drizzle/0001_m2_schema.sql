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
ALTER TABLE "order" DROP CONSTRAINT "order_status_chk";--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "tracking_number" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_variant_fk" FOREIGN KEY ("store_id","variant_id") REFERENCES "public"."variant"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_status_history_order_idx" ON "order_status_history" USING btree ("store_id","order_id");--> statement-breakpoint
CREATE INDEX "stock_adjustment_variant_idx" ON "stock_adjustment" USING btree ("store_id","variant_id");--> statement-breakpoint
CREATE INDEX "order_store_status_idx" ON "order" USING btree ("store_id","status","id");--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_shipped_chk" CHECK ("order"."status" not in ('shipped', 'completed') or "order"."tracking_number" is not null);--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_status_chk" CHECK ("order"."status" in ('awaiting_payment', 'placed', 'processing', 'shipped', 'completed', 'cancelled'));