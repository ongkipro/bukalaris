ALTER TABLE "order" DROP CONSTRAINT "order_status_chk";--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_cod_state_chk" CHECK ("order"."payment_method" = 'cod' or "order"."status" not in ('awaiting_confirmation', 'on_hold'));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_status_chk" CHECK ("order"."status" in ('awaiting_confirmation', 'on_hold', 'awaiting_payment', 'placed', 'processing', 'shipped', 'completed', 'cancelled'));