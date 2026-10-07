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
ALTER TABLE "feed_token" ADD CONSTRAINT "feed_token_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_token_prefix_idx" ON "feed_token" USING btree ("token_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_token_store_active_uq" ON "feed_token" USING btree ("store_id") WHERE "feed_token"."status" = 'active';