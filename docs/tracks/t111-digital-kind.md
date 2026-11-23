# T-111 — Product kind and checkout rules for digital and mixed orders

- Task: `docs/TASKS.md` T-111 (PR-4, Risk R4). Branch `task/t111-digital-kind` from `main` `49fb363`.
- Sources: ADR-0016 sections 1–3, 5 and decisions 19–22; ADR-0002; ADR-0013 section 4; T-61 parcel weight rule.
- Scope: product kind, variant weight/stock rules, activation readiness (decision 21), digital-only and mixed checkout rules, lifecycle, feed exclusion, e-mail/redaction and UI without shipping blocks for parcel-free orders. Access links, grants and reserved member-area structure belong to T-112.

## What was built

| Area | Change |
|---|---|
| Migration `0025_t111_digital_kind.sql` | Generated: `product.kind` (`physical` \| `digital`, default `physical`), `variant.track_stock` (default `true`), `variant.weight_grams` nullable (`> 0` or `NULL`), `order_line.{product_kind,track_stock}`, `order.{has_physical,has_digital}`, nullable shipping columns on `order` and `order_financials`, CHECKs (`order_kind_chk`, `order_shipping_presence_chk`, `order_digital_rules_chk`, `order_shipping_fee_chk`, `order_area_chk`, `order_shipped_chk`). Hand-written `-- ===== T-111`: `product_kind_guard` (refuses kind change after any `order_line`), `variant_kind_guard` (AFTER INSERT/UPDATE on `variant` + DEFERRABLE INITIALLY DEFERRED on `product.kind` change: physical requires positive weight & tracked stock, digital requires `weight_grams IS NULL`), updated `shipping_snapshot_guard`, `order_status_guard` (digital-only `awaiting_payment -> completed` on pay), `order_seller_payment_guard` (`NEW.status IN ('placed', 'completed')`) |
| Catalog `seller/commerce/catalog.ts` | `kind` on product create/update, `trackStock` and optional `weightGrams` on variants, `kindLocked` flag on `getProduct`, kind-change lock after sale, activation gate (decision 21: digital requires ready prepaid method; physical on `seller_owned` store requires ready shipping) |
| Shipping & Promotions | `shipping/shipping.ts` `parcelWeightKg` sums physical lines only; `promotions/checkout.ts` free-shipping threshold counts physical lines only and refuses free-shipping vouchers on parcel-free orders |
| Checkout, Orders, Feeds, Notify, Privacy | `checkout.ts` skips shipping quote/address/courier for digital-only, quotes physical lines only for mixed, refuses COD with any digital line, requires e-mail with any digital line, skips stock decrement/restock for unlimited (`trackStock = false`) lines; `orders.ts` completes digital-only on pay and keeps mixed on `placed` until parcel delivery, blocks `process`/`ship`/`bookShipment` on digital-only; `storefront/feeds.ts` excludes digital products; `ops/jobs/notify.ts` omits shipping/ongkir lines for parcel-free orders; `privacy.ts` keeps `shipping_address` NULL on redaction |
| UI | Seller products (`SC-02`, `SC-03`): kind selector (locked after sale), digital badge, unlimited stock toggle; Storefront (`SF-04`, `SF-06`, `SF-09`): digital badge & delivery note, unlimited stock availability; Checkout (`SF-07`, `SF-08`), `/o/[token]` (`SF-11`) and Seller order (`SC-13`): digital-only omits area/courier/address/ongkir/booking; mixed hides COD and requires e-mail |
| System map & Docs | `docs/04-SYSTEM-ARCHITECTURE.md` ARCH-5 rows (`SC-02`, `SC-03`, `SC-13`, `SF-04`, `SF-06`, `SF-07`, `SF-08`, `SF-11`), `docs/TASKS.md` |

## Named tests (`packages/db/test/t111-digital-kind.test.ts`, 6)

1. "digital variants have no weight and unlimited stock by default; physical variants require weight and tracked stock in service and database"
2. "activation follows ADR-0016 decision 21: digital needs a ready prepaid method, physical on a seller-owned store needs ready shipping"
3. "kind change is refused after a sale (service and database)"
4. "digital-only order skips shipping, requires email, refuses COD, handles unlimited/counted stock, completes on payment, omits shipping from email and redacts cleanly"
5. "mixed order quotes shipping from physical lines only, refuses COD, ignores digital lines for free-shipping threshold, and follows the parcel to completed"
6. "catalog feeds exclude digital products (ADR-0016 decision 22)"

Existing physical test suites (`checkout.test.ts`, `checkout2.test.ts`, `shipping.test.ts`, `catalog.test.ts`, `orders.test.ts`, `retention.test.ts`, etc.) passed completely unchanged.

## Mutation checks

Each Done-when mutation applied in place, the named test run, restored from backup and `sha256sum -c` verified OK.

| # | Invariant broken | Change | Named test that failed |
|---|---|---|---|
| M1 | include a digital line in shipping weight | `parcelWeightKg`: removed `l.productKind === "digital"` filter | 5 ("expected 11 to be 1") |
| M2 | allow COD with a digital line | `placeOrder`: disabled `hasDigital && paymentMethod === "cod"` check | 5 ("expected '23514' to be 'cod_unavailable_digital'" — DB CHECK caught it too) |
| M3 | complete a mixed order at payment | `applyTransition`: completed every order on `pay` regardless of `hasPhysical` | 5 (failed) |

## Migration proof on a populated copy

`create database bukalaris_t111_pop template bukalaris owner bukalaris_owner` (dev database seeded: 6 stores, 55 products, 89 variants, 64 orders, 122 order lines). Migrated as `bukalaris_owner` to `0025` (26 journal rows): all counts unchanged, 0 unvalidated constraints, all existing products `kind = 'physical'`, all existing orders `has_physical = true AND NOT has_digital`, triggers `product_kind_guard`, `variant_kind_guard` and `product_variants_kind_guard` present. Copy dropped.

## Independent review (2026-11-23)

Reviewer: Antigravity CLI (`agy`) via `ai-ask`, read-only (initial review in 3 parts: Part 1 DB schema/catalog/shipping/promotions/feeds/notify/privacy, Part 2 migration `0025`/checkout/orders/fulfillment, Part 3 web UI; Codex 401, Claude weekly limit). Initial verdicts: CHANGES REQUIRED on all 3 parts; every blocker, major and minor finding fixed:
1. Blocker (`catalog.ts`): `productInput.kind` made optional on update (fallback to `before.kind`, `.default("physical")` on create only) so editing a sold digital product never fails or converts it.
2. Blocker/Major (`catalog.ts`): `updateProduct` locks variants `FOR UPDATE` before checking `order_line`, resets `stock: 0` when switching to digital, and writes `variant.update` rows to `catalog_audit`; `addVariant`/`updateVariant` lock `product` `FOR SHARE`; `updateVariant` resets `stock: 0` when `trackStock = false`; `physicalWeightCheck` preserves `path: ["weightGrams"]`.
3. Major (`0025` `order_status_guard`): `awaiting_payment -> placed` and `placed -> processing/shipped/completed` require `NEW.has_physical` so digital-only orders can never be stranded in `placed`.
4. Major (`0025` `variant_kind_guard`): trigger covers `product_id, store_id` and reads `product.kind` with `FOR SHARE`.
5. Major (`0025` `shipping_snapshot_guard`): digital order `INSERT` refuses `buyer_email IS NULL` regardless of `buyer_name` (closes `[dihapus]` bypass on insert while keeping redaction UPDATE working).
6. Major (`schema-ledger.ts` / `0025`): added `order_financials_account_pair_chk`, plus `tracking_number is null` for `!has_physical` in `order_shipping_presence_chk` and `(product_kind <> 'physical' or track_stock)` in `order_line_chk`.
7. Major (`promotions/checkout.ts`, `shipping/shipping.ts`, `shipping/fulfillment.ts`, `checkout.ts`): `PromotionLine.productKind` required; `parcelWeightKg` fails fast on physical null weight; `bookingInput` filters `productKind = 'physical'`; `placeOrder` `cart_changed` checks `variantId`, `quantity`, `productKind`, `weightGrams`.
8. Major (`lp/order-form.tsx`, `landing-renderer.tsx`, `product-fields.tsx`, `actions.ts`, `voucher-field.tsx`): consistent `trackStock === false` in LP `OrderForm` + digital badge & delivery note on LP; hidden `trackStock="on"` for physical variants; `VoucherField` step numbering adjusted (`step={needsShipping ? 5 : 3}`).

Confirmation review (`agy`, Parts A and B): **APPROVE** on both parts.

