# Track report — `checkout2` (M2 wave 2a: T-34 phase 2, T-35, T-30)

Branch `m2/checkout2`, worktree `~/Projects/bukalaris-wt/checkout2`, dev database
`bukalaris_checkout2` (ports 3190/3191). Local only: no deploy, no provider write,
no real Mengantar call in any automated test (the real client is selected only when
`MENGANTAR_API_KEY` is in the process env at runtime).

Commit layout: deliverables 1 and 2 landed in one commit (the COD confirmation
state changes `placeOrder`'s initial status and every order test fixture, so a
"phase 2 only" state was never gate-verified on its own); deliverable 3 is a second
commit. Gates were run on each committed state.

## 1. T-34 phase 2 — checkout shipping wiring

| File | Change |
|---|---|
| `packages/db/src/providers.ts` | `ShippingAdapter` loses the M1 address-string `quote()`/`ShippingQuote` (no caller left). Fake adapter: a 5th area `FAKE_NO_COD_AREA` (Wamena) where every courier refuses COD; unknown destination ids → no quotes |
| `packages/db/src/mengantar/adapter.ts` | drops the stub `quote()` |
| `packages/db/src/shipping.ts` | `defaultProviders()` = `defaultShippingAdapter()` (real Mengantar only with `MENGANTAR_API_KEY`) + fake AutoLaris |
| `packages/db/src/checkout.ts` | `checkoutInput` + `destinationAreaId` (24-hex) and `destinationAreaLabel`; `checkoutSummary` returns `canShip` (store has a pickup area) and no longer quotes; `searchDestinationAreas()` and `checkoutShippingOptions()` wrap the adapter (keyword ≥ 3, `MengantarError` → `DomainError("provider")` with the typed error as `cause`); `placeOrder` resolves a `StorefrontScope` for the cart's store, re-quotes via `shippingOptions()`, matches `courier`, picks the COD or prepaid breakdown by payment method (`courier_cod` when the courier refuses COD) and snapshots everything; `getBuyerOrder` adds `destinationAreaLabel` |
| `packages/db/src/schema.ts` (`order`) | `courier_code`, `origin_area_id`, `destination_area_id`, `destination_area_label`, `weight_kg`, `shipping_provider_cost`, `shipping_margin`; CHECK `order_shipping_fee_chk` (`shipping_fee = provider_cost + margin`, all ≥ 0, weight ≥ 1), CHECK `order_area_chk` (24-hex ids) |
| `packages/db/src/seed.ts` (**outside row**, 3 lines) | Toko A gets the fake pickup area "Braga" + address so dev and e2e can quote; Toko B deliberately has none |
| `apps/web/src/app/checkout/page.tsx` | Step 1 (plain GET form, no JS): search → result list with "Pilih" links (`?q=…&area=<id>`); the chosen area must be in the current results so its label is the provider's, not the URL's. Step 2: courier radios (unsupported hidden; "Transfer Rp X / COD Rp Y" or "Tidak melayani COD"; the first COD-capable courier is preselected), recipient data, payment (COD radio only when some courier offers it). Store without pickup area → explanatory alert, no form |
| `apps/web/src/app/checkout/actions.ts` | whitelists the two new fields; failure redirects keep `q`/`area` so the buyer keeps the chosen destination |
| `apps/web/src/app/checkout/confirmation/page.tsx` | courier + destination line, `data-testid="order-shipping"` |
| `apps/web/src/app/seller/orders/[id]/page.tsx` | shows destination area, courier label + code, weight (margin and provider cost are not shown to sellers) |
| `packages/db/test/helpers.ts` (shared test infra) | `makeStore()` sets the pickup area unless `pickupArea: false`; `buyer()` sends `JNE` to the fake "Menteng" destination; `rate_limit` added to the per-test truncate |
| `packages/db/test/shipping.test.ts` (shipping track) | two `makeStore(…, { pickupArea: false })` where the test needs "no pickup area"; dropped the `adapter.quote()` assertion |
| `packages/db/test/checkout.test.ts`, `orders.test.ts` | fee amounts follow the real margin (COD 17 500 / prepaid 12 500) |
| `apps/web/e2e/helpers.ts` | `chooseDestination(page, keyword, pick)` |
| `apps/web/e2e/{purchase,orders,channels}.spec.ts` (other tracks) | one `chooseDestination()` call before filling the recipient; totals 193 000 → 195 500, 104 000 → 106 500 |

Decisions: weight = 1 kg per cart line and `codAmount` = subtotal stay as the shipping
track recorded. `destinationAreaLabel` is accepted from the form like the pickup flow
does (display text, not money); the area id is validated and the quote is always
re-run server-side. Default courier = first option that supports COD (COD is the
default payment, Q-13). The migration adds NOT NULL columns without defaults: fine for
the disposable databases; the orchestrator regenerates one consolidated migration.

## 2. T-35 — COD confirmation and risk

| File | Change |
|---|---|
| `packages/db/src/schema.ts` (`order`) | statuses `awaiting_confirmation`, `on_hold` added (8 total); `confirmed_at`; CHECK `order_cod_state_chk` (confirmation states only for `payment_method = 'cod'`) |
| `packages/db/src/checkout.ts` | COD orders start in `awaiting_confirmation` |
| `packages/db/src/orders.ts` | `TRANSITIONS` + `confirm` (`awaiting_confirmation`/`on_hold` → `placed`, sets `confirmed_at`), `hold` (`awaiting_confirmation` → `on_hold`, reason), `reject` (`awaiting_confirmation`/`on_hold` → `cancelled`, reason, same restock block as `cancel` — one `FOR UPDATE` path, so exactly one restock); `codRiskReasons()` (store-scoped) returned by `getOrder().risk` while the order is confirming; `normalizePhone`, `addressIncomplete` |
| `apps/web/src/app/seller/orders/{status.ts,actions.ts,[id]/page.tsx}` | labels "Menunggu konfirmasi"/"Ditahan", actions "Konfirmasi pesanan"/"Tahan pesanan"/"Tolak pesanan" (reason inputs, reject confirms first), "Sinyal risiko COD" block (`data-testid="cod-risk"`), `confirmed_at` shown |
| `apps/web/src/app/checkout/confirmation/page.tsx` | COD copy tells the buyer the seller confirms by phone first |
| `packages/db/test/orders.test.ts` | `placed()` forces COD fixtures into `placed` without a history row (the matrix/cancel tests are about the later lifecycle); `inputFor` covers `hold`/`reject` |
| `apps/web/e2e/orders.spec.ts` | list shows "Menunggu konfirmasi"; one "Konfirmasi pesanan" click before processing; history count 4 → 5 |

Risk heuristics (store-local only, Q-14 open; receiver score not used — 403 on this account):

| Code | Rule | Message |
|---|---|---|
| `repeat_cancelled` | other orders in this store whose normalized phone (`+62…`/`62…` → `0…`) matches and status `cancelled` | "N pesanan sebelumnya dengan nomor HP ini dibatalkan atau ditolak di toko ini." |
| `repeat_unconfirmed` | same phone, status `awaiting_confirmation`/`on_hold` | "N pesanan lain dengan nomor HP ini masih menunggu konfirmasi." |
| `address_incomplete` | trimmed address < 25 chars or no digit | "Alamat terlalu pendek atau tanpa nomor rumah/jalan; …" |
| `high_amount` | ≥ 3 other COD orders in the store and `total > 2 × median(total)` | "Nilai COD Rp X lebih dari 2× median pesanan COD toko ini (Rp Y)." |

Nothing processes or ships an unconfirmed COD order: `process`, `ship`, `cancel`, `pay`
are all `invalid_transition` from the confirmation states (tested).

## 3. T-30 — abuse controls

| File | Change |
|---|---|
| `packages/db/src/schema-abuse.ts` (new) + `export *` line in `schema.ts` | table `rate_limit (key, window_start, count)`, PK `(key, window_start)` |
| `packages/db/src/checkout.ts` | `LIMITS`, `hit()` (one atomic upsert per key, returns count + seconds left in the window), `enforceLimits()` → `DomainError("rate_limited", "Terlalu banyak percobaan. Coba lagi dalam N detik.")`, `limitCartMutation()`, `CART_MAX_LINES` + `assertCartHasRoom()`, `cleanupIdleCarts()`. `placeOrder(exec, cartId, raw, providers?, { clientIp? })` counts after the idempotent-replay check (a replay costs nothing and is not counted) and before any quote or lock |
| `packages/db/src/storefront.ts` (**catalog row**, one call) | `setCartLine` calls `assertCartHasRoom()` before inserting a new line (also protects the Storefront API) |
| `packages/db/src/cleanup.ts` (new) + script `cleanup` in `packages/db/package.json` | `node src/cleanup.ts`: deletes idle open carts (`CART_IDLE_HOURS`, default 168) and counters older than a day; JSON line; exit 1 on failure |
| `apps/web/src/lib/storefront.ts` (shared lib) | `clientIp()`: last `x-forwarded-for` hop (appended by the one trusted proxy), else `x-real-ip`, else `undefined`; shape-validated |
| `apps/web/src/app/s/[store]/actions.ts` | `limitCartMutation()` before `setCartLine` |
| `apps/web/src/app/checkout/actions.ts` | passes `{ clientIp }` to `placeOrder` |

Numbers (fixed windows):

| Key | Limit |
|---|---|
| `order:ip:<ip>` | 60 / 10 min |
| `order:cart:<cartId>` | 5 / 1 min |
| `order:phone:<normalized>` | 10 / 10 min |
| `cart:ip:<ip>` | 300 / 10 min |
| `cart:cart:<cartId>` | 60 / 10 min |
| cart lines | 30 distinct variants; quantity per line 1–99 (existing CHECK) |
| idle cart age | 168 h (`CART_IDLE_HOURS`); checked-out carts never deleted; `rate_limit` rows swept after 24 h |

Client-IP fallback (documented): when no trusted proxy header is present (dev, tests,
a misconfigured proxy) the IP dimension is skipped and the per-cart and per-phone keys
carry the protection — a shared "unknown" bucket would throttle every buyer at once
behind a misconfigured proxy. Production runs behind Coolify's proxy, which sets
`x-forwarded-for`; the release track should verify the header on the deployed origin.
Ceilings: one trusted proxy hop assumed (no `TRUSTED_PROXY_HOPS`); "idle" = cart
`created_at` age (carts have no activity timestamp; add `cart.updated_at` touched by
`setCartLine` when that matters); the line cap is check-then-insert (a concurrent burst
can exceed 30 by a few lines); the Storefront API (`/api/storefront/v1/**`, channels
track) gets the line cap but not the request limiter — its tokens are server-to-server.

## Commands and results (worktree root, 2026-10-07 WIB)

| Command | Result |
|---|---|
| `pnpm db:generate` | `0002_red_sunspot.sql` (order shipping snapshot), `0003_calm_shriek.sql` (COD statuses, `confirmed_at`), `0004_short_jack_power.sql` (`rate_limit`) |
| `pnpm db:migrate` + `pnpm db:seed` (dev `bukalaris_checkout2`) | `migrations applied`, `seed: done` |
| `pnpm --filter @bukalaris/db cleanup` (dev DB) | `{"event":"cleanup","idleHours":168,"carts":0,"counters":0}`; with `CART_IDLE_HOURS=0` → `cleanup_failed … idleHours must be >= 1`, exit 1 |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass (db + web, `next typegen` ok) |
| `pnpm test` | **100 passed** (88 existing + 12 in `test/checkout2.test.ts`), 11 files |
| `pnpm build` | pass; `/checkout`, `/checkout/confirmation`, `/seller/orders/[id]` dynamic |
| `pnpm e2e` | see "E2E result" below |

`checkout2.test.ts` covers: fee split snapshot (COD vs prepaid cost basis, weight per line, labels, area ids) and `getBuyerOrder`; unoffered courier, COD on a COD-refusing courier/area, unserved and malformed destinations, SiCepat prepaid 10 000; store without pickup area (`canShip: false`, `no_pickup_area`); CHECK constraints on the fee split, weight and area ids; provider outage → `provider` with the typed cause, keyword validation, fake adapter selected without `MENGANTAR_API_KEY`; COD lifecycle (`awaiting_confirmation` → hold → confirm, actions per state, nothing else allowed before confirmation, `confirmed_at`, history notes, `order_cod_state_chk`); reject restocks exactly once under a reject/confirm/reject race, staff may reject, other store gets `not_found`; risk reasons (repeat cancelled + unconfirmed per normalized phone, store isolation, address heuristics, amount vs median, clean order → none, non-COD → none); fixed-window boundaries, independent keys, new window after expiry, exact IP ceiling; per-cart attempt limit (failures count, invalid input does not), per-phone across carts with `+62`/`0` forms, IP key only when known, cart-mutation limiter; 30-line cap with existing-line edits and freed slots, quantity 99; cleanup boundaries (169 h deleted, 167 h kept, checked-out cart kept, lines cascade, old counters swept, idempotent).

`checkout2.spec.ts` (320 px + desktop, evidence `60`–`69`) covers: area search → pick → courier list (POS hidden, SiCepat "Tidak melayani COD", JNE preselected) → server rejects SiCepat + COD keeping the area → SiCepat transfer confirmation (ongkir 10 000, total 99 000, route line); Toko B without pickup area blocked before any field; Wamena destination hides COD; seller sees two risk reasons (unconfirmed sibling order + address), hold → confirm → "Baru" with "Proses pesanan" only after confirmation, reject with reason → "Dibatalkan" + inventory back by one, third order from the same phone shows the repeat-cancelled signal; six rapid submits on one cart → the sixth gets "Terlalu banyak percobaan. Coba lagi dalam N detik." with the destination kept.

### E2E result

`pnpm e2e` on the final build: **49 passed, 1 skipped** (the skip is pre-existing),
5.1 min, worker running as the second `webServer`. Earlier full runs of this branch
surfaced two test-side races that are now fixed: `shipping.spec.ts` matched Next's
route announcer (`role=alert`) and could restore the margin rule before the redirect
landed, leaving `fixed=1500` for the desktop project (audit rows showed it); the
rate-limit loop asserted on an alert that could still belong to the previous render
(now waits for the re-rendered empty form). Spec-subset runs can fail on operator
MFA enrolment (`two-factor/enable 403`) when `accounts.spec.ts` has not run first —
the full suite order is what the gate uses.

## Open issues / notes for the orchestrator

- Edits outside this row (all minimal, listed above): `packages/db/src/seed.ts`, `packages/db/src/storefront.ts` (one call), `packages/db/package.json` (one script), `apps/web/src/lib/storefront.ts` (`clientIp`), `packages/db/test/helpers.ts`, `packages/db/test/shipping.test.ts`, `apps/web/e2e/helpers.ts`, `apps/web/e2e/{purchase,orders,channels}.spec.ts`, `apps/web/e2e/shipping.spec.ts` (alert scoped to `main`, fixes a restore race), `packages/db/src/schema.ts` (`export *` line + the owned `order` table).
- Migrations `0002_red_sunspot`, `0003_calm_shriek`, `0004_short_jack_power` are branch-local (NOT NULL columns without defaults: disposable databases only); regenerate one consolidated migration at merge.
- Provider receiver score stays unused (403); re-evaluate when Mengantar enables it.
- Cleanup is a command, not a scheduled job: the outbox has no schedule concept. Wire `pnpm --filter @bukalaris/db cleanup` into cron/Coolify scheduled task (release track).
- Suggested `docs/DECISIONS.md` entries (not written here to avoid merge conflicts): D-8 COD confirmation lifecycle + risk heuristics; D-9 abuse-control numbers and the idle-cart ceiling.
- Evidence PNGs: new `docs/evidence/m1/{mobile-320,desktop}-6[0-9]-*.png`; re-rendered existing PNGs restored before committing.
