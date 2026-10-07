-- Hand-written (drizzle-kit does not model grants or row-level security). Keep verbatim when
-- migrations are consolidated at merge (docs/DECISIONS.md D-9, ADR-0005, docs/tracks/privacy.md).
-- T-43 buyer data export and redaction: the new store-owned table gets the tenant policy, and
-- bukalaris_app gets exactly the extra commands the redaction path issues inside a store context.
ALTER TABLE "order_redaction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_redaction" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "order_redaction" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
-- Per-order redaction record: append-only for the app, read back for the idempotency check.
GRANT SELECT, INSERT ON "order_redaction" TO bukalaris_app;--> statement-breakpoint
-- Redaction removes the order's attribution context and strips the user block of its signal events.
GRANT DELETE ON "order_signal_context" TO bukalaris_app;--> statement-breakpoint
GRANT UPDATE ON "signal_event" TO bukalaris_app;--> statement-breakpoint
-- Notification records (RLS) tell which addresses received mail for the order; the buyer address is overwritten.
GRANT SELECT, UPDATE ON "order_notification" TO bukalaris_app;--> statement-breakpoint
-- Dev outbox bodies that named the buyer are overwritten (store-less table; matched by recipient + order number).
GRANT UPDATE ON "mail_outbox" TO bukalaris_app;
