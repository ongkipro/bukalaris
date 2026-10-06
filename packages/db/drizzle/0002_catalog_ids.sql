CREATE SEQUENCE "public"."catalog_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 10000 CACHE 1;--> statement-breakpoint
CREATE TABLE "catalog_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalog_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"actor_user_id" text NOT NULL,
	"product_id" bigint NOT NULL,
	"variant_id" bigint,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_audit_action_chk" CHECK ("catalog_audit"."action" in ('product.create', 'product.update', 'variant.create', 'variant.update'))
);
--> statement-breakpoint
CREATE TABLE "product_slug_alias" (
	"store_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"product_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_slug_alias_store_id_slug_pk" PRIMARY KEY("store_id","slug"),
	CONSTRAINT "product_slug_alias_slug_chk" CHECK ("product_slug_alias"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and "product_slug_alias"."slug" !~ '^[0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "variant_catalog_id" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "catalog_id" bigint DEFAULT nextval('catalog_id_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "variant" ADD COLUMN "catalog_id" bigint DEFAULT nextval('catalog_id_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_audit" ADD CONSTRAINT "catalog_audit_product_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_audit" ADD CONSTRAINT "catalog_audit_variant_fk" FOREIGN KEY ("store_id","variant_id") REFERENCES "public"."variant"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_slug_alias" ADD CONSTRAINT "product_slug_alias_product_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_audit_product_idx" ON "catalog_audit" USING btree ("store_id","product_id","id");--> statement-breakpoint
CREATE INDEX "product_slug_alias_product_idx" ON "product_slug_alias" USING btree ("store_id","product_id");--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_catalog_id_unique" UNIQUE("catalog_id");--> statement-breakpoint
ALTER TABLE "variant" ADD CONSTRAINT "variant_catalog_id_unique" UNIQUE("catalog_id");--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_catalog_id_chk" CHECK ("product"."catalog_id" >= 10000);--> statement-breakpoint
ALTER TABLE "variant" ADD CONSTRAINT "variant_catalog_id_chk" CHECK ("variant"."catalog_id" >= 10000);