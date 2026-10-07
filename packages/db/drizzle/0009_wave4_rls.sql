-- Hand-written (drizzle-kit does not model grants or row-level security). Consolidated wave 4
-- RLS for the store-scoped tables of each merged track, kept verbatim from the track branches
-- (docs/DECISIONS.md D-9, ADR-0005). Same shape as 0007.

-- from 0009_feeds_rls.sql
ALTER TABLE "feed_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feed_token" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "feed_token" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "feed_token" TO bukalaris_app;
