-- T-61: variant weight. Existing variants are backfilled with 1000 g so the quote keeps the old
-- "1 kg per unit" meaning until a seller sets a real weight; the default is dropped straight away so
-- every new variant must carry an explicit weight (no column default).
ALTER TABLE "variant" ADD COLUMN "weight_grams" integer NOT NULL DEFAULT 1000;--> statement-breakpoint
ALTER TABLE "variant" ALTER COLUMN "weight_grams" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "variant" ADD CONSTRAINT "variant_weight_chk" CHECK ("variant"."weight_grams" > 0);
