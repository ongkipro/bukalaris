-- Hand-written (T-42, landing track). Keep verbatim when migrations are consolidated at merge
-- (docs/DECISIONS.md D-9, ADR-0005). Three things drizzle-kit cannot express or type:
--
-- 1. Pointer integrity: landing_page.draft_revision_id / published_revision_id reference
--    (page_id, id) of landing_page_revision, so a pointer can only name a revision of the
--    same page (and, through that revision's own FK, the same store). Declared here because a
--    page→revision→page reference is circular for the TypeScript schema.
ALTER TABLE "landing_page" ADD CONSTRAINT "landing_page_draft_revision_fk" FOREIGN KEY ("id", "draft_revision_id") REFERENCES "public"."landing_page_revision"("page_id", "id");--> statement-breakpoint
ALTER TABLE "landing_page" ADD CONSTRAINT "landing_page_published_revision_fk" FOREIGN KEY ("id", "published_revision_id") REFERENCES "public"."landing_page_revision"("page_id", "id");--> statement-breakpoint

-- 2. Row-level security, exactly as 0007 does for every store-owned table.
ALTER TABLE "landing_page" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "landing_page" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "landing_page" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint
ALTER TABLE "landing_page_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "landing_page_revision" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "landing_page_revision" USING ("store_id" = app_store_id()) WITH CHECK ("store_id" = app_store_id());--> statement-breakpoint

-- 3. Grants for bukalaris_app (0007 deliberately grants nothing on new tables). Pages are
--    created and re-pointed by the app; revisions are append-only (no UPDATE/DELETE: a saved
--    snapshot is never rewritten, and deletes only happen through the page cascade, which
--    does not exist in the app yet). test/rls.test.ts APP_GRANTS mirrors this.
GRANT SELECT, INSERT, UPDATE ON "landing_page" TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "landing_page_revision" TO bukalaris_app;
