# Track report — `demo` (M2 wave 4)

Branch `m2/demo`, worktree `~/Projects/bukalaris-wt/demo`. Scope: local demo
users, merchants and dummy content (`packages/db/src/demo/**`, script
`db:seed:demo`, `docs/DEMO.md`). Owner direction: add demo users/merchants with
dummy content. Usage and contents: `docs/DEMO.md`.

## What changed

| File | Change |
|---|---|
| `packages/db/src/demo/data.ts` | Fictional content: 4 stores (Batik Nusantara, Dapur Bunda Frozen, Glow Skin Lokal, Gadget Hub Aksesoris), owner + staff each, demo operator, 51 products / 84 variants (integer IDR, one draft per store), 3 collections and 3 CMS pages per store, 16 fictional buyers (`0812-0000-xxxx`, `Jl. Contoh …`, `@demo.bukalaris.local`), fake ad pixel ids |
| `packages/db/src/demo/png.ts` | In-process PNG generator (gradient + 5×7 bitmap initials; `node:zlib` only, no downloads, no new dependency) |
| `packages/db/src/demo/seed-demo.ts` | `seedDemo(db, opts)` + CLI. Local-only guards, skip-if-complete / rebuild-if-partial, `--reset`, catalog + images through `addProductMedia`, collections, pages, store settings, pickup areas, ad destinations, 16 orders per store through cart → `placeOrder` → `transitionOrder`, back-dated over 30 days (WIB) and placed oldest first, outbox settled with `runOnce`, 8 `demo:` log events, row counts printed on every run |
| `packages/db/test/demo.test.ts` | One integration test: seed one store (32 px images, temp `MEDIA_DIR`), assert counts, all 8 order statuses, 0 failed jobs, one PNG on disk per media row; second run skips; `reset` rebuilds the same counts |
| `package.json`, `packages/db/package.json` | Script `db:seed:demo` → `seed:demo` (`node --env-file-if-exists=../../.env src/demo/seed-demo.ts`) |
| `apps/web/src/components/admin-shell.tsx` | **Shared-file edit, outside ownership (cross-track fact a):** the 13-entry Seller nav overflowed at 1440 px and failed `ui.spec.ts` desktop. Taken verbatim from `main` (nav `gap-x-4 … md:flex-wrap md:overflow-visible` + comment), so the merge is a no-op |
| `docs/DEMO.md`, `docs/tracks/demo.md` | How to run, logins, what exists; this report |

No edits to `seed.ts`, the e2e setup, `seller/layout.tsx`, `admin/layout.tsx`,
`packages/db/src/index.ts`, other tracks' files, BUILD-LOG/STATUS/TASKS.

## Review of the inherited diff — issues found and fixed

1. **Local-only guard too weak.** It only checked `NODE_ENV` and a `bukalaris*`
   database name; a production database can carry the same name. Added: every
   configured host must be loopback or a Unix socket, and `*_e2e` databases are
   refused (the e2e DB must hold exactly `seed.ts`). Checked by hand:
   `db.example.com` → `refused, database host db.example.com is not local`;
   `bukalaris_demo_e2e` → `refused, "bukalaris_demo_e2e" is the e2e database`.
2. **Global side effect broke `pnpm test`.** The seed wrote the platform-wide
   shipping margin rule (`setMarginRule` 2 500/round 500). `shipping_margin_rule`
   is not truncated between tests, so `demo.test.ts` leaked it into
   later fee assertions (4 failures in 2 files, e.g. `checkout2.test.ts`: `Rp 318.000` vs expected `Rp 317.500`), and in
   a dev DB it silently changed the fees of the `seed.ts` stores too. Removed; the
   demo uses whatever margin rule exists. The leaked row was deleted from
   `bukalaris_demo_test` and the dev DB.
3. **Order list looked out of order.** Orders were created in plan order and then
   back-dated, so the newest-first list (by id) showed 21 Sep above 7 Oct. Dates
   are now drawn first and orders placed oldest first; SQL check: 0 orders older
   than their predecessor by id.
4. **`--reset` left per-cart checkout counters** (`rate_limit` `order:cart:<id>`,
   +64 rows per reset). Now deleted with the carts; count stayed flat across two
   resets.
5. CLI printed nothing useful on a skipped run; it now prints the row counts
   every time (idempotence evidence).

Checked and kept: platform pool as in `seed.ts` (ADR-0005) with store writes
through scopes from `sellerContext`/`storefrontScope`/`operatorScope`; Better
Auth `hashPassword` for credential users as `seed.ts`; integer IDR; no external
image downloads; `MEDIA_DIR` resolved like `apps/web/src/lib/media.ts`
(`apps/web/var/media`, git-ignored).

## Commands and results (this worktree's `.env`: `bukalaris_demo`, `_test`, `_e2e`)

| Command | Result |
|---|---|
| `pnpm db:migrate` / `pnpm db:seed` | `migrations applied` / `seed: already applied` (seed.ts stores untouched) |
| `pnpm db:seed:demo --reset` | ~12 s; `rows {"stores":4,"users":9,"products":51,"variants":84,"media":59,"collections":12,"pages":12,"orders":64,"jobsDone":207,"jobsFailed":0,"signalEvents":42,"mails":141,"logs":8} statuses=8` |
| `pnpm db:seed:demo` (run 1) | `4 demo stores already exist, nothing to do`; identical row counts |
| `pnpm db:seed:demo` (run 2) | identical row counts |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 (db + web) |
| `pnpm test` | 16 files, 138/138 passed (incl. `demo.test.ts`, ~8 s alone) |
| `pnpm build` | exit 0 |
| `pnpm e2e` | 72 passed, 2 skipped, 0 failed (7.3 min); before the nav fix: 1 failed (`ui.spec.ts` desktop nav scroll) |
| e2e DB after e2e | `select count(*) from store where slug like 'demo-%'` → 0 |
| `next start` on the dev DB + curl / Playwright | `/s/demo-*` (4 stores), a product page and a CMS page → 200; product images → 200 `image/png` ~48 KB; owner-batik login → `/seller/orders` 16 rows, `/seller/products` 12 rows; screenshots checked (storefront grid with generated images, orders with all statuses, wrapped nav) |

`docs/evidence/m1/*.png` re-rendered by e2e were restored (`git restore`), not committed.

## Defaults taken

- Shared demo password `bukalaris-demo-123` (local placeholder, like `bukalaris-dev-123`).
- Demo operator gets `logs.read`, so it must enrol TOTP on first `/admin` login (existing rule).
- Ad destination tokens (`demo-*-token-not-real`) only when `INTEGRATION_TOKEN_KEY` is set; delivery stays simulated by the fake adapter.
- Courier names in orders (JNE, SiCepat) are the fake shipping adapter's own simulated labels.
- The demo skips when complete instead of topping up; `--reset` is the rebuild path.

## Open issues

- After the wave-4 merge, add demo content for tables not on this branch: a landing
  page per store (`landing`), a booked shipment with resi/tracking on a shipped order
  (`fulfillment`), feed URLs (`feeds`), a buyer export/redaction request (`privacy`).
  `--reset` already covers any new table with a `store_id` column.
- `shipping.test.ts` leaves its margin rule (2 000) in the `_test` DB after it runs
  (not truncated); harmless today but order-dependent — owner: `shipping`/orchestrator.
- Older `rate_limit` `order:cart:*` rows from earlier resets age out via `pnpm --filter @bukalaris/db cleanup` (1 day).
