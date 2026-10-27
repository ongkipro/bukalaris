# Demo data (local only)

`pnpm db:seed:demo` fills a **local** database with four fictional merchants, their
owners and staff, a catalog with generated product images, collections, CMS pages,
ad destinations, a month of orders in every order status and a few Log System
events. It is for development and presentations. It is not the e2e fixture
(`pnpm db:seed`, unchanged) and both can live in the same database.

## Run

```bash
docker compose up -d db
pnpm db:migrate
pnpm db:seed:demo            # no-op when the demo already exists (prints the row counts)
pnpm db:seed:demo --reset    # delete every demo row and image, then seed again
pnpm dev                     # storefront: /s/demo-batik-nusantara or http://demo-batik-nusantara.localhost:3000
```

Takes about 12 s. Code: `packages/db/src/demo/` (`data.ts` content, `png.ts`
image generator, `seed-demo.ts` seed + CLI). Test: `packages/db/test/demo.test.ts`.

The seed refuses to run when:

- `NODE_ENV=production`;
- any configured database host is not loopback (`localhost`, `127.0.0.1`, `::1`) or a Unix socket;
- the database name does not start with `bukalaris`;
- the database name ends in `_e2e` (the Playwright database must hold exactly `seed.ts`).

It connects with `PLATFORM_DATABASE_URL` (the platform role, as `seed.ts`; ADR-0005)
and writes through the same services as the UI (`createStore`, `createProduct`,
`addProductMedia`, `setCartLine`, `placeOrder`, `transitionOrder`, …), so RLS
context, validation, audit rows and outbox jobs are real. Raw SQL is limited to
what no service does: creating credential users, the staff membership row,
back-dating order timestamps and the `--reset` deletion.

Idempotence: a complete demo (4 `demo-*` stores and its `demo: …` log events) is
left alone; a partial one (an interrupted run) is deleted and rebuilt. Reset
markers: store slug `demo-*`, e-mail `@demo.bukalaris.local`, log message `demo: …`.

## Logins

Password for every demo login: `bukalaris-demo-123` (local-only placeholder).

| E-mail | Role |
|---|---|
| `admin@demo.bukalaris.local` | Platform operator with `logs.read` — enrols TOTP on first login before `/admin` opens (same rule as `admin@bukalaris.local`) |
| `owner-batik@demo.bukalaris.local` / `staff-batik@…` | Owner / staff, Batik Nusantara |
| `owner-dapur@demo.bukalaris.local` / `staff-dapur@…` | Owner / staff, Dapur Bunda Frozen |
| `owner-glow@demo.bukalaris.local` / `staff-glow@…` | Owner / staff, Glow Skin Lokal |
| `owner-gadget@demo.bukalaris.local` / `staff-gadget@…` | Owner / staff, Gadget Hub Aksesoris |

Sign-in is rate limited (3 per 10 s per IP) on a production build.

## What exists

| Store (slug) | Theme | Products (1 draft) | Images | Collections | Pages | Orders | Ad destinations |
|---|---|---|---|---|---|---|---|
| Batik Nusantara (`demo-batik-nusantara`) | responsive | 12 | 14 | 3 | 3 | 16 | Meta, TikTok, Google |
| Dapur Bunda Frozen (`demo-dapur-bunda`) | mobile | 12 | 14 | 3 | 3 | 16 | — |
| Glow Skin Lokal (`demo-glow-skin`) | responsive | 13 | 15 | 3 | 3 | 16 | — |
| Gadget Hub Aksesoris (`demo-gadget-hub`) | mobile | 14 | 16 | 3 | 3 | 16 | Meta |

- **Catalog:** 84 variants, integer IDR prices, some SKUs; the first three products
  of each store have two images, drafts none. Images are PNG gradients with the
  product's initials, generated in-process (`png.ts`, Node built-ins only, no
  downloads) and saved through `addProductMedia` into `MEDIA_DIR`
  (default `apps/web/var/media`, git-ignored).
- **Pages:** Tentang Kami, Cara Belanja, Kebijakan Pengembalian per store.
- **Shipping:** each store has a pickup area from the fake provider's areas (Bandung,
  Jakarta Pusat, Surabaya). The platform margin rule is left as it is.
- **Orders:** 16 per store spread over the last 30 days (Asia/Jakarta), placed
  through cart + checkout and moved by owner/staff transitions: completed, shipped
  (`DEMO-…` tracking numbers), processing, placed, awaiting confirmation (COD),
  on hold, cancelled (incl. COD rejected), awaiting payment (transfer). Covered COD
  risk signals: a repeat buyer with an earlier rejected order, an incomplete
  address, a no-COD area (Wamena) that pays by transfer.
- **Outbox:** settled once like the worker would — payment references, order
  e-mails into the dev mail outbox, simulated ad signals (only when
  `INTEGRATION_TOKEN_KEY` is set; tokens are `demo-*-token-not-real`).
- **Log System:** 8 warn/error events in the last hour, messages prefixed `demo:`.

All people, phone numbers (`0812-0000-xxxx`), addresses (`Jl. Contoh …`), store
names and e-mails (`*.demo.bukalaris.local`) are fictional; courier names are the
fake shipping adapter's own simulated labels.

## Not seeded yet (wave 4 features, merged 2026-10-07)

Still to add, through the owning services:

- a landing page with an order section per store (`landing`);
- a booked shipment with a resi and tracking events on a shipped order (`fulfillment`);
- feed tokens/URLs so `/feeds/...` return the demo catalog (`feeds`);
- a buyer data export / redaction request (`privacy`).

The dashboard (`dashboard`) needs no extra rows: it reads the back-dated orders.
`--reset` already deletes from every table with a `store_id` column, so new
store-owned tables are covered without changes.

## Mockups (static)

The affiliate programme, the subscription screen and its Owner console counterpart
have no code yet. They are shown as clickable static HTML mockups in
`docs/mockups/` (plain HTML + one shared CSS, no build, no network; fictional data
only; each page carries a "MOCKUP — data fiktif, belum diimplementasi" ribbon and
a link to its spec).

Open `docs/mockups/index.html` in a browser (`xdg-open docs/mockups/index.html`
on Linux). It lists every page and what is real versus mockup.

| Surface | Status | Where |
|---|---|---|
| Seller Admin, Batik Nusantara | **Real** (seeded) | `http://localhost:3001/seller` |
| Storefront, Batik Nusantara | **Real** (seeded) | `http://localhost:3001/s/demo-batik-nusantara` |
| Affiliate portal, @sari-picks (AF-01) | Mockup | `docs/mockups/affiliate-portal.html` |
| Public affiliate storefront (AF-08) | Mockup | `docs/mockups/affiliate-storefront.html` |
| Seller Admin: Affiliate (SC-30) | Mockup | `docs/mockups/seller-affiliate.html` |
| Seller Admin: Subscription (SC-28) | Mockup | `docs/mockups/seller-subscription.html` |
| Owner console: Affiliate (SA-11) | Mockup | `docs/mockups/admin-affiliate.html` |

The demo store is **Batik Nusantara** (`demo-batik-nusantara`); the mockups reuse
its product names and prices plus the other three demo stores. The route IDs are
proposed ARCH-5 rows (see `docs/04-SYSTEM-ARCHITECTURE.md`, planned surfaces) and
the mockups are not implementation evidence. Money is integer IDR; commission
rates are shown as percent next to basis points; sample rates, bounds, hold
periods and payout deductions are illustrative, not decided policy.
