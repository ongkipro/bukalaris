CREATE TABLE "checkout_handoff" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checkout_handoff_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"cart_id" uuid NOT NULL,
	"channel_id" bigint NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_handoff_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "storefront_channel" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "storefront_channel_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"return_path" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storefront_channel_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "storefront_channel_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "storefront_channel_status_chk" CHECK ("storefront_channel"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "checkout_handoff" ADD CONSTRAINT "checkout_handoff_cart_fk" FOREIGN KEY ("store_id","cart_id") REFERENCES "public"."cart"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_handoff" ADD CONSTRAINT "checkout_handoff_channel_fk" FOREIGN KEY ("store_id","channel_id") REFERENCES "public"."storefront_channel"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_channel" ADD CONSTRAINT "storefront_channel_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkout_handoff_cart_idx" ON "checkout_handoff" USING btree ("store_id","cart_id");--> statement-breakpoint
CREATE INDEX "storefront_channel_prefix_idx" ON "storefront_channel" USING btree ("token_prefix");