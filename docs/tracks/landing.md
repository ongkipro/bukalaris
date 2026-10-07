# M2 track report — `landing`

Branch `m2/landing`, worktree `~/Projects/bukalaris-wt/landing`. Local only; no deploy, no live calls.
Scope: T-42 "Landing pages v1 with order section" (PR-9 subset; SC-14/15/16, SF-09). Drag-and-drop editing
and the MCP builder stay for later (T-11, T-20).

## What changed

### Owned files

| Path | Change |
|---|---|
| `packages/db/src/schema-landing.ts` | Tables `landing_page` (store-owned; slug unique per store + slug CHECK; `status` draft/published; `draft_revision_id`, `published_revision_id`; CHECK "published ⇔ published pointer") and `landing_page_revision` (immutable snapshot: `revision_number` unique per page, `schema_version`, `document` jsonb ≤ 256 KiB, `created_by`; store-compound FK to the page, cascade). |
| `packages/db/drizzle/0008_landing.sql` (+ `meta/0008_snapshot.json`, `_journal.json`) | Generated DDL for the two tables. |
| `packages/db/drizzle/0009_landing_rls.sql` | Hand-written: pointer FKs `(id, draft_revision_id)` / `(id, published_revision_id)` → `landing_page_revision(page_id, id)` (a pointer can only name a revision of the same page), `ENABLE` + `FORCE ROW LEVEL SECURITY` with the `tenant_isolation` policy on both tables (same as 0007), grants for `bukalaris_app` (page: SELECT/INSERT/UPDATE; revision: SELECT/INSERT — append-only). Keep verbatim at consolidation. |
| `packages/db/src/landing.ts` | Versioned document schema v1 (zod): design settings (accent token, font scale) + ordered typed blocks `hero`, `text`, `image`, `benefits`, `testimonials`, `faq`, `cta` (no countdown), `order` (one product; max one per page; ≤ 30 blocks; unique ids). Pure edit helpers (append/move/remove/replace). Services, all `SellerScope`/`StorefrontScope` + `inStore` (RLS context) + `scope.storeId` predicate: `listLandingPages`, `getLandingPage`, `createLandingPage` (revision 1), `updateLandingPageMeta`, `saveDraft` (compare-and-set on the draft pointer → stale tabs get `stale_revision`), `publishLandingPage` (draft must still be the expected revision; order product must be active; audit row), `unpublishLandingPage` (audit row), `listStoreMedia`, `listOrderableProducts`, `getPublishedLandingPage` (public: published pointer only), `getDraftLandingPage` (seller preview). Media and product references are verified to belong to the store on every save. Reserved slugs reuse `RESERVED_PAGE_SLUGS`. |
| `apps/web/src/app/seller/landing-pages/**` | SC-14 list, `new`, SC-15 editor `[id]` (settings, block cards with move up/down/remove buttons as the non-drag alternative, per-block edit forms, add block, publish/unpublish with confirm), SC-16 `[id]/preview` (same renderer, order form disabled, seller media route). Server actions in `actions.ts`, labels in `labels.ts`. |
| `apps/web/src/app/s/[store]/lp/**` | SF-09 `[slug]/page.tsx` (published revision of an active store's page, else 404), `_components/landing-renderer.tsx` (independent LP renderer: own column, header/footer, tokens from the document via data attributes, no inline styles under the nonce CSP), `_components/order-form.tsx` (platform order component: variant + quantity only, no buyer fields; AddToCart browser leg + `/api/signals` server leg like the storefront), `actions.ts` (`setCartLine` into the same per-store cart cookie as the storefront → redirect to `/checkout?store=<slug>`), `lp.css`. Pixels: reuses `components/pixels/**` (`Pixels`, `SignalEvent` ViewContent, `ensureInit`/`fire`) unchanged. |
| `packages/db/test/landing.test.ts` | 8 tests: create/list/slug validation + dedupe; immutable revisions + stale rejection; document validation (shape, one order section, bounds, foreign media/product); publish/unpublish visibility (active product required, drafts never public); DB pointer integrity; cross-store isolation (never sees/edits/publishes/resolves; same slug free per store); block helpers; Log System module mapping ignores the `(shop)` route group. |
| `apps/web/e2e/landing.spec.ts` | Builder → preview → publish → public LP (no storefront shell) → **store theme switched to mobile, LP geometry/typography/colours identical** → order section (no buyer fields) → hosted checkout with the line in the same store cart → other store 404 → unpublish 404; second test: other store's seller sees no pages. Runs in `mobile-320` and `desktop`. Evidence `docs/evidence/m1/{mobile-320,desktop}-6{0..4}-*.png`. |

### Shared changes (outside the ownership row) — please review at merge

| Path | Change | Why |
|---|---|---|
| `apps/web/src/app/s/[store]/*` → `apps/web/src/app/s/[store]/(shop)/*` (14 files, `content` track) | Pure `git mv` into a route group, **0 content lines changed**. `media/` stays outside (route handler, no layout). | See "The `(shop)` move" below. |
| `apps/web/src/app/seller/pages/[id]/page.tsx` | One import path: `@/app/s/[store]/_components/markdown-lite` → `@/app/s/[store]/(shop)/_components/markdown-lite`. | Required by the move (the page preview imports the storefront Markdown renderer); the LP renderer reuses the same component. |
| `packages/db/src/ops.ts` `moduleForRoute` | Strips `(group)` segments before prefix matching (one `.replace`). Identical function on `main`, so it merges cleanly. | Next passes the source route path (`/app/s/[store]/(shop)/cart/page`) to `onRequestError`; without the strip every storefront page would log as `storefront.catalog`. Covered in `landing.test.ts`. |
| `packages/db/test/rls.test.ts` | Two `APP_GRANTS` rows for the new tables. | The RLS grant test enumerates every table. |
| `apps/web/src/components/admin-shell.tsx` | Nav gets `gap-x-4 … md:flex-wrap md:overflow-visible` + comment — byte-identical to the `m2/dashboard` change (commit 633a4df there). | Coordinator cross-track fix: the 13-entry Seller nav (since 1fd2880) overflows at 1440 px and fails `ui.spec.ts` desktop on every wave-4 branch. Merges cleanly with dashboard. |
| `apps/web/e2e/catalog.spec.ts` (catalog track) | `const editor = page.url().split("?")[0]!` (one line). | Root cause of the known desktop "flake" (also logged in `signals.md`): `editor` kept `?saved=1` from creation, so in the rename loop `waitForURL(/saved=1/)` and the "Tersimpan." banner were satisfied before the second save's POST finished; the trace showed the storefront GET at +53 ms after the POST, before the slug commit. Now each rename waits for its own redirect. 2/2 isolated runs + full suite green. |

### The `(shop)` move — kept, and why

Requirement (T-42, UI-6): `/lp/<slug>` must render without the storefront shell and independent of the theme.
`s/[store]/layout.tsx` wraps every child route in the shell (header, nav, footer, `data-theme`, `.sf-wrap`), and a
nested layout cannot opt out of its parent. Alternatives considered:

- **Path-aware layout** (proxy header or similar, layout skips the shell for `/lp`): layouts are not re-rendered on
  client navigation between sibling routes, so `/lp/x` → `/cart` would keep the shell-less layout (and vice versa);
  also edits the shell's content. Incorrect, rejected.
- **LP outside `s/[store]`** (e.g. `app/lp/[store]/[slug]`): breaks the agreed URL `/s/[store]/lp` (ops.ts SF-09
  mapping) and host-mode rewriting in `proxy.ts`. Rejected.
- **Overlay/CSS hiding of the shell**: the shell, its theme attribute and wrapper widths would still apply; hacky. Rejected.

A route group is the framework's mechanism for exactly this, URLs are unchanged, and the change is rename-only, so
it is the minimal correct option. Merge note: any **new** storefront route the `content` track adds under
`s/[store]/` must go under `s/[store]/(shop)/` to keep the shell.

## Defaults taken

- Capabilities: list/preview with `catalog.read`, edit/publish with `catalog.write` (staff follow catalog rights).
- One order section per page; order product may be a draft while editing, must be active to publish; the public
  page shows "Produk ini sedang tidak tersedia" if it later goes inactive. Prices/stock always read live from the catalog.
- Store media = product images (no separate media library yet); public LP only shows images of active products.
- LP design is a small token set (6 accents, 3 font scales) rendered through data attributes — free composition and
  a richer design system belong to T-11.
- Order hand-off goes straight to `/checkout?store=<slug>` (not via the cart page).
- Saving title/slug and saving design are separate transactions in "Simpan pengaturan" (title/slug are page-row
  metadata, design is versioned); a stale tab can therefore update title/slug and then be refused for design.
- No delete of pages yet (unpublish only); revisions are never deleted.

## Verification (this worktree, own `.env`)

All run in `~/Projects/bukalaris-wt/landing` with the worktree's own `.env` (E2E port 3301, databases `bukalaris_landing*`).

| Command | Result |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 (db + web, `next typegen`) |
| `pnpm test` | **16 files, 145 tests passed** (incl. `landing.test.ts` 8, `rls.test.ts` with the new grants) |
| `pnpm build` | exit 0; routes `ƒ /s/[store]/lp/[slug]`, `ƒ /seller/landing-pages`, `…/new`, `…/[id]`, `…/[id]/preview` |
| `pnpm e2e` (full suite, final run) | **76 passed, 2 skipped** (pre-existing project skips), 0 failed, 8.0 min |
| `pnpm --filter @bukalaris/web e2e e2e/landing.spec.ts` | 4/4 passed (2 tests × `mobile-320`, `desktop`) |

Evidence (CSP-violation and horizontal-overflow assertions run before every screenshot):
`docs/evidence/m1/{mobile-320,desktop}-60-seller-landing-editor.png`, `-61-seller-landing-preview.png`,
`-62-landing-public.png`, `-63-landing-order-section.png`, `-64-landing-checkout-handoff.png`. Re-rendered existing
M1 screenshots were restored to `HEAD`.

Failures met on the way and their causes:
- `landing.spec.ts` timed out (both projects): the spec waited on the "Tersimpan." notice, which was already shown
  from the previous save, so the next `selectOption` raced the redirect and a Text block was added instead of FAQ.
  Fixed in the spec: every builder step now waits for the new draft revision number (2…8).
- `ui.spec.ts` desktop nav overflow → coordinator fix above.
- `ops.spec.ts` "database unreachable" got 404 instead of 500: environmental — the spec's spawned server keeps the
  `.env` `PLATFORM_DATABASE_URL` (this track's dev DB `bukalaris_landing`), which was unseeded, so the store resolved
  to "not found" instead of failing. `pnpm db:migrate && pnpm db:seed` on the dev DB fixed it; no code change.
- `catalog.spec.ts` desktop → race fixed above.
- Concurrency: a sibling track wrote to the same scratch log name once; that run was discarded and re-run.

## Open issues

- T-11: drag-and-drop builder, MCP, richer design settings, locked platform form scope.
- No page deletion / revision history UI / restore-revision yet.
- `content` track: new storefront routes must live under `(shop)` (see above).
- `ops.spec.ts` "database unreachable" silently depends on the dev DB being seeded (spawned server inherits `PLATFORM_DATABASE_URL`); the ops track may want to override it to the unreachable URL too.
- `docs/04-SYSTEM-ARCHITECTURE.md` SC-14/SF-09 status rows and TASKS/BUILD-LOG are for the orchestrator.
