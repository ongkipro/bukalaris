# Track report — `shipping` (M2, T-34)

Branch `m2/shipping`, worktree `~/Projects/bukalaris-wt/shipping`. Scope:
Mengantar read-only client with observed contract evidence, platform margin
rule (Q-12), seller pickup origin, store-scoped `shippingOptions()` service,
tests. Checkout wiring is deliberately NOT in this phase (`content` owns
checkout presentation, `jobs` owns `checkout.ts`).

## What changed

| File | Change |
|---|---|
| `packages/db/src/mengantar/client.ts` | Server-only `MengantarClient`: `fetch` with `AbortSignal.timeout` (8 s), one retry for idempotent reads on network error / timeout / 429 / 5xx, envelope unwrap, zod validation per operation, typed `MengantarError` (`network`, `timeout`, `http`, `provider`, `invalid_shape`, `write_disabled`) with the provider body key-redacted and never the URL, `redactUrl()` helper, `onRequest` hook receives redacted URLs only. Reads: `searchArea`, `listOrigins`, `estimateAll` (`/order/estimate?courier=all`), `estimate3pl` (keyless `/api/order/allEstimate3PL`), `getReceiverScore`. Writes (`createOrder`, `upsertOrigin`, `deleteAddress`, `addPickupTime`, `payUnpaid`, `addDropshipper`, `deleteOrders`, `deleteBatch`) throw `MengantarWriteDisabledError` before any network call unless `MENGANTAR_WRITE_ENABLED=1` (never set) |
| `packages/db/src/mengantar/schemas.ts` | Loose zod schemas for area rows, pickup addresses, courier rate map, envelope; unknown fields tolerated |
| `packages/db/src/mengantar/adapter.ts` | `mengantarAdapter(client)` implementing `ShippingAdapter`; `toProviderQuote()` cost mapping + gating flags + cargo minimum weight; `COURIER_LABELS`; `mengantarFromEnv()` (real adapter only when `MENGANTAR_API_KEY` is in the process env) |
| `packages/db/src/providers.ts` | `ShippingAdapter` gains `searchArea()` and `estimate()` (area-id based, returns `ProviderQuote` with `unsupported`, `unsupportedCod`, `providerCost`, `providerCostCod`); legacy `quote()` kept, `fakeMengantar` implements all three with deterministic data (`FAKE_AREAS`, one supported / one COD-refused / one unsupported courier). Existing checkout tests untouched and green |
| `packages/db/src/schema-shipping.ts` | `shipping_margin_rule` (single row `key='default'`, `fixed_idr`, `percent_bps`, `round_to ∈ {1,100,500,1000}`, CHECKs) and `store_pickup_area` (`store_id` PK → store, `area_id`, `area_label`, `address_text`, `updated_by`) |
| `packages/db/src/shipping.ts` | `applyMargin`, `quoteWithMargin` (pure), `getMarginRule`/`setMarginRule` (operator, audited in `audit_log` as `shipping.margin.update`), `marginRuleAudit`, `getPickupArea`/`searchPickupAreas`/`setPickupArea`/`setPickupAddress` (store-scoped, `shipping.manage`), `shippingOptions(scope, destinationAreaId, cart)`, `defaultShippingAdapter()`; re-exports the client/adapter |
| `packages/db/src/scoped.ts` | **Shared-file edit (additions only):** capability `shipping.manage: ["owner"]` |
| `packages/db/drizzle/0002_crazy_ricochet.sql` + meta | `pnpm db:generate`; orchestrator regenerates one consolidated migration at merge |
| `packages/db/test/shipping.test.ts` | 11 tests (below) |
| `packages/db/test/fixtures/mengantar/*.json` | Sanitized recorded responses (see evidence) |
| `apps/web/src/app/admin/shipping/{page,actions}.tsx` | Super Admin margin rule: form (fixed IDR, percent, rounding), live preview on four observed provider costs, audit list |
| `apps/web/src/app/seller/shipping/{page,actions}.tsx` | Seller pickup origin: current area card, server-side area search (`?q=` GET form), per-result "Pilih" form, address textarea; staff see a read-only card |
| `apps/web/src/app/admin/layout.tsx` | **Shared-file edit (one class list):** header container `flex-wrap items-center gap-x-4 gap-y-2` (was `items-center gap-4`). The pre-populated nav (Toko · Ongkir · Log System) overflowed 320 px by 30 px, which failed `super-admin.spec.ts` and every `/admin/*` evidence step at 320 px — including the existing ones — before this track added anything. Mirrors `seller/layout.tsx`. Drop it at merge if the orchestrator prefers another fix |
| `apps/web/e2e/shipping.spec.ts` | 2 Playwright tests × 2 projects |
| `docs/evidence/m1/{mobile-320,desktop}-4[0-3]-*.png` | Browser evidence (shared helper hardcodes the `m1` folder) |

No edits to `checkout.ts`, `apps/web/src/app/checkout/**`, `apps/web/src/app/s/**`, `seller/layout.tsx`, `packages/db/src/index.ts`, root configs or other tracks' files.

## Observed contract evidence (real account, read-only, sanitized)

Environment: production account (`MENGANTAR_BASE_URL` = `https://api-public.mengantar.com`), credentials only via `secrets-env run -- node <script>`; the observation scripts lived in the session scratchpad, not in the repository. Observed 2026-10-06 ~23:50 WIB (2026-10-06T16:5x Z). The API key never appeared in output (the client redacts URLs; the script additionally replaced the key string before printing/saving).

**Total real calls: 11** — 5 planned in the first run (search, list origins, 3PL estimate, account estimate, receiver score), **5 repeated by mistake** (the same script was re-invoked once while inspecting its fixtures), 1 extra receiver-score call to capture its error separately. No write endpoint was called. Nothing in automated tests calls the network.

| # | Operation | Request (sanitized) | HTTP | Result / relevant fields |
|---|---|---|---|---|
| 1 | Area search | `GET /api/public/<key>/address/search?keyword=Bandung` | 200 | `{success:true, data:[…50 rows]}`; row fields include `_id` (24-hex area id), `PROVINCE_NAME`, `CITY_NAME`, `DISTRICT_NAME`, `SUBDISTRICT_NAME`, `ZIP_CODE` plus ~70 courier-routing fields (`unsupportedJNE`, `unsupportedCodSi`, `JT_Code`, `posCode`, `SPX_*`, …). Fixture `address-search.json` keeps the first 2 rows (public geography). Note: a keyword matches sub-district names anywhere (first rows were "SUMUR BANDUNG, JAYANTI, TANGERANG"), so the UI must show the full label |
| 2 | List pickup origins | `GET /api/public/<key>/address` | 200 | 15 registered pickup addresses. Fields: `_id`, `PICKUP_NAME`, `PICKUP_AUTOFILL` (area id), `PICKUP_PIC`, `PICKUP_PIC_PHONE`, `PICKUP_ADDRESS`, `PICKUP_*`/`SHIPPER_*`/`RETURN_*` groups, `pinpointData`, `user`, `isJavaIsland`, … `MENGANTAR_PICKUP_ADDRESS_ID` **is** one of them; its `PICKUP_AUTOFILL` **differs from** `MENGANTAR_ORIGIN_AREA_ID` (the two secrets do not describe the same location — flag for the owner). Fixture `address-list.json`: one row with field names kept, every value replaced (`<redacted>` / fake ids) |
| 3 | 3PL raw tariff | `GET /api/order/allEstimate3PL?origin_id=<origin area>&destination_id=5fc62de9f8f44b34aa4bdc9e&weight=1` (**no key in the path**, as the toolkit says) | 200 | Map keyed `JNE, JNECargo, SiCepat, SiCepatCargo, SAP, SAPLite, SapCargo, iDexpress, iDlite, JT, lion, iDexpressCargo, anteraja, spx, pos`; per entry `price`, `unsupported` (`null`/`false`), `unsupported_cod` (`null`/`false`/`true` for `SapCargo`), `estimatedDate`, cargo `minimumWeightCargo`. No `codFee`, no discount. Example `JNE.price` 21 000. Fixture `estimate-3pl.json` (full) |
| 4 | Account estimate, all couriers, COD | `GET /api/public/<key>/order/estimate?origin_id=…&destination_id=…&courier=all&weight=1&COD_AMOUNT=150000` | 200 | Same keys minus `iDlite`. Per entry `price`, `discount`, `discountPercent`, `codFee` (4 994 for every courier at COD 150 000), `estimatedPrice` = `price + codFee`, `estimatedSpecialPrice` = `price − discount − discountExtra + codFee`, `estimate_delivery`/`estimatedDate` (sometimes `"-"`), `unsupported`/`unsupported_cod` (`null` on JNE/JNECargo, `true` on `SapCargo`), `minimumWeightCargo` only on `SapCargo`. Example `JNE`: price 11 000, discount 500, codFee 4 994 → special 15 494. Fixture `estimate-all-cod.json` (full) |
| 5 | Receiver score | `GET /api/public/<key>/getReceiverScoreByNumberUser?search=081234567890` | **403** | `{success:false, message:"Not allowed"}` — this account is not entitled to the endpoint (3/3 attempts). T-35 cannot rely on it without Mengantar enabling it. Fixture `receiver-score-403.json` |

Differences from the toolkit worth noting: the 3PL map carries an extra `iDlite` key; `unsupported` is frequently `null` (not `false`) and must be read as "not flagged"; the account estimate's `price` is the pre-discount tariff, not what the account pays; ETD fields are inconsistent (`"1 - 2 days"`, `"4 HARI"`, `"-"`). `/order/allEstimatePublic` was not called.

### Estimate source decision

The adapter uses the **account estimate** (`/order/estimate?courier=all` with `COD_AMOUNT`), not the 3PL tariff, because the platform pays the account's discounted tariff plus the COD fee, and only the account endpoint exposes both (`estimatedSpecialPrice`, `codFee`). The 3PL endpoint is keyless (no account context) and has no COD fee, so a margin computed on it would under-recover on COD, the primary segment (Q-13). `estimate3pl()` stays in the client for comparison/debugging. Cost basis per courier: `providerCostCod = estimatedSpecialPrice ?? estimatedPrice ?? price`; `providerCost (prepaid) = providerCostCod − codFee`. Cargo keys below `minimumWeightCargo` are dropped. `unsupported === true` or `unsupportedOriginSpx === true` hides the courier; `unsupported_cod === true` hides COD only.

## Margin rule (Q-12)

One platform-wide rule, operator-edited at `/admin/shipping`, audited:

```
buyerFee = roundUp(providerCost + fixedIdr + ceil(providerCost × percentBps / 10000), roundTo)
margin   = buyerFee − providerCost
```

Integer IDR throughout; `roundTo ∈ {1, 100, 500, 1000}`; `fixedIdr ≤ 100 000`; `percentBps ≤ 10 000`. Default until edited: Rp 2 000 flat, 0 %, round up to Rp 500 (`DEFAULT_MARGIN_RULE`). No per-courier override (not needed yet; the single rule plus the provider's own discounts was enough — add a `courier_key` column if the owner asks). Each `ShippingOption` carries `prepaid` and `cod` breakdowns (`providerCost`, `margin`, `buyerFee`), `cod` is `null` when the courier refuses COD.

Ceilings: weight = 1 kg per cart line (products have no weight yet); `COD_AMOUNT` = cart subtotal (the provider defines it as goods + shipping, which is circular before quoting; the observed COD fee did not vary by courier at this amount). Both are recorded in `shipping.ts`.

## Planned checkout wiring (next phase, after `content` and `jobs` merge)

1. Checkout address step gains a server-side area search (reuse `searchArea` via a `/checkout` server action or route) and submits `destinationAreaId` (24-hex) with the free-text address.
2. `checkoutSummary` / `placeOrder` call `shippingOptions(storefrontScope, destinationAreaId, { items, subtotal })` instead of `providers.shipping.quote()`; options are filtered by the chosen payment method (`cod` null → COD not offered for that courier; if no option supports COD, hide COD entirely).
3. The order snapshot adds: `courier_code` (provider estimate key, e.g. `JNE`), `courier_label`, `origin_area_id`, `destination_area_id`, `weight_kg`, `shipping_provider_cost`, `shipping_margin`, and keeps `shipping_fee` = buyer fee with CHECK `shipping_fee = shipping_provider_cost + shipping_margin`. The `order` table is owned by `orders`; those columns go through that track or the orchestrator.
4. `placeOrder` re-quotes server-side at submit (as today) and matches `courier_code`; a changed buyer fee → `courier` DomainError (reload).
5. Shipment booking (`createOrder`) stays disabled until the owner approves a write test; nothing in checkout spends balance.

## Commands run (worktree root, 2026-10-06/07 WIB)

| Command | Result |
|---|---|
| `pnpm db:generate` | `0002_crazy_ricochet.sql` (two tables) |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass (db + web, `next typegen` ok) |
| `pnpm test` | **46 passed** (35 existing + 11 in `shipping.test.ts`), 5 files — see flake note below |
| `pnpm build` | pass; `/admin/shipping`, `/seller/shipping` dynamic |
| `pnpm e2e` | **18 passed** (14 existing + 4 new: 2 specs × mobile-320/desktop), 1.8 min |

`shipping.test.ts` covers: margin math (fixed, percent ceil, rounding steps, exact multiples, non-integer/negative rejected); gating + ordering; URL redaction (segment and arbitrary occurrence); all 8 write methods throw `MengantarWriteDisabledError` without the flag and never call fetch; read path with stubbed fetch (redacted `onRequest`, envelope unwrap, 403 → typed error without the key, shape mismatch → `invalid_shape`, short keyword → no call); retry once on network error and 5xx, not on 4xx (`providerCode` surfaced), 3PL URL keyless; timeout; recorded fixtures validate against the schemas and contain no key; `toProviderQuote` cost basis / flags / cargo minimum, adapter end-to-end over the fixture (estimate + area search + legacy quote → `[]`); operator margin rule with audit rows and zod rejections; pickup area per store (search, choose, address, re-choose keeps address, cross-store isolation, staff forbidden, bad id rejected); `shippingOptions` (missing origin → `no_pickup_area`, rule + gating applied, `buyerFee = providerCost + margin`, store B unaffected by A, invalid destination rejected).

`shipping.spec.ts` covers: operator sets Rp 1 500 + 2,5 % / round 1 000 → preview row 22 320 → margin 2 680 → 25 000 and an audit entry, invalid negative value rejected server-side, rule restored; owner searches "bandung" (2 fake results), picks Braga, saves the address; staff sees the card but no forms; store B's owner sees "Belum diatur". No horizontal overflow at 320 px on every evidence step.

## Open issues / notes for the orchestrator

- **Q-17 remittance** (T-37) unchanged: COD proceeds land in the platform account; nothing here moves money.
- **Pickup origin at the provider**: sellers only store an area id locally. Registering a seller pickup address at Mengantar (`upsertOrigin`) is a write and needs explicit owner approval; until then shipments would have to be booked from a platform pickup address, which conflicts with per-seller pickup. Decide before T-35/booking.
- **Receiver score returns 403 "Not allowed"** on this account — T-35's risk signal needs Mengantar to enable it, or an alternative.
- **`MENGANTAR_ORIGIN_AREA_ID` ≠ the pickup address's `PICKUP_AUTOFILL`** in the secret store; the owner should confirm which location is the platform origin before any booking test.
- **Accidental repeat**: the observation script ran twice (10 read calls instead of 5) plus one extra receiver-score call; all read-only.
- **Pre-existing flaky test (orders track)**: `orders.test.ts › two concurrent cancels (and a racing process) restock once` alternates pass/fail on clean HEAD and on this branch (observed: pass, fail, fail, pass, fail, pass). `process` → `processing` followed by `cancel` from `processing` are both valid transitions, so when the lock order is process-first, two promises fulfil. Not touched here.
- **Shared edit** to `admin/layout.tsx` (header `flex-wrap`) — see table; without it the super-admin spec fails at 320 px on HEAD.
- Evidence PNGs are in `docs/evidence/m1/` (40–43) because the shared helper hardcodes that folder.
- Dev database `bukalaris_shipping` was not migrated/seeded for manual clicking; only `_test` and `_e2e` were used.
