# Code versus spec gap report — 2026-10-27

Status: review evidence, not a specification. Scope: the M2 code on `main` (`660bed1`, working tree with uncommitted docs) screened against the docs as revised on 2026-10-26/27 (ADR-0006..ADR-0010, PR-7/18/23..29, BILL-4..8, DATA-7..12, UX-14..21, TD-7, T-37, T-39, T-48..T-58). Purpose: let the owner decide per area whether to keep, rework or redevelop before the restructure (T-51) starts.

## 1. Method and evidence

Four parallel read-only reviews (money, tenancy/security, routes/UX/structure, data/coverage) plus a baseline run. Findings below are consolidated and de-duplicated; each ID carries the prefix `CR-` plus the reviewer prefix (`CR-MON`, `CR-SEC`, `CR-UXR`, `CR-DAT`) so it can be traced to its evidence (`file:line`) in the reviewer output and never collides with a spec ID (`SEC-n`, `DATA-n`). The ARCH-5 system map (`docs/04-SYSTEM-ARCHITECTURE.md`) is the key: every finding names the ARCH-5 ID it concerns.

| Check | Result |
|---|---|
| `pnpm lint`, `pnpm typecheck` | pass |
| `pnpm test` (Vitest, `packages/db`) | 21 files, 186 tests pass |
| Playwright e2e | not run in this pass (reviewer count: 20 specs, 92 tests, 2 skipped) |
| `node scripts/check-system-map.mjs` (new, `pnpm map:check`) | ok: 64 route files in code, 72 map rows (65 Implemented), no drift |
| `python3 docs/check-spec.py` | PASS |
| Measured size | 42 tables, 10 migrations (`0000`..`0009`, no gaps), 54 files in `packages/db/src`, 178 files in `apps/web/src`, 47 pages + 17 handlers |

Independently re-verified by the parent against code: no reserved store labels in `host.ts`/`proxy.ts` (CRSEC-01); `returned` absent from `orders.ts` and `schema.ts` (CRMON-02/CRDAT-01); `failed` is in `RETRYABLE` (CRMON-04). The rest are reviewer findings with cited evidence and were not re-executed. Reviewers were static (no exploit, no live provider call).

## 2. Verdict per area

| Area | ARCH-5 | Verdict | Why |
|---|---|---|---|
| Tenant core: store root, RLS on 31 tenant tables, scoped services, capability checks | SC-*, SF-*, SA-* | KEEP | FORCE RLS everywhere, store context transaction-local, every action resolves a scope; tests are real (rls, tenant-isolation, 8 + 7 tests) |
| Catalog, content, landing, feeds, dashboard, signals, notify, privacy export/redaction | SC-02..SC-24, SF-*, HTTP-15/16 | KEEP | Implemented, tested, map-accurate; only small deltas (CRDAT-03, CRSEC-15/16/17) |
| Checkout (cart, totals, idempotency, stock) | SF-07, HTTP-05..11 | KEEP + REWORK | Integer IDR, server-authoritative totals, atomic stock are solid; the `order` table and `placeOrder` must host `order_financials` (CRMON-01) |
| Order status writer | SC-12/13 | REWORK | Single-step table, no `returned`, no provider-forward jumps, cancel/booking race (CRMON-02/03) |
| Shipment booking/tracking (T-39) | SC-13, JOB-07 | REWORK | Unknown outcome is retryable, lease/lock race, tracking row not matched to the order, single env key and single pickup address (CRMON-04/05/08/12/15) |
| Payment (AutoLaris adapter, `payment.instruction`) | JOB-01, SC-13 | REDEVELOP | Interface cannot carry channel, fee, transaction id, QR/VA, expiry; no persisted attempt before the call; seller `pay` can settle money (CRMON-06/07) |
| Seller ledger, payouts, refunds (T-37) | SC-25, SA-08 | BUILD (new) | Nothing exists (CRMON-01, CRDAT-10) |
| Identity and sessions (Better Auth, one instance) | AU-*, HTTP-01 | REDEVELOP | One cookie, one trusted origin, no audience; cannot host four host-isolated surfaces (CRSEC-02) |
| Host routing (`proxy.ts`, `host.ts`) | SF-01, WEB-01 | REWORK | Any single label becomes a store slug; no reserved labels; documented `app` host config breaks (CRSEC-01, CRUXR-01) |
| RLS framework and DB roles | JOB-03 | REWORK | Only `app.store_id` is known; the test forbids RLS on non-`store_id` tables; platform role gets every future table (CRSEC-03/08) |
| Folder and route structure | all | REWORK (move-only, T-51) | 167 files move, about 140 import rewrites; route integrity today is clean (CRUXR-14) |
| Subscription, affiliate, buyer, hybrid shipping, promotions, abandoned carts | planned rows | BUILD (new) | Zero code, zero tables (PR-18, 24..29, 7) |

## 3. Consolidated findings

### P0 / P1 (act before or inside the first chain-A tasks)

| Ref | Sev | Type | ARCH-5 | Finding (evidence in reviewer output) | Rec. | Effort | Task |
|---|---|---|---|---|---|---|---|
| CRDAT-10 / CRMON-01 | P0 | GAP | SF-07, SC-13, SC-25, SA-08 | No `order_financials`, `ledger_entry`, `payout`, `refund`, `payment_attempt`. `order_total_chk` hard-codes `total = subtotal + shipping_fee`, so COD/admin fee cannot fit | REWORK `order`/`placeOrder`, BUILD ledger | L | T-37 |
| CRMON-03 | P1 | DEFECT | SC-13, JOB-07 | Cancel is allowed while a booking is in flight; the worker then books and tracks a cancelled, already-restocked order and reports `done` | REWORK | M | T-37 |
| CRMON-02 / CRDAT-01 / CRDAT-02 | P1 | MISMATCH | SC-13, JOB-07 | No `returned` state; RTS leaves the order `shipped` without restock (a test asserts it); seller can then `complete` a returned parcel | REWORK | M | T-37 |
| CRMON-04 / CRMON-15 | P1 | MISMATCH/DEFECT | JOB-07 | Timeout/5xx/lost worker become retryable `failed`; seller click books again; 60 s lease can expire under the unbounded account lock; tests assert the blind second `createOrder` | REWORK: non-retryable `unknown` + `GET /order` reconcile | S-M | T-37 |
| CRMON-05 | P1 | DEFECT | JOB-07 | `firstOrder` returns the first row without matching `ORDER_ID`; if the `order_id` filter is ignored another shipment's DELIVERED completes this order | REWORK | S | T-37 |
| CRMON-06 | P1 | MISMATCH | JOB-01 | `payment.instruction` persists no attempt/`reff_id` before the call and is retried up to 10 times (test asserts two creations); adapter lacks channel, fee, transaction id, `rc`, VA/QR, expiry | REDEVELOP | M-L | T-49 |
| CRMON-07 | P1 | MISMATCH | SC-13 | Seller `pay` (owner and staff) settles with no amount or reference check; D-5 says nothing marks an order paid | REWORK: callback or audited operator action only | S | T-49 |
| CRMON-08 / CRMON-12 | P1 | GAP | JOB-07, SA-07, SC-22 | One env key; booking uses one platform pickup address for every store while quotes use each store's area; no `store_shipping_account`, consent, mode, snapshot | REWORK | L | T-48 |
| CRMON-09 | P1 | GAP | JOB-07 | No live re-quote at booking, no booked-cost column, no `shipping_debit` reservation under the per-store lock | REWORK | M | T-37 |
| CRMON-10 | P1 | GAP | SF-07 | Weight is the count of distinct cart lines in kg (10 units ship as 1 kg); variants have no weight column and no task covers it. Mengantar's documented estimate/create fields carry weight in kg only (no dimensions), so the fix is per-variant weight and parcel weight = sum of quantity x weight | NEW task | M | NEW: variant weight (T-61) |
| CRSEC-01 / CRUXR-01 | P1 | DEFECT/MISMATCH | SF-01, AU-01, SA-02..07 | `slugFromHost` turns any label into a store slug, no reserved labels; with the documented `BETTER_AUTH_URL=https://app.bukalaris.com` and `STORE_ROOT_DOMAIN=bukalaris.com`, `app.bukalaris.com/login` becomes `/s/app/login`; a store named `app` or `www` would take the host | REWORK: reserved list now (S), exact-host dispatch in T-70 | S then M | T-70 |
| CRUXR-02 | P1 | DEFECT | SC-03, SF-04 | Seller product page builds storefront URLs from `BETTER_AUTH_URL` (`/s/<slug>`), wrong in production | REWORK (use `storeBaseUrl`) | S | T-70 |
| CRSEC-02 | P1 | GAP | AU-01, AU-05, HTTP-01 | One Better Auth instance, one cookie name, one trusted origin, no session audience; app role has unscoped access to `user`, `session`, `account`, `verification`, `two_factor` | REDEVELOP identity layer | L | T-70, T-59, T-54, T-58 |
| CRSEC-03 | P1 | MISMATCH | JOB-03 | RLS framework only knows `app.store_id`; `rls.test.ts` forbids RLS on tables without `store_id`, blocking own-buyer/own-affiliate RLS and origin-only `store_id`; `audit_log` policy rejects store-less audit rows | REWORK; amend ADR-0005; per-table registry | M | T-59 (before T-52, T-57) |
| CRDAT-03 | P1 | DEFECT | SC-24, HTTP-16 | `BUYER_DATA_INVENTORY` omits `shipment.tracking_history`/`last_error`; redaction leaves courier free text | REWORK | S | T-47 |
| CRDAT-05/06/07 | P1 | GAP | SF-07, SC-10, SC-02 | `order` lacks discount split; `store` lacks subscription state; `product`/`variant` lack taxonomy/feed attributes | REWORK | M each | T-46, T-50, T-44 |
| CRUXR-06..13 | P1/P2 | GAP | SC-25/26/27/28, SA-08, SF-12, AF-*, BA-* | No finance, payouts, abandoned carts, promotions, billing, hybrid shipping setup, affiliate or buyer surfaces exist | BUILD | M-L | T-37, T-44..T-46, T-48, T-50, T-52..T-58 |

### P2 / P3 (batch into the owning task)

| Ref | Sev | Finding | Rec. | Effort | Task |
|---|---|---|---|---|---|
| CRMON-11 | P2 | Quote `COD_AMOUNT` = subtotal, booking COD = `order.total`; provider COD fee at booking exceeds the quoted cost and eats margin | REWORK | S | T-37 |
| CRMON-13 | P2 | No provider callback/webhook handler exists (AutoLaris, Mengantar); no late-payment quarantine | BUILD: HTTP-17 (AutoLaris callback), HTTP-26 (Mengantar webhook; HTTP-18 is the privacy export) | M | T-49, T-48 |
| CRMON-14 | P2 | Buyer page `/o/[token]` and seller pages show "Mengantar" labels; no source guard | REWORK + guard | S | T-37, T-48 |
| CRMON-16 | P2 | Tests lock in forbidden behaviour (`jobs.test:187`, `fulfillment.test:145-163`, `:364`); the transition-matrix test only compares the table with itself | REWORK tests | S | T-37 |
| CRSEC-04 | P2 | Invite and reset URLs stored in clear in `mail_outbox`, which the app role can read/update table-wide; no real mailer | REWORK: real mailer, purge bodies, revoke app SELECT | M | T-73 (T-22 stays open for the provider), T-50 dunning |
| CRSEC-05 | P2 | Third-party pixels mount on checkout and share an origin with `/admin` and `/seller` in path mode; Meta `autoConfig` not disabled | REWORK: host split (T-70), `autoConfig false` | S-M | T-70, T-38 |
| CRSEC-06 | P2 | Operator capabilities beyond `logs.read` do not exist (IAM-8) | NEW: platform capability grants (also needed by T-50, T-54) | M | T-60 |
| CRSEC-07 | P2 | Roles are owner/staff only; no manager, per-member grants or `content.publish` (IAM-2/8) | REWORK | M | T-17 |
| CRSEC-08 | P2 | Platform role is granted everything including future tax/bank tables and serves storefront resolvers | NEW: narrow resolver/worker roles; per-table grants | M | T-59 (before T-52/53/57) |
| CRSEC-09/10/11 | P2/P3 | Public API bodies uncapped, no rate limiter; Better Auth has no rate-limit/trusted-proxy config; 6 MB action limit global; `signals` checks `content-length` only | REWORK | S-M | T-16, T-17, T-29 |
| CRUXR-03 | P3 | The admin UI brand is "Bos" (`admin/layout.tsx`, `admin/logs`); ADR-0008 retires the `bos` host label in favour of `berkah.bukalaris.com`. Owner naming decision recorded 2026-10-27 (DECISIONS D-12): the surface is the Owner console, so the copy is renamed | REWORK copy | S | T-62 |
| CRDAT-04 | P2 | `order.buyerPhone` stores the raw string; ADR-0010 canonical form is `628…` (existing `normalizePhone` maps to `0…`) | REWORK: shared normalizer | S | T-57 |
| CRDAT-08 | P2 | No `(store_id, created_at)` index on `order` | REWORK | S | with T-37 migration |
| CRDAT-09 | P2 | TASKS.md stopped at T-47 | DONE in this pass (T-48..T-58 merged) | — | — |
| CRSEC-12..17, CRUXR-04/05 | P3 | Session lifetime and re-auth, doc drift in ADR-0005 (`system_log` has `store_id`), column-level grant on `store`, phone/email in URLs and rate-limit keys, media preview ignores selected store, silent secret fallbacks, duplicate `_run.ts`, dead `lib/utils.ts` | REWORK | S each | T-17, T-22, T-25, T-29, T-33, T-51 |

### Verified OK (keep, do not touch)

Integer-IDR `bigint` money with CHECKs; strict checkout input and server-derived price/fee; checkout idempotency (store+key, request hash, unique cart); atomic stock decrement and cancel restock once; `shipped -> cancelled` and `completed -> cancelled` refused; COD at booking derived from the order's payment method; Mengantar client (write flag, key redaction, `success:false` treated as error, unknown statuses change nothing); FORCE RLS on all 31 tenant tables including `store` keyed by id; store context transaction-local with cross-store switch refused; no browser-supplied store id reaches a query; operator/TOTP check per request; AES-GCM sealing with AAD, constant-time token compare, HMAC order links; nonce CSP; log allowlist; ARCH-5 route integrity (CRUXR-14); storefront theme isolation and checkout isolation (CRUXR-15); accessibility and 320 px coverage (CRUXR-16); real invariant tests for tenant isolation, idempotency, stock races and outbox atomicity.

## 4. PR coverage (condensed)

DONE: PR-1, 2, 3, 4, 8, 10, 11, 12, 14, 15, 16, 19, 22. PARTIAL: PR-5 (fakes, live writes locked), PR-9 (no MCP), PR-20 (simulation only), PR-21 (dev mail outbox only). NOT STARTED: PR-6, 7, 13, 17, 18, 23..29. (Reviewer matrix, `agent://ReviewDataCoverage` section 2.)

## 5. Stale or overstated claims (fix in the owning doc)

- `STATUS.md` still described PR-18 as deferred and a single platform Mengantar account; superseded by PR-18 (Proposed), PR-27, ADR-0007 (the status text was refreshed on 2026-10-27, re-check after the next merge).
- T-39 "Done on the fake adapter" holds only for the fake: RTS never reaches `returned`, unknown outcomes are retryable, real shapes are unverified (CRMON-02/04).
- "Buyer data export and audited redaction - Done" omits `shipment` courier text (CRDAT-03; T-47).
- DEPLOY-COOLIFY sets `BETTER_AUTH_URL` to the app host together with `STORE_ROOT_DOMAIN=bukalaris.com`, a combination the current proxy breaks (CRSEC-01).

## 6. Recommended sequencing against the task chains

1. **Now, small and safe (S), only when the owner allows development:** reserve platform labels in `host.ts` and store creation (CRSEC-01); use `storeBaseUrl` in the product page (CRUXR-02); `autoConfig false`; `shipment` fields into `BUYER_DATA_INVENTORY` (CRDAT-03); fix the doc drifts in section 5 (the deploy-host drift is already corrected in DEPLOY-COOLIFY).
2. **T-51 (restructure, move only):** carries no behaviour change. Exact-host dispatch and the per-surface cookie/audience design (CRSEC-02) belong to T-70 and the RLS framework change (CRSEC-03) to T-59; do not start T-52/T-57 before T-59 exists, and do not start T-54/T-55/T-58 before T-70.
3. **T-37 (ledger) with the order/shipment fixes:** `returned` state and the single status writer (CRMON-02/03), `unknown` booking state and reconcile (CRMON-04/05/15), `order_financials` columns and constraint (CRMON-01), reservation and re-quote (CRMON-09/11), tests that stop asserting forbidden behaviour (CRMON-16). This is the P0 gate for any live COD.
4. **T-49 then T-50:** the payment adapter redevelopment and seller `pay` removal come before real subscription or order payments (CRMON-06/07); T-50 needs a real mailer for dunning (CRSEC-04).
5. **T-48:** hybrid shipping, per-store pickup (CRMON-08) and variant weight (CRMON-10) are prerequisites for any live booking.
6. **Chains B and buyer (T-52..T-58):** unchanged order; blocked on CRSEC-03/CRSEC-08 and the OPEN policy items in ADR-0009/ADR-0010.

## 7. Decisions needed from the owner

1. Approve REDEVELOP for the payment adapter (T-49) and the identity layer (CRSEC-02) rather than patching them.
2. Accept that T-37 absorbs the order-status writer, booking-recovery and `returned` fixes, so T-37 grows from planned ledger work to a money-correctness gate.
3. Add NEW tasks: RLS framework and narrow roles for platform-owned tables (proposed T-59); platform capability grants, IAM-8 (proposed T-60); variant weight (proposed T-61); exact-host dispatch, per-surface sessions and reserved labels (proposed T-70); real mailer and `mail_outbox` hardening, CRSEC-04 (proposed T-73).
4. Confirm that a quick-fix pass (section 6, step 1) may be done before T-51 starts.

## 8. Not verified

Playwright e2e was not run; production DNS/TLS, Secure cookie flag and server-action origin checks behind the proxy; live Mengantar and AutoLaris contracts (fakes only); Better Auth storage of reset/session tokens (reviewer inference); Meta pixel form-field collection depends on each seller's Meta settings; `drizzle-kit check` drift was not run (reviewer compared schema and migrations manually).

Change history: 2026-10-27 — review ids prefixed `CR-` so they do not collide with spec ids (audit TRC-8); the behaviour-change items formerly assigned to T-51 were reassigned to T-70, T-59 and T-62 because T-51 is move-only (audit OPS-16).
