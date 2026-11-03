-- ===== T-81: seller settings may not write store identity or lifecycle.
-- Existing updateStoreSettings already writes exactly these four columns. Keep tenant RLS,
-- table SELECT and platform grants unchanged; this is NOT the gated T-59 platform contract.
-- The migrator runs both statements atomically. Table REVOKE also removes column UPDATE
-- grants, so it must precede the allowlist GRANT (PostgreSQL 17 sql-revoke).
REVOKE UPDATE ON TABLE "public"."store" FROM bukalaris_app;--> statement-breakpoint
GRANT UPDATE ("description", "name", "theme", "whatsapp") ON TABLE "public"."store" TO bukalaris_app;