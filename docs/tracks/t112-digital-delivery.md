# T-112 — Access links, grants and digital delivery

- Task: `docs/TASKS.md` T-112 (PR-2, Risk R4). Branch `task/t112-digital-delivery` from `main` `c729a29`.
- Sources: ADR-0016 section 4, section 7 and decisions 18, 20, 23, 24; C-G1..C-G3; ADR-0013 section 6; D-31 (OPEN-G1, OPEN-G4); D-33 (`RL-ACCESS-OPEN`).
- Platform stores no seller files and never makes an outbound HTTP request to any access link.

## What was built

| Area | Change |
|---|---|
| Migration `0026_t112_digital_delivery.sql` | Generated: `product_access_item` (type `link` only, CHECK refuses reserved `video_embed`/`live_session`, https-only no-credentials URL CHECK, max 2000 chars), `product_access_note` (plain text <= 5000 chars, separate table from `product`), `digital_grant` (unique `(store_id, order_id, variant_id)`, state `active` \| `revoked`, optional `expires_at`, `is_test`), `store.digital_grant_expiry_days`. Hand-written `-- ===== T-112`: FORCE RLS & grants on all three tables, `product_access_guard` (digital products only, max 10 links per product), `digital_grant_guard` (requires paid order & digital order line, immutable identity, no reactivation, no delete except demo reset, ADR-0016 decision 20 affiliate hold start & void on revocation inside hold), retention class `digital_grant`, `reset_demo_payments` updated |
| Services `seller/commerce/digital.ts` | `validateAccessUrl`, `hasDigitalDeliveryContent`, `getProductAccessContent`, `addAccessLink`, `reorderAccessLink`, `removeAccessLink`, `saveAccessNote` (all audited without raw URL/note body), `grantDigitalAccessInTx` (idempotent, called ONLY inside `applyTransition` `"pay"` settlement transaction), `revokeOrderDigitalGrantsInTx` (called on cancel, seller refund and order redaction C-G3), single content reader `resolveOrderDigitalGrants` (enforces `RL-ACCESS-OPEN`, suspended-store hide C-G1, empty links & null note on expiry/revocation), `sellerOrderDigitalGrants`, `extendDigitalGrant`, `revokeDigitalGrant` |
| Catalog activation (ADR-0016 decision 3) | `catalog.ts` `assertCanActivate` requires digital products to have at least one access link or non-empty access note before activation |
| Reserved member-area structure (ADR-0016 item 27) | `packages/db/src/member-area/index.ts`, empty route folders `apps/web/src/app/(buyer)/buyer/members/` and `apps/web/src/app/(seller)/seller/memberships/` (no pages or handlers), paths `/member`, `/members`, `/buyer/members`, `/seller/memberships`, `/s/<slug>/member(s)` reserved in `platform/host.ts` (`dispatchHostPath`) to answer `404` on every host |
| UI | SC-03 `/seller/products/[id]` + `digital-actions.ts`: access links add/reorder/remove, plain-text access note, notice that sharing permissions stay on seller's host; SC-13 `/seller/orders/[id]` + `actions.ts`: grant list, extend and revoke forms (audited); SF-11 `/o/[token]`: active grants rendered via `resolveOrderDigitalGrants` with label, destination host, `target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer"`, plain-text note, nothing shown on expiry/revocation/store suspension |

## Named tests (`packages/db/test/t112-digital-delivery.test.ts`, 5)

1. "validates https-only URLs without credentials, enforces caps and reserved types, makes no outbound request, and blocks activation without content"
2. "no grant before paid and none from callback alone; exactly one grant per line under concurrent/replayed settlement; test orders marked as test"
3. "access links and note never leak into storefront reads, feeds, e-mails or audit logs"
4. "expired, revoked, suspended-store, refunded and redacted orders show nothing; seller extend/revoke audited; RL-ACCESS-OPEN throttles; cross-store isolated"
5. "reserved member-area paths answer 404 on every host (ADR-0016 item 27)"

E2E `apps/web/e2e/t112.spec.ts` (mobile-320 and desktop): seller adds link + plain-text note with markup and activates, storefront HTML & Storefront API leak nothing, reserved paths return 404, unpaid digital order shows no link, confirmed payment shows label/host/no-referrer link & escaped note text, extend & revoke hide link, mixed order grants digital line while keeping parcel flow.

## Mutation checks

Each Done-when mutation applied in place, the named test run, restored from backup and `sha256sum -c` verified OK.

| # | Invariant broken | Change | Named test that failed |
|---|---|---|---|
| M1 | grant on order creation | `checkout.ts`: inserted `digital_grant` inside `placeOrder` before payment | 2 (`PostgresError: digital_grant requires a paid active order` from `digital_grant_guard`) |
| M2 | show the link for a revoked/expired grant | `digital.ts`: bypassed `active` filter in `resolveOrderDigitalGrants` | 4 (`AssertionError`) |
| M3 | include an access link in the product read/API response | `storefront.ts`: attached `product_access_item.url` in `getPublishedProduct` | 3 (`AssertionError` canary detected) |

## Migration proof on a populated copy

`create database bukalaris_t112_pop2 template bukalaris owner bukalaris_owner` (dev database seeded). Migrated as `bukalaris_owner` to `0026`: 0 unvalidated constraints, all 3 new tables (`product_access_item`, `product_access_note`, `digital_grant`) under FORCE RLS, all 4 triggers (`product_access_item_guard`, `product_access_note_guard`, `digital_grant_guard`, `digital_grant_affiliate_sync`) active. Copy dropped.

## Independent review (2026-11-23)

Reviewer: Antigravity CLI (`agy`) via `ai-ask`, read-only (2-part initial review + confirmation review). Initial verdicts: CHANGES REQUIRED on both parts; every blocker, major and minor finding fixed:
1. Blocker (Part 2): `apps/web/src/app/(seller)/seller/products/digital-actions.ts` included in confirmation review; all 4 actions verified (`requirePortalCsrf` -> `sellerScope()` -> `@bukalaris/db` service).
2. Major (`digital.ts` & `o/[token]/page.tsx`): `RL-ACCESS-OPEN` made fail-closed by default (`countRateLimit !== false`), evaluating order & IP buckets together via `Promise.all`; `/o/[token]` skips calling `resolveOrderDigitalGrants` while `awaiting_payment`/`awaiting_confirmation`.
3. Major (`0026` `product_access_guard`): locks `public.product FOR UPDATE` and refuses changing `(store_id, product_id)` on `UPDATE`.
4. Major (`0026` `digital_grant_guard` & `digital_grant_affiliate_sync`): affiliate hold/void moved to `AFTER INSERT OR UPDATE OF state` trigger (no side effect on `ON CONFLICT DO NOTHING`, partial revoke only voids digital-only commission when no active grant remains); `INSERT` requires `state = 'active'`, paid non-cancelled/non-returned order, and `is_test = test_order`; `revoked` rows frozen against all updates; `DELETE` checks `store.slug LIKE 'demo-%'`; `digital_grant_state_chk` requires non-empty `revoked_by`.
5. Major (`digital.ts`, `orders.ts`, `host.ts`): `validateAccessUrl` normalizes via `parsed.href` and rejects control chars/backslash; `revokeOrderDigitalGrantsInTx` normalizes reason (>= 3 chars) & actor; `extendGrantInput` rejects boolean `days`; `reorderAccessLink` audited; `orders.ts` slices refund reason to 500 chars and falls back on blank cancel note; `host.ts` checks reserved member-area paths case-insensitively.

Confirmation review (`agy`): **APPROVE**.

