-- Hand-written (drizzle-kit does not model grants or row-level security). Keep verbatim when
-- migrations are consolidated at merge (docs/DECISIONS.md D-9, ADR-0005, docs/tracks/fulfillment.md).
-- `shipment` (T-39) carries store_id: same tenant_isolation policy as every store-owned table in 0007.
-- bukalaris_platform already covers it through the owner's default privileges.
ALTER TABLE "shipment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "shipment" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
-- The app role requests bookings (INSERT), bumps retry/refresh counters (UPDATE) and reads the
-- state (SELECT); booking results and tracking are written by the worker on the platform pool.
GRANT SELECT, INSERT, UPDATE ON "shipment" TO bukalaris_app;
