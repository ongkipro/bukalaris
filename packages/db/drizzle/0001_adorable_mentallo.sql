CREATE TABLE "collection" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "collection_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "collection_store_slug_uq" UNIQUE("store_id","slug"),
	CONSTRAINT "collection_status_chk" CHECK ("collection"."status" in ('draft', 'published')),
	CONSTRAINT "collection_slug_chk" CHECK ("collection"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "collection_product" (
	"collection_id" bigint NOT NULL,
	"store_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "collection_product_collection_id_product_id_pk" PRIMARY KEY("collection_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "media_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"alt" text DEFAULT '' NOT NULL,
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "media_mime_chk" CHECK ("media"."mime" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "media_dims_chk" CHECK ("media"."width" between 1 and 10000 and "media"."height" between 1 and 10000 and "media"."bytes" between 1 and 5242880)
);
--> statement-breakpoint
CREATE TABLE "page" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "page_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_store_slug_uq" UNIQUE("store_id","slug"),
	CONSTRAINT "page_status_chk" CHECK ("page"."status" in ('draft', 'published')),
	CONSTRAINT "page_slug_chk" CHECK ("page"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "whatsapp" text;--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "theme" text DEFAULT 'responsive' NOT NULL;--> statement-breakpoint
ALTER TABLE "collection" ADD CONSTRAINT "collection_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_product" ADD CONSTRAINT "collection_product_collection_fk" FOREIGN KEY ("store_id","collection_id") REFERENCES "public"."collection"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_product" ADD CONSTRAINT "collection_product_product_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_product_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_product_order_idx" ON "collection_product" USING btree ("collection_id","position");--> statement-breakpoint
CREATE INDEX "media_product_idx" ON "media" USING btree ("store_id","product_id","position");--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_theme_chk" CHECK ("store"."theme" in ('responsive', 'mobile'));--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_whatsapp_chk" CHECK ("store"."whatsapp" is null or "store"."whatsapp" ~ '^62[0-9]{8,13}$');