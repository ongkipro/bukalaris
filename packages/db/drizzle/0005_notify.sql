CREATE TABLE "order_notification" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_notification_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"event" text NOT NULL,
	"recipient" text NOT NULL,
	"to_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_notification_uq" UNIQUE("order_id","event","recipient","to_email"),
	CONSTRAINT "order_notification_event_chk" CHECK ("order_notification"."event" in ('created', 'confirmed', 'shipped', 'cancelled')),
	CONSTRAINT "order_notification_recipient_chk" CHECK ("order_notification"."recipient" in ('buyer', 'seller'))
);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "buyer_email" text;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "html_body" text;--> statement-breakpoint
ALTER TABLE "order_notification" ADD CONSTRAINT "order_notification_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_notification" ADD CONSTRAINT "order_notification_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."order"("store_id","id") ON DELETE no action ON UPDATE no action;