# Track report — `signals` (M2 wave 2b: T-38 conversion signals, PR-20)

Branch `m2/signals`, worktree `~/Projects/bukalaris-wt/signals`, dev database
`bukalaris_signals` (ports 3240 dev / 3241 e2e). Local only: **no request reached Meta,
TikTok or Google** — the worker runs in simulation mode unless `SIGNALS_LIVE=1`, unit
tests use an injected fake transport, and the Playwright spec intercepts every third-party
request (vendor loaders replaced by recording stubs, everything else aborted).

The provider contracts (request shapes, auth, error codes) follow the official documentation
read on 2026-10-07 and are **unverified until the owner approves a test-event call** (see
"Unverified provider fields").

## Files

| File | Change |
|---|---|
| `packages/db/src/schema-signals.ts` (new) | `signal_destination` (store × provider: pixel id, Google conversion label, sealed token + `token_set_at`, test-event code, enabled; unique store+provider; CHECK token/time pair), `signal_event` (store, provider, `event_id`, event name, order id, payload jsonb ≤ 16 KB, status `pending/sent/simulated/failed`, sanitized `last_error`, `sent_at`; **unique (store, provider, event_id)**), `order_signal_context` (click ids `fbp/fbc/ttclid/ttp/gclid/gbraid/wbraid`, utm jsonb, client IP, UA; PK store+order, FK → order cascade) |
| `packages/db/src/signals.ts` (new) | Token sealing (AES-256-GCM, `INTEGRATION_TOKEN_KEY`, AAD = `store:provider`), normalization/hashing, click-cookie parsing, destination settings (seller, `marketing.manage`), `browserSignals()` (public ids only), `recordOrderSignals()` / `enqueuePurchase()` / `collectFunnelEvent()` (write `signal_event` + outbox job in the caller's transaction), Meta/TikTok request builders + outcome classifiers, pluggable transport, `signal.deliver` handler, `destinationHealth()` (7 days), `purgeSignalContext()` (30 days) |
| `packages/db/drizzle/0005_signals.sql` + meta | Generated with `pnpm db:generate`, renamed (append-only, D-9); three tables, no hand-written SQL |
| `packages/db/test/signals.test.ts` (new) | 19 tests (below) |
| `apps/web/src/components/pixels/runtime.tsx` (new, client) | `ensureInit()` (each pixel once per page load, advanced matching at Meta init, Google Consent Mode v2 defaults before `config`), click capture → `bl_click` cookie (last ad click wins, 30 days), `fire()` per destination with shared `event_id`, `SignalRuntime` (init + PageView per route), `SignalEvent` (one event; reports funnel ids to `/api/signals`) |
| `apps/web/src/components/pixels/pixels.tsx` (new, server) | Mount: reads enabled destinations, renders `SignalRuntime` + Meta `<noscript>` image. Nothing when no destination is enabled |
| `apps/web/src/lib/signals.ts` (new) | `signalsFor()` (per-request cached), `requestSignalContext()` (pixel cookies, click cookie, trusted client IP, UA), `browserMatch()` (hashed phone/name for the buyer's own confirmation page) |
| `apps/web/src/app/api/signals/route.ts` (new) | `POST` server leg for browser funnel events: slug → `storefrontScope`, 600 / 10 min per IP (T-30 counters), 8 KB body, value re-derived from the catalog |
| `apps/web/src/app/seller/marketing/{page,actions}.tsx` (new) | Owner-only settings per provider (write-only token, "Hapus token server", test-event code, enable), simulation-mode notice, 7-day health per destination with last sanitized error |

Edits outside the new files (all minimal, listed for the orchestrator):

| File | Edit | Within row? |
|---|---|---|
| `packages/db/src/checkout.ts` | `ClientContext.signal?: RequestSignalContext`; one call `recordOrderSignals(tx, …)` inside the order transaction; `getBuyerOrder` also selects `buyerName`/`buyerPhone` (hashed for advanced matching, never rendered) | yes (hook) |
| `packages/db/src/orders.ts` | one line in `transitionOrder`: `if (action === "pay") await enqueuePurchase(tx, …)` | yes (hook) |
| `packages/db/src/scoped.ts` | capability `"marketing.manage": ["owner"]` (addition only) | yes |
| `packages/db/src/schema.ts` | `export * from "./schema-signals.ts"` | yes (pattern of every track) |
| `packages/db/src/index.ts` | `export * from "./signals.ts"` | **no** — needed so the web app can import; same line every merged track has |
| `packages/db/src/worker.ts` | `import "./signals.ts"` so the worker process registers `signal.deliver` | **no** (jobs track) — one line |
| `packages/db/src/cleanup.ts` | calls `purgeSignalContext(db)` and logs the counts (requested: purge via the cleanup command) | **no** (checkout2 track) — two lines |
| `apps/web/src/app/s/[store]/actions.ts` | add-to-cart redirect gains `?added=<variantId>:<qty>` so the cart page can fire AddToCart for that line | **no** (checkout2/catalog) — two lines, display only |
| `apps/web/src/app/s/[store]/layout.tsx` | `<Pixels storeId />` | yes (pixel mount) |
| `apps/web/src/app/s/[store]/products/[slug]/page.tsx`, `cart/page.tsx` | `SignalEvent` ViewContent / AddToCart | yes (pixel mount) |
| `apps/web/src/app/checkout/{page,confirmation/page}.tsx`, `checkout/actions.ts` | `Pixels` + InitiateCheckout / Purchase; action passes `signal: await requestSignalContext()` | yes (pixel mount) |
| `apps/web/src/app/seller/layout.tsx` | nav entry `["/seller/marketing", "Pemasaran"]` | yes |
| `apps/web/src/lib/security-headers.ts` | `THIRD_PARTY` hosts (below) | yes |
| `apps/web/e2e/security-headers.spec.ts` | CSP regex now built from `THIRD_PARTY` (the hardening spec hard-coded `img-src 'self'; connect-src 'self'`) | **no** (hardening) — required by the CSP change |
| `.env.example`, `docs/DEPLOY-COOLIFY.md` | `INTEGRATION_TOKEN_KEY` placeholder + row; `SIGNALS_LIVE` row | requested |

Not touched: `admin/layout.tsx`, root configs, Dockerfile, `seed.ts`, other tracks' tests.

## Event table (as implemented)

Internal event names are Meta's; TikTok uses the same names (May-2025 rename: `Purchase`);
Google maps to `view_item` / `add_to_cart` / `begin_checkout` remarketing events and the
`conversion` event for Purchase.

| Event | Fires (browser) | `event_id` | Server leg | Value / contents |
|---|---|---|---|---|
| PageView | every route on storefront + checkout pages (`fbq PageView`, `ttq.page()`; Google: `config` on load) | — | **none** (deliberate ceiling: one job per page view is not worth it; flip by adding it to `FUNNEL_EVENTS`) | — |
| ViewContent | product page | client uuid | `/api/signals` → `signal_event` + job | first sellable variant: `item_price × 1`, `content_ids = [variant catalog id]` |
| AddToCart | cart page after `?added=<variant>:<qty>` | client uuid | same | that line, qty added |
| InitiateCheckout | checkout page (every step; the id makes repeats a no-op) | **server-issued `checkout:<cart id>`** | same (unique → one row per cart) | all cart lines, `num_items` |
| Purchase (COD) | confirmation page | **server-issued `purchase:<order id>`** rendered as `data-purchase-event` | enqueued in `placeOrder`'s transaction | `order.subtotal` (goods only, no shipping), `contents` from `order_line` (`variant_catalog_id`, qty, unit price), `order_id` |
| Purchase (prepaid) | **not fired on confirmation** (unpaid) | `purchase:<order id>` | enqueued in `transitionOrder(…, "pay")` — server-only, no browser twin | same |

Common rules: `currency = "IDR"`, integer values; `content_type = "product"`; `groupIds`
(product catalog ids) travel in the payload for a future feed/`product_group` use; the
`user` block stores SHA-256 of `62…` (Meta `ph`), `+62…` (TikTok `phone`, Google
`sha256_phone_number`), lowercase ASCII first/last name, raw `fbp/fbc/ttclid/ttp/gclid/
gbraid/wbraid`, client IP and UA. Email is hashed only when a real one exists (none at
checkout today). `_fbc` is derived as `fb.1.<t>.<fbclid>` only when the pixel cookie is
absent. One destination disabled → that provider's events are skipped (browser) or marked
`failed` ("dinonaktifkan") if already queued (server).

Delivery (`signal.deliver`, one job per `signal_event`, key `signal_event:<id>`):
`ok` → `sent` (or `simulated` without `SIGNALS_LIVE=1`); permanent (`disabled`, unreadable
token, event > 7 days old, Meta code 190/100/other 4xx, TikTok non-zero code) → `failed`,
job completes; transient (HTTP 429/5xx, Meta codes 4/17/32/613, network/timeout) →
`last_error` recorded, job retries with the outbox backoff, and the last allowed attempt
marks the row `failed`. Network errors record only the error name (the request carries the
token). Google has **no server leg** (browser `conversion` event only).

## CSP additions (`THIRD_PARTY`)

| Directive | Hosts |
|---|---|
| `script-src` | `connect.facebook.net`, `analytics.tiktok.com`, `www.googletagmanager.com` |
| `connect-src` | `www.facebook.com`, `analytics.tiktok.com`, `www.googletagmanager.com`, `www.google.com`, `www.google.co.id`, `www.googleadservices.com`, `googleads.g.doubleclick.net` |
| `img-src` | `www.facebook.com`, `analytics.tiktok.com`, `www.google.com`, `www.google.co.id`, `googleads.g.doubleclick.net`, `www.googletagmanager.com` |
| `frame-src` | `td.doubleclick.net` |

The loaders are injected by the hydrated bundle (a nonce-trusted script), which
`'strict-dynamic'` allows, so there is no inline pixel `<script>` and no nonce to thread;
the host list is the CSP-2 fallback and the allow-list for the pixels' own beacons. Since
the vendor scripts never ran for real here, the beacon host list is taken from the official
snippets and **must be re-checked against the browser console on the first live test**.

## Unverified provider fields (sources read 2026-10-07)

| Provider | What was taken from the docs | Source | Still to verify live |
|---|---|---|---|
| Meta CAPI | `POST https://graph.facebook.com/v26.0/{pixel}/events`, body `{data:[…], test_event_code}`, `access_token` query parameter; event fields `event_name/event_time/event_id/action_source/event_source_url/user_data/custom_data`; `ph`, `fn`, `ln` hashed, `fbp/fbc/client_ip_address/client_user_agent` raw; `custom_data` `value/currency/content_type/content_ids/contents{id,quantity,item_price}/num_items/order_id`; dedup by `event_name + event_id` | graph-api/changelog (v26.0, 2026-07-29), conversions-api/using-the-api, parameters/server-event, parameters/customer-information-parameters, parameters/custom-data, graph-api/guides/error-handling (codes 4, 17, 190) | acceptance in Events Manager Test Events; whether JSON body + query token is preferred over form fields; EMQ |
| Meta Pixel | base code, `fbq('init', id, {ph, fn, ln})` hashed, `fbq('track', name, params, {eventID})` | meta-pixel/get-started, advanced-matching, reference | — |
| TikTok Events API 2.0 | `POST https://business-api.tiktok.com/open_api/v1.3/event/track/`, header `Access-Token`, body `{event_source:"web", event_source_id, test_event_code, data:[{event, event_time, event_id, user{ttclid, ttp, phone[], email[], ip, user_agent}, properties{contents{content_id, content_type, quantity, price}, content_type, currency, value, order_id}, page{url}}]}`; `phone` = SHA-256 of `+E.164`; response `{code, message, request_id}` | portal docs are JS-rendered (fetch returned only the title); shape from skill `tiktok-ads-signal-engine/references/TIKTOK_EVENTS_API_V2.md` (provenance 2026-10-02) and the official SDK (`/open_api/v1.3/pixel/track/` legacy shape confirms `event_source`, `event_source_id`, `data[]`, `code/message/request_id`) | the whole request shape (`event/track/` vs `pixel/track/`), error-code list, hashed-phone format |
| TikTok Pixel | base code, `ttq.load`, `ttq.page()`, `ttq.identify({phone_number})`, `ttq.track(name, props, {event_id})` | same skill reference | — |
| Google tag | loader `gtag/js?id=AW-…`, `gtag('consent','default',{…, region})` before `config`, `gtag('event','conversion',{send_to:'AW-…/label', value, currency, transaction_id})`, `gtag('set','user_data',{sha256_phone_number})` | tag-platform/gtagjs/install, security/guides/consent, support.google.com/google-ads/answer/7548399, enhanced-conversions/web | enhanced conversions needs the account-side setting; conversion label per store |

## Commands run (worktree root, 2026-10-07)

| Command | Result |
|---|---|
| `pnpm db:generate` | `drizzle/0005_signals.sql` (3 tables, 2 indexes, 3 FKs) |
| `pnpm db:migrate` (dev `bukalaris_signals`) | `migrations applied` |
| `pnpm lint` | pass (0 problems) |
| `pnpm typecheck` | pass (db + web) |
| `pnpm test` | **123 passed** (104 existing + 19 `signals.test.ts`), 13 files |
| `pnpm build` | pass |
| `pnpm e2e` | full suite 3×: run 1 — 57 passed, 2 skipped, 3 failed (2 × this spec: strict `getByRole("alert")` locator; 1 × `catalog.spec.ts` desktop, see open issues); run 2 — 59 passed, 2 skipped, 1 failed (this spec, desktop: per-phone order limit shared with the seed buyer → own phone); run 3 — **59 passed, 2 skipped, 1 failed (`catalog.spec.ts` desktop, pre-existing timing flake, passes alone)**; `signals.spec.ts` alone: 4 passed (2 tests × 2 projects) |

`signals.test.ts` covers: phone → `62…` / `+62…` (five spellings) and junk → null; email trim/lowercase and non-addresses; name parts incl. diacritics; click-cookie parsing (strict charset, `_fbc` derived from `fbclid` only without the pixel cookie, bad `_fbp` dropped); token seal/open round-trip, tampering, foreign store/provider AAD, wrong key, key validation; Meta and TikTok request shapes (hashed arrays, raw ids, value, string content ids, `test_event_code` presence/absence, `num_items` only for InitiateCheckout); outcome classification; destination save (sealed in DB, write-only, blank keeps token, disabled → no browser config, per-provider id validation, staff forbidden); browser config isolation; COD purchase → one row + one job per destination with value = subtotal (217 500 total → 200 000), variant/product catalog ids, hashed phone/name, cookie-derived `fbc`, stored context, enqueue idempotent; worker delivery through the fake transport with the shared id, `sent`, health, no resend; simulation mode; prepaid: nothing at creation, Purchase at `pay`, once; 503 → network error → 190 (retry, retry, permanent fail-fast) with sanitized `last_error`; disabled-before-delivery, exhausted budget and > 7 days → `failed`; cross-store (B's destination never receives A's purchase, health per store, same event id in another store is another row); funnel collect (re-priced, unknown/foreign ids dropped, duplicate id no-op, no destination → nothing, Purchase/`purchase:` ids rejected); retention purge.

`signals.spec.ts` (2 tests × 2 projects): owner configures Meta + TikTok (token never echoed, validation hint), landing with `fbclid`+utm sets `bl_click`, product → cart → checkout → confirmation; asserts the recorded `fbq`/`ttq` calls (one `init`/loader per document, funnel `eventID`s equal to the ids posted to `/api/signals`, Purchase `eventID = purchase:<id>` with value 178 000 and catalog content ids, TikTok `identify` with a hashed phone), that every external request was answered or aborted by the test, that `signal_event` holds the same 8 ids (4 events × 2 providers) with value 178 000 / stored `fbc` / no raw phone, that the worker marks them `simulated`, and that the health view shows them; second test: store without destinations loads no pixel object and no external request, seller/admin never mount one, staff sees the read-only notice. Evidence: `docs/evidence/m1/{mobile-320,desktop}-7{0,1,2}-*.png` (CSP violations = 0 via `evidence()`).

## Decisions and defaults

- **Simulation by default.** Without `SIGNALS_LIVE=1` the handler marks rows `simulated` and never opens a socket; the seller page says so. This is the "no real calls" rule made executable; turning it on is a deploy decision after the test-event call.
- **Google browser-only.** The Data Manager API (Google's path for new offline uploads) needs OAuth, a conversion action resource and the delivery-confirmation trigger; none exist yet. Click ids are stored with the order so the upload can be added later (open issue).
- **Server-issued InitiateCheckout id** (`checkout:<cart>`): the checkout page is multi-step with full-page loads (area search), so a client uuid fired once per cart; providers dedupe repeats, the DB unique makes the server leg one row.
- **Payload is the single source for the handler** (funnel events have no row to re-read); buyer data is stored hashed, click ids raw, and the `user` block is stripped after 30 days together with `order_signal_context`.
- **Health = `signal_event` rows** of the last 7 days (counts by status, last error, last acceptance); no separate delivery table.
- **Advanced matching at init** happens on full loads of the confirmation page (the page knows the buyer); after a client-side navigation the earlier init stands — never re-`init`. The server leg always carries the hashed phone/name, so matching does not depend on it.
- **`access_token` as a query parameter** (the documented form); the URL never appears in errors or logs (`sanitizeError` also redacts `token=`).
- **No `external_id`**: no durable first-party visitor id exists yet; a random visitor cookie hashed on both legs is the upgrade path.

## Open issues

- **Provider verification**: every request shape above is unverified; needs owner approval for one Meta Test Events call and one TikTok test event (`test_event_code` fields are in place), then record sanitized evidence here and in TASKS.
- **Consent**: Google Consent Mode v2 defaults deny for EEA/UK/CH regions only; Meta/TikTok have no consent gating and there is no banner (PR-20 says Indonesia v1 has none). Privacy owner to confirm (PRIV-5).
- **Google offline conversions after delivery** (primary COD signal per the contract): not built; requires Data Manager API auth + conversion action + the delivery-confirmation event (T-21 lifecycle `completed`).
- **PageView server leg** deliberately omitted (see event table).
- **Beacon host list** in `THIRD_PARTY` to be confirmed on the first live run (no vendor script executed here).
- **Prepaid Purchase has no browser twin**; when the payment reconciler lands, `enqueuePurchase` is the one call to make.
- **Email matching**: none at checkout; if the notify track adds a buyer email, add `em` to `purchasePayload` (one line, hashing helper exists).
- Flake observed in 2 of 3 full runs on this branch: `catalog.spec.ts` "slug renames redirect without chains" (desktop only) answered an old slug with a 308 to the intermediate slug (`sepatu-baru-…`) right after the second rename; the spec passes 3/3 when run alone (`--project=desktop`). Looks like a timing interaction in the full suite (the web server logs "The destination stream closed early" around it), not a signals change — this track only adds one read (`signalsFor`) to the product page. Flagged for the catalog track / orchestrator.
