CREATE TABLE "landing_page" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "landing_page_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"draft_revision_id" bigint,
	"published_revision_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_page_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "landing_page_store_slug_uq" UNIQUE("store_id","slug"),
	CONSTRAINT "landing_page_slug_chk" CHECK ("landing_page"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "landing_page_status_chk" CHECK ("landing_page"."status" in ('draft', 'published')),
	CONSTRAINT "landing_page_published_chk" CHECK (("landing_page"."status" = 'published') = ("landing_page"."published_revision_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "landing_page_revision" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "landing_page_revision_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"page_id" bigint NOT NULL,
	"revision_number" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_page_revision_store_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "landing_page_revision_page_id_uq" UNIQUE("page_id","id"),
	CONSTRAINT "landing_page_revision_number_uq" UNIQUE("page_id","revision_number"),
	CONSTRAINT "landing_page_revision_number_chk" CHECK ("landing_page_revision"."revision_number" >= 1),
	CONSTRAINT "landing_page_revision_size_chk" CHECK (octet_length("landing_page_revision"."document"::text) <= 262144)
);
--> statement-breakpoint
ALTER TABLE "landing_page" ADD CONSTRAINT "landing_page_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_page_revision" ADD CONSTRAINT "landing_page_revision_page_fk" FOREIGN KEY ("store_id","page_id") REFERENCES "public"."landing_page"("store_id","id") ON DELETE cascade ON UPDATE no action;