-- Hand-written (drizzle-kit does not model grants or row-level security). Consolidated wave 4
-- RLS for the store-scoped tables of each merged track, kept verbatim from the track branches
-- (docs/DECISIONS.md D-9, ADR-0005). Same shape as 0007.

-- from 0009_feeds_rls.sql
ALTER TABLE "feed_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feed_token" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "feed_token" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "feed_token" TO bukalaris_app;
--> statement-breakpoint

-- from 0009_fulfillment_rls.sql
ALTER TABLE "shipment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "shipment" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "shipment" TO bukalaris_app;
--> statement-breakpoint

-- from 0009_landing_rls.sql
ALTER TABLE "landing_page" ADD CONSTRAINT "landing_page_draft_revision_fk" FOREIGN KEY ("id", "draft_revision_id") REFERENCES "public"."landing_page_revision"("page_id", "id");--> statement-breakpoint
ALTER TABLE "landing_page" ADD CONSTRAINT "landing_page_published_revision_fk" FOREIGN KEY ("id", "published_revision_id") REFERENCES "public"."landing_page_revision"("page_id", "id");--> statement-breakpoint
ALTER TABLE "landing_page" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "landing_page" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "landing_page" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "landing_page_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "landing_page_revision" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "landing_page_revision" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "landing_page" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "landing_page_revision" TO bukalaris_app;
