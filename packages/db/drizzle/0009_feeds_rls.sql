-- Hand-written (drizzle-kit does not model grants or row-level security); keep verbatim when
-- migrations are consolidated at merge (docs/DECISIONS.md D-9, ADR-0005). Same shape as 0007 for the
-- new store-scoped table of the feeds track (T-40): the app role sees a store's feed tokens only in
-- that store's context and may create/revoke them (UPDATE), never delete. The unauthenticated feed
-- fetch resolves token → store through the platform pool (default privileges from 0007 cover it).
ALTER TABLE "feed_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feed_token" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "feed_token" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "feed_token" TO bukalaris_app;
