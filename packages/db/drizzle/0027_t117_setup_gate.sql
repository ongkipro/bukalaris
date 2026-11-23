ALTER TABLE "store" ADD COLUMN "legacy_platform_shipping" boolean DEFAULT false NOT NULL;
-- ===== T-117 (D-37): every store that exists when this migration runs keeps the
-- platform shipping model until T-118; stores created after it ship only on
-- their own Mengantar account (the column default is fail-closed).
UPDATE "store" SET "legacy_platform_shipping" = true;
