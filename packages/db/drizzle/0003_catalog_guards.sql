-- Hand-written (drizzle-kit does not model triggers or data backfills). Keep verbatim when
-- migrations are consolidated at merge (docs/DECISIONS.md D-8, docs/tracks/catalog.md).

-- Existing order lines: snapshot the variant's catalog id (0002 added the column nullable).
UPDATE "order_line" ol SET "variant_catalog_id" = v."catalog_id"::text
FROM "variant" v WHERE v."store_id" = ol."store_id" AND v."id" = ol."variant_id" AND ol."variant_catalog_id" IS NULL;--> statement-breakpoint
ALTER TABLE "order_line" ALTER COLUMN "variant_catalog_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_variant_catalog_id_chk" CHECK ("variant_catalog_id" ~ '^[1-9][0-9]{4,}$');--> statement-breakpoint

-- Catalog ids are immutable after insert (PR-12): a direct UPDATE of the column is rejected.
CREATE FUNCTION catalog_id_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.catalog_id IS DISTINCT FROM OLD.catalog_id THEN
    RAISE EXCEPTION 'catalog_id is immutable (% → %)', OLD.catalog_id, NEW.catalog_id USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'catalog_id_immutable';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER product_catalog_id_immutable BEFORE UPDATE OF catalog_id ON "product" FOR EACH ROW EXECUTE FUNCTION catalog_id_immutable();--> statement-breakpoint
CREATE TRIGGER variant_catalog_id_immutable BEFORE UPDATE OF catalog_id ON "variant" FOR EACH ROW EXECUTE FUNCTION catalog_id_immutable();
