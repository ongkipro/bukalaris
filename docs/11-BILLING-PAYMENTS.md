# Bukalaris Billing, Payments, and Money Boundary

## BILL-1 — Phase 1 order money

- Owner: Bukalaris finance owner

An order is one store's commercial record. The server snapshots item price,
discount, delivery amount, payment channel amount/fee as returned by the
provider, and chosen fulfillment method. Client-posted totals are informational
only and cannot be booked as money truth.

## BILL-2 — Payment state policy

- Owner: Bukalaris finance owner

| State | Meaning | Allowed transition |
|---|---|---|
| pending_instruction | Local checkout exists; provider creation is pending/unknown | Reconcile or create once with stable reference |
| awaiting_payment | Provider reference exists; no approved settlement yet | Approved payment evidence or expiry/cancel policy |
| paid | Approved settlement policy proves collection | Fulfillment decision, refund workflow later |
| failed/expired | Provider or local policy terminally rejects | New checkout only under explicit policy |

Only a merchant-account-specific settlement policy can move a **prepaid**
`awaiting_payment` payment to `paid`. For prepaid payments a shipping callback,
tracking status, or generic success phrase is not settlement proof, and an
AutoLaris payment callback is only a trigger for verification by pull: `paid`
requires the provider inquiry to return `rc` `00`, status `PAID` and an amount equal
to the attempt's `total_idr`, and live settlement stays operator-confirmed until the
vendor status codes are observed in production (ADR-0006 decision 6, D-21). COD is different:
collection happens at the door, so a COD payment is marked `paid` only on the
provider's `DELIVERED` status through the single order-status writer (ADR-0006
decision 4); any other tracking status, and any manual seller completion, never
settles a COD payment.

## BILL-3 — Marketplace finance is not Phase 1

- Owner: Bukalaris finance owner

Multi-seller marketplace checkout and split settlement remain deferred: shared
commission, subsidy, refund, reserve, tax and settlement policy must close before
that flow ships. Single-store seller finance is separately proposed in BILL-4/
BILL-5, Partner Mengantar provisioning and shipping cashback in BILL-6, subscription in BILL-7, and platform-owned
affiliate finance in BILL-8. A discovery listing or affiliate handoff never
authorizes a combined checkout.

## Provider ownership decision

Owner direction (2026-10-27, ADR-0007) keeps all shipping, payments, discounts,
margin, and shipping cashback 100% Bukalaris-managed under one unified financial
system: Bukalaris generates a new Partner-managed Mengantar seller account
(`POST /api/partner/v1/sellers`, `partner_managed`) for every store — even if a
seller previously had an old external Mengantar account, they must use the new
Bukalaris-generated account — with the platform master Mengantar account
(`platform_master`) as fallback. Sellers never paste an external API key
(`own_key` removed) and there is no "System A vs System B" split. AutoLaris
remains platform-managed for prepaid buyer payments and the separate platform
subscription invoices (PR-18/BILL-7). Buyer and seller surfaces display
`Bukalaris Kirim` / `Bukalaris Bayar` (with only a one-time store onboarding
disclosure if required by Mengantar's Partner API terms), while the Owner
console retains vendor names. Q-17 legal review, partner settlement/cashback
sweep verification (`OPEN-F9`), and live provider write tests remain gates.

## BILL-4 — Immutable order financial allocation and Mengantar shipping reconciliation

- Status: Proposed (ADR-0006, 2026-10-26; revised 2026-10-27)
- Owner: Bukalaris finance owner
- Source: PR-4, PR-5, PR-23, Q-12, Q-17, ADR-0006.
- Statement: Every checkout submission shall freeze an immutable
  `order_financials` record, plus one `order_line_financials` row per order line,
  in the order transaction, separating merchandise proceeds, goods and shipping
  discounts, included and added sales tax, buyer-charged shipping, COD fees, the
  affiliate commission and the payment-gateway admin fee. The actual Mengantar
  booking cost, platform shipping margin and seller shipping debit are recorded
  at booking in the separate append-once `shipment_cost` record (DATA-7), so
  `order_financials` is never updated after checkout.
- Acceptance: The allocation identity holds to the rupiah: `payable = goods_proceeds
  + included_sales_tax + added_sales_tax + shipping_charged + cod_fee + cod_fee_vat`
  (`payable` is `order.total`; the gateway admin fee is added separately), and
  `sale_amount = goods_proceeds + included_sales_tax + added_sales_tax -
  affiliate_commission`. The seller entitlement is derived (`sale_amount` plus
  `seller_cashback_idr` and the `shipping_debit` / `shipping_debit_reversal`
  entries) and never stored. BILL-6 defines Partner Mengantar provisioning and
  the shipping cashback split (`shipping_cashback_gross_idr`,
  `platform_cashback_idr`, `seller_cashback_idr`); BILL-8 subtracts the frozen
  affiliate commission across all opted-in prepaid and COD orders. Platform
  shipping margin, platform shipping cashback, COD fees, COD-fee VAT and
  gateway fees never become seller goods proceeds. Live booking re-quotes route and
  derivation as the quote) outside any lock, then reserves any seller shipping
  debit as a `shipping_debit` ledger entry and the `shipment_cost` record in one
  transaction under the order-row then per-store locks, and refuses before the
  provider write when the debit cannot be covered by available balance or, for a
  prepaid order, available balance plus the order's own pending sale; the
  provider call is made only after that transaction commits. A prepaid order
  cannot be booked before payment; COD is derived from the order's payment
  method, never a request parameter, and the COD amount sent equals `payable`
  (equality checked before the call, ADR-0006 decision 7); a transport failure
  keeps the reservation and blocks blind rebooking, and a cancellation
  acceptance keeps the debit until the provider confirms the void.
- Constraints: BILL-1, BILL-2, DATA-2, DATA-7, NFR-2, ADR-0006.

| Flow | Pure engine / rule | Enforced at | Stored in | Shown on |
|---|---|---|---|---|
| Order total & allocation | `calculateOrderFinance` (integer IDR; rounding rule per component in the table below, never a bare `Math.round`) | Checkout submit (server-authoritative) | `order` + `order_financials` + `order_line_financials` (frozen at creation) | `/checkout`, `/o/<token>`, `/seller/orders/[id]` |
| Mengantar shipping & margin | Quote cost + platform margin (`shipping_quote`); delta `booked_shipping - shipping_charged` reconciled at booking | Checkout quote & worker `shipment.book` | `order.{shipping_provider_cost,shipping_margin,shipping_fee}`, `shipment`, `shipment_cost` (booked cost, delta, debit, margin; append-once) | Checkout courier options, `/seller/orders/[id]`, `/admin/shipping` |
| COD handling fee | Optional, OFF by default (the provider COD fee is already inside the quoted courier cost). When enabled by platform policy: `max(min_cod_fee_idr, round_half_up(B * cod_fee_rate_bps / 10000))`, `B = (subtotal - goods_discount) + shipping_charged`; goods sales tax is outside `B` (no tax-on-tax). VAT on the fee is a policy value (the effective `vat_output` rate for the `cod_fee` line, entered with an effective date) and is `0` while PPN is OFF or no policy exists; no VAT rate is written here or in code. COD is offered only for courier services whose `courier_service_policy` row has `cod_allowed` and `return_free` (ADR-0006 decision 4) | Checkout submit | `order_financials.{cod_fee_idr,cod_fee_vat_idr,cod_fee_vat_rate_bps,cod_fee_vat_policy_version_id}` inside `order.total` | Checkout summary ("Biaya COD") |
| AutoLaris gateway fee | Platform fee schedule (`payment_fees`: explicit `base` per channel — `QRIS` = 0.7% of goods omset `subtotal - goods_discount`; `VABCA` = Rp6.500 flat; other VA banks = Rp3.000 flat; e-wallet = 3.0% of payable total) billed via `/submit` (`courir_id: 1`, 24-key dummy logistics payload, WIB `+7h` arithmetic expiry, `grand_total = buyer_payable = order_payable + admin_fee`, where provider fee nets against settlement); active channels parsed from `GET /api/h2h/list_payment` (absence = disabled, never probe via `create_payment`) | Outbox payment instruction & checkout summary | `payment_attempt.{amount_idr,admin_fee_idr,total_idr,provider_fee_idr}`, `order_financials.expected_gateway_fee_idr` | Checkout summary ("Biaya layanan"), `/seller/orders/[id]` |
| AutoLaris verification by pull (Advice) | A signed callback (`?cb=<reff_id>.<hmac128>`, bound to `payments.reff_id`) is only a trigger: it records the raw body digest and enqueues a verification job that calls the provider inquiry (`POST /api/h2h/advice` with provider `transaction_id`; the bounded poll uses the same call, `ADVICE_MAX_POLLS = 24`). Payment becomes `paid` only when the inquiry returns `rc` `00` AND status `PAID` AND the provider amount equals the attempt's `total_idr`; `rc` `02` is pending; anything else, including generic words such as `SUCCESS` or `DELIVERED`, is `unknown` and never settled. A callback never moves money by itself, and a late `EXPIRED`/`PAID` callback on a terminal order is quarantined (no order payment, no ledger credit, a buyer refund obligation). Live gates are unchanged: until the vendor status codes are observed in production `ADVICE_SETTLED = []` (observe-only), the job only records its classified result, and settlement of a live prepaid payment stays a confirmed operator action; dead `/inquiry_payment` 404 forbidden (ADR-0006 decision 6, D-21) | Callback route (`HTTP-17`) enqueues; scheduled worker job polls | `autolaris_callback`, diagnostic / reconciliation log | `/admin/logs` |
| Platform money position | Read-only derived view, no second ledger, across the single unified Bukalaris financial system: seller pending/available (including `sale` and `cashback`), affiliate available and pending obligations, payouts requested/processing, open buyer refunds, platform shipping margin, platform shipping cashback, payment-fee margin (`admin_fee_idr - provider_fee_idr`), COD fee and its VAT | Scheduled read / Owner console money views | `platform_money_position` view (DATA-7) | `/admin/money` |

### Per-line allocation and rounding (one definition)

Checkout, affiliate commission and reports reuse this single allocation. Lines are ordered by `line_no` (ascending, stable). For line `i`, `line_gross_i = unit_price_i x qty_i` (the price as entered; tax-inclusive when the store's price mode is `tax_included`), and `subtotal = sum(line_gross_i)`.

1. **Discount (pro-rata, largest remainder).** For a store-funded goods discount `D` over the lines in its scope (`S = sum(line_gross_i)` in scope; `D <= S` is enforced): `alloc_i = floor(D x line_gross_i / S)`; the leftover `R = D - sum(alloc_i)` (`0 <= R <` number of lines in scope) is added one rupiah at a time to the lines with the largest remainder `(D x line_gross_i) mod S`, ties to the lower `line_no`. If more than one store-funded goods discount applies, each is allocated in order of creation time then id over the net remaining line amounts and the allocations are summed. Result: `discount_alloc_i` and `net_goods_i = line_gross_i - discount_alloc_i`.
2. **Included tax** (price mode `tax_included`, store rate `sales_tax_rate_bps`): `included_tax_i = floor(net_goods_i x rate_bps / (10000 + rate_bps))`. **Added tax** (price mode `tax_added`): `added_tax_i = round_half_up(net_goods_i x rate_bps / 10000)`. A store has one price mode; the other column is 0.
3. **Totals.** `goods_proceeds = sum(net_goods_i - included_tax_i)`, `included_sales_tax = sum(included_tax_i)`, `added_sales_tax = sum(added_tax_i)`; the per-line commission base is `net_goods_i - included_tax_i` (BILL-8).

All arithmetic is integer (BigInt or PostgreSQL `numeric`), computed once at checkout and frozen in `order_line_financials` (DATA-7); later rate or setting edits never change it. `round_half_up(n / d) = floor((2n + d) / (2d))` for non-negative `n` and positive `d`. Acceptance fixtures: equal lines with an odd discount, a discount that exactly equals one line, tied remainders, in-scope and out-of-scope lines mixed, tax-included and tax-added stores.

| Component | Rule | Rounding (named) |
|---|---|---|
| Discount allocation | pro-rata over `line_gross_i` | exact: allocations sum to `D` (largest remainder) |
| Included tax per line | `net x r / (10000 + r)` | `floor` |
| Added tax per line | `net x r / 10000` | `half_up` |
| COD handling fee | `max(min_cod_fee_idr, B x cod_fee_rate_bps / 10000)` | `half_up`, once |
| COD-fee VAT | effective `vat_output` policy rate on the fee | the policy's `rounding` field (`floor`, `half_up`, `ceil`), once |
| Affiliate commission | `sum(commission_base_i x rate_bps_i / 10000)` | `floor`, once over the sum |
| Gateway admin fee | `payment_fees` schedule, percentage in basis points or flat IDR | `half_up` (schedule vs provider behaviour UNVERIFIED) |
| Platform shipping margin | T-34 margin rule (basis points plus a fixed amount) | rounded up to the configured step (`docs/tracks/shipping.md`) |

## BILL-5 — Append-only seller ledger, COD remittance, payouts, and buyer refunds

- Status: Proposed (ADR-0006, 2026-10-26; revised 2026-10-27)
- Owner: Bukalaris finance owner
- Source: PR-5, PR-23, Q-10, Q-17, ADR-0006.
- Statement: Seller balances shall be derived from an append-only
  `ledger_entry` table under `FORCE ROW LEVEL SECURITY` where prepaid sales land
  as `pending` at payment settlement and release to `available` at delivery
  (`completed`), platform-account COD sales land as `pending` at delivery and
  release to `available` only when the carrier cash is reconciled (owner
  decision 2026-10-27; this supersedes the fixed H+1 release of D-11 and removes
  `cod_release_delay_hours`), nothing is credited or released at `shipped` or in
  transit, a `returned`/`cancelled` prepaid order (possible only before
  delivery) reverses its still-`pending` sale once via partial unique indexes,
  so no negative balance can arise by construction, and payouts/refunds use
  transactional locks and immutable snapshots.
- Acceptance: `available` and `pending` balances equal `SUM(amount_idr)` by
  status and are computed without joining `order` (payout entries have a NULL
  `order_id`); duplicate callbacks or double-clicked returns cannot double-credit
  or double-reverse (`ledger_one_sale_per_order`, `ledger_one_return_per_order`);
  a COD sale is booked `pending` only at the provider's `DELIVERED` status and is
  released only through an approved reconciliation batch (or the provider signal
  once verified), a prepaid sale is released at delivery, and nothing is
  credited or released for an in-transit parcel, so a return (possible only in
  transit) never meets an `available` sale and `available` is never negative;
  the return and `ledger.release` both lock the sale row; the `ledger.release`
  job releases reconciled COD sales and delivered prepaid sales once and skips
  reversed sales; a sale is never credited for a `cancelled` or `returned`
  order and a late payment on
  such an order is quarantined and opens a refund obligation; a `paid` payment
  is never regressed by a later `expired`/`failed` callback; concurrent payout
  requests serialize on the per-store two-key `pg_advisory_xact_lock` (ADR-0006
  decision 4) and snapshot the payout destination; payout, payout reversal and
  adjustment entries are unique per payout or business reference and the payout
  request carries a unique key, so a replayed request or rejection posts
  nothing twice; rejected payouts post an exact opposing `payout_reversal`
  entry; `requested -> processing` needs an approved four-eyes request and
  `processing -> paid` only records evidence; an unknown transfer outcome
  stays `processing`; cancelled/returned paid non-COD orders open one tracked
  buyer `refund` record for the full payment; a platform-account COD sale is
  booked only from the provider's `DELIVERED` status or an approved four-eyes
  manual completion; a read-only ledger verification (`pnpm verify:ledger`, to be built by T-37)
  reports orphan entries and balance/sum disagreements and proves the ledger
  consistency invariants stated once in
  [DATA-7](05-DATA-MODEL.md#data-7--financial-snapshot-append-only-ledger-payouts-and-refunds)
  (balances derived by `SUM` over `ledger_entry`, one `sale` per order, at most one
  `return_reversal`, `available` never negative, payout entries paired with a
  `payout` row, `released_at` and `release_basis` on every released entry, no
  `order` join): a contract, not existing code.
- Constraints: BILL-1, BILL-2, BILL-4, DATA-7, TEN-1, TEN-3, NFR-2, ADR-0006.

Buyer identity extension (Proposed, PR-7, DATA-12, UX-21, ADR-0010): the verified
global buyer portal may display the permitted buyer's order refund status through
the existing BILL-5 `refund` flow. Identity association never changes the original
store/order/payment reference, refund destination or settlement policy. Payment
refunds reach the buyer through that existing verified refund process, not a
buyer wallet, portal credit, seller balance transfer or proof-free refund action.
A typed phone/email cannot authorize a refund or expose its history.

**Payout and refund decisions.**

- A payout request is made by the store owner after a step-up (fresh proof, IAM-9) to a payout destination that is `active` (DATA-7 `payout_destination`). Creating or changing a destination also needs a step-up, notifies the previous verified contact, holds the new destination for **72 hours** (`hold_until`, decided default 72 hours, Owner-configurable, D-19) and stores an account-holder-name check against the store owner's verified name; a mismatch is shown on the approval and acknowledged in its payload. These anti-fraud controls are mandatory for all seller payouts.
- **Operator claim lease & transfer evidence hardening (99ribu precedent):** Executing a `processing` seller payout, affiliate payout, or buyer refund requires acquiring an exclusive **30-minute operator claim lease** (`claimed_by_user_id`, `claim_expires_at`, 409 `PAYOUT_ALREADY_CLAIMED`) with a single-use step-up proof, and recording a cross-payout unique `transfer_evidence_ref` (409 `DUPLICATE_BANK_TRANSFER_REFERENCE`) plus a non-reusable bank transfer receipt artifact ($\le 10\text{ MB}$, magic-byte sniffed PNG/JPEG/WebP/PDF, SHA-256 digest checked with 422 `EVIDENCE_REUSE_FORBIDDEN`). Platform absorbs bank transfer fees.
- `requested -> processing` is "approve for transfer": a four-eyes `approval_request` (action `payout.approve_transfer`, capability `payouts.process`) whose payload hash binds the payout id, amount and bank snapshot, stored as `payout.approval_request_id`. Marking `paid` only records transfer evidence (reference, operator, time) and writes no ledger row. Refunds follow the same two steps (`refund.approve_transfer`, capability `refunds.process`). A ledger `adjustment` is always four-eyes (`ledger.adjust`) with an approved request and a unique business reference.
- An unknown transfer outcome leaves the payout or refund `processing` until finance records the confirmed outcome from bank evidence: no blind retransfer, and no reversal on an unknown outcome. After any database restore, payout and billing jobs stay frozen until every open `processing` row is reconciled against bank evidence (DR-1).
- **No negative balance by construction (owner decision, closes the former OPEN-F1).** Money becomes `available` only for delivered and reconciled parcels, and a return is possible only before delivery, so a return never reverses an `available` sale. Post-delivery returns and refunds are out of ledger scope in M3: if ever needed they are a four-eyes `adjustment` (never a silent reversal), and a late claim after a payout raises an explicit conflict that needs manual finance correction.
- Partial returns and partial refunds are unsupported in M3: at most one reversal and one refund per order, for the full amount.

**COD reconciliation batch.** A COD `sale` (and any `cashback` entry) is booked `pending` at delivery and released only when its carrier cash/cashback is reconciled. Until the provider signal (`isReconciliated` / `typeReconciliation`, semantics UNVERIFIED, OPEN-F8) is observed and enabled, release happens through an Owner console `reconciliation_batch`: prepared by one operator (`payouts.reconcile`) from carrier invoice evidence (per line: order reference, COD amount, carrier invoice line reference, amount and date), bound by a payload hash, approved by a different operator (four-eyes action `cod.reconcile_release`) and applied once. Each item stamps `reconciled_at` and `reconciliation_source` (`owner_batch`, later `provider`), and `ledger.release` then releases the sale and cashback. A line whose amount differs from the order COD amount is a break and is never auto-released. Manual delivery completion (`cod.manual_complete`) is a separate four-eyes action and is never part of a batch.

**Buyer refund composition and disbursement.** A refund exists only for a `paid` prepaid order that is `cancelled` or `returned` before delivery (a returned COD parcel collected no cash, so it has no buyer refund; post-delivery refunds are out of ledger scope). `refund.amount_idr = goods_refund_idr + shipping_refund_idr + fee_refund_idr`, where `goods_refund_idr = goods_proceeds + included_sales_tax + added_sales_tax`, `shipping_refund_idr = shipping_charged` and `fee_refund_idr` is the buyer-paid gateway admin fee, refunded in full (owner decision D-20, 2026-10-28, closes OPEN-F4); the goods and shipping components together equal the order `payable` and the settled `payment_attempt.amount_idr`, and `amount_idr` never exceeds `payment_attempt.total_idr`. The platform funds the refund; the seller's `return_reversal` and the affiliate attribution void are separate effects (ADR-0006, ADR-0009) and never restore the same funds twice. The disbursement method and the source of the buyer's destination are OPEN-F4 (recommended, not decided: manual transfer by Owner console staff to a destination the buyer supplies on the signed one-order status page, with its account-holder name compared to the order recipient; a typed phone or email alone never authorizes a refund).

Change history: 2026-10-27 documentation audit pass: audit FIN-01..FIN-27 and SPV-04/SPV-05 applied across BILL-2, BILL-4 to BILL-9 (allocation identity and rounding table, billing period formula, refund composition, four-eyes on approve-for-transfer). Owner decisions of the same day then replaced the H+1 COD release with reconciliation-gated release, closed OPEN-F1, OPEN-F2, OPEN-A1 and OPEN-T19, removed the commission funding gate and its pending-state workaround, and added the two-money-systems principle.

## BILL-6 — Platform-managed Partner Mengantar provisioning, shipping discounts, and cashback ledger

- Status: Proposed (2026-10-27; revised to unified Bukalaris-managed model)
- Owner: Bukalaris finance owner
- Source: PR-27, DATA-9, ADR-0007; extends BILL-4/BILL-5 under one unified financial system.
- Statement: Bukalaris shall provision a Partner-managed Mengantar seller account (`POST /api/partner/v1/sellers`, `partner_managed`) for every store — including sellers who previously had an external Mengantar account — with the platform master Mengantar account (`platform_master`) as fallback, so 100% of shipping management, courier shipping discounts, platform margin, and shipping cashback rules (`cashback_rule`) are controlled by Bukalaris in the Owner console (`SA-07`) and accounted in one unified seller ledger.
- Acceptance: Sellers never paste an external Mengantar API key (`own_key` removed) and there is no two-system split. `order_financials` snapshots `shipping_account_id`, `shipping_account_kind` (`partner_managed` | `platform_master`), `shipping_cashback_gross_idr`, `platform_cashback_idr`, and `seller_cashback_idr` (`shipping_cashback_gross_idr = platform_cashback_idr + seller_cashback_idr`). When `seller_cashback_idr > 0`, a `cashback` entry (`ledger_one_cashback_per_order`) is booked `pending` at delivery and released to `available` only when the parcel is delivered and reconciled alongside `sale`. Live `partner_managed` COD dispatches remain gated on `OPEN-F9` (verifying partner COD and cashback sweep to Bukalaris; until verified, COD routes through `platform_master`).
- Constraints: BILL-1, BILL-2, BILL-4, BILL-5, DATA-7, DATA-9, TEN-1, ADR-0007.

## BILL-7 — Platform subscription invoicing and access policy

- Status: Proposed (2026-10-27)
- Owner: Bukalaris finance owner
- Source: PR-18, DATA-10, UX-18; owner decisions 2026-10-27.
- Statement: Charge one all-feature plan at Rp175.000 per store per month DPP
  (ex-tax). The Owner console configures trial/grace days (each defaults to 3), plan
  versions/entitlements and global PPN (default OFF). The scheduler (JOB-09,
  proposed), seller Pay and Owner console
  manual-create shall invoke ONE invoice creator using the same billing
  period formula (below), amount snapshots and AutoLaris `/submit` VA/QRIS adapter.
- Acceptance: Concurrent calls for one period yield the same invoice/reference
  through DATA-10 unique indexes and atomic conflict handling, not Tokophi's
  unsafe check-then-insert sequence. A committed invoice/outbox intent precedes
  remote payment creation; one live/uncertain attempt is enforced per invoice.
  A timeout keeps an uncertain outcome and stable reference, not a new invoice.
  Confirmed settlement (the provider amount equals the payment attempt's `total_idr`, i.e. the invoice total plus any gateway admin fee added to that attempt, and the reference matches) extends the invoice's covered period once;
  replay never extends it twice. Payment return alone is not settlement.
  Enabling PPN affects only new invoices; existing DPP/tax/total snapshots remain.
- Constraints: PR-18, BILL-2, DATA-10, IAM-5, TEN-1, TEN-3, NFR-2, UX-18.

| Event / condition | Subscription result | Access result |
|---|---|---|
| New store in configured trial | `trial` until `trial_ends_at` | All-feature Seller Admin and storefront |
| Accepted invoice settlement or explicit comp covering the required period | `active`, covered end recorded once | Restore seller writes only if no independent operator restriction |
| Trial/paid period expires unpaid | `past_due`, grace deadline recorded | Seller Admin read-only immediately except billing/payment; storefront and checkout stay online |
| Grace expires unpaid | `suspended` (billing state only) | Same read-only seller restriction; no buyer checkout refusal solely for debt |
| Operator sets `store.suspended_at` | Billing state/debt unchanged | Additionally refuse new buyer checkout; safe browsing state remains |
| Payment with operator timestamp set | Financial coverage updated; timestamp untouched | Buyer checkout still refused; payment never lifts the operator lock |
| Operator lifts timestamp while debt remains | Billing state/debt unchanged | Buyer checkout restored, Seller Admin remains read-only while unpaid |

**Billing period formula** (one definition for the scheduler, seller Pay and Owner console manual create). Dates are Asia/Jakarta calendar dates and `period_end` is exclusive.

- **Anchor.** `billing_anchor_date` is the Asia/Jakarta date of `trial_ends_at` (store creation instant plus `trial_days`, default 3). It is written once with the subscription and never changes. The first paid period starts on the anchor date: a store created on 26 Oct with a 3-day trial has `trial_ends_at` 29 Oct, so period 0 is 29 Oct to 29 Nov.
- **Month length.** Calendar months, not 30-day blocks. Period `k` (0, 1, 2, ...) is `[anchor + k months, anchor + (k + 1) months)`, each boundary computed from the anchor and never from the previous end, with the day clamped to the last day of a shorter month (anchor 31 Oct gives 30 Nov, 31 Dec, 31 Jan, 28/29 Feb), so months never drift. The invoice stores `period_index = k`, `period_start` and `period_end`; amounts are not prorated.
- **Trial.** No invoice exists for the trial itself. Period 0 may be invoiced and paid before `trial_ends_at`; paying early never shortens the trial and never moves the anchor, and coverage still starts on the anchor date.
- **Order of payment.** Periods are paid oldest first; coverage extends to that invoice's `period_end` once; at most one non-void invoice exists per `(store_id, period_index)`.
- **Late payment and back-dating.** Coverage dates are never back-dated or moved: a late payment of period `k` covers exactly the stored `[start_k, end_k)`. Paying while `past_due` or `suspended` restores seller writes only while the covered end is in the future (`period_end > now`).
- **Elapsed unpaid periods (OPEN-B1).** Decided (owner, 2026-10-28, D-20, closes OPEN-B1): no back-billing. Each lapsed unpaid period is closed `void` with reason `lapsed`, billing resumes at the first period whose `period_end` is in the future, and the anchor is kept.
- The plan version used is the one effective when the invoice is created; the invoice snapshots DPP, PPN and total.

Comp grants are audited Rp0 `kind=comp` invoices with explicit covered periods;
they do not create subscription revenue, provider instructions or seller ledger
entries. Only comp/accepted payment entitlement operations update coverage.
Manual "mark paid" is bookkeeping only: record actor, reason and source, but do
not extend coverage, synthesize provider evidence, move money or trigger buyer/
seller payment side effects. The UI must distinguish it from an entitlement grant.
Platform invoices and receipts never mix with buyer orders or seller payouts.

**PPN (owner decision 2026-10-27, closes OPEN-T19).** PPN is OFF by default. It is switched ON from the Owner console by a holder of `tax.manage` (IAM-15; the switch is not four-eyes) through a confirmation dialog stating that legal and tax documents and PKP status are the Owner's responsibility, with a reason and an audit entry. There is **no hard PKP gate**. Switching ON requires entering the VAT rate as an effective-dated `vat_output` policy version for the `subscription` line (owner-decision basis, shown as "not advisor-confirmed"; BILL-9 W7, DATA-15): the rate is a policy value, never a constant or a default in code, and **no 11% (or any other) VAT computation exists in the startup phase** while PPN is OFF. The switch is prospective and affects only NEW invoices; each invoice stores the rate and policy-version snapshot it used. The company (PT) legal documents are not issued yet, so tax-invoice and e-Faktur readiness is deferred to the future task T-75 "PPN activation readiness" (entry criteria in ADR-0012 section 9). Annual plan,
first-month promo, subscription payment-fee bearer (settlement compares against
the payment attempt's total, so either answer works) and reminder cadence are
OPEN. Dunning delivery
depends on a real approved
mailer/sender and delivery-result integration (PR-21/Q-16); an audit marker or
development outbox is not a sent reminder. Banners and invoice access remain
usable without mail delivery, but production automated dunning cannot be
accepted until the mailer dependency is met.

## BILL-8 — Affiliate commission, wallet, payout, and withholding

- Status: Proposed (2026-10-27)
- Owner: Bukalaris finance owner
- Source: PR-28, DATA-11, ADR-0009; owner decisions 2026-10-27.
- Statement: Seller-funded affiliate commission shall be frozen at checkout
  for all opted-in seller orders (both prepaid and COD, since all orders settle
  through Bukalaris's unified payment and shipping system), deducted from the
  seller's goods proceeds, held by the platform and credited to the affiliate's
  append-only wallet only for orders that were DELIVERED and whose seller sale
  is released (reconciled where applicable), after the affiliate hold
  (`affiliate_hold_days`, decided default **3 days**, Owner-configurable).
  Affiliate commission base is eligible net goods
  after store-funded discounts; shipping, gateway/platform fees and tax are
  excluded. All amounts are integer IDR and rates basis points.
- Acceptance: Checkout snapshots eligible line rates and bases, then floors once
  after summing `commission_base_i * rate_bps_i / 10000`, where
  `commission_base_i = net_goods_i - included_tax_i` comes from the BILL-4
  per-line allocation (largest-remainder discount, included tax excluded).
  Non-opted-in/blocked lines contribute zero. DB UNIQUE
  `affiliate_attribution.order_id` ensures one commission per order; partial
  unique credit/payout/reversal indexes prevent replay duplication.
  `eligible_at` is set once, when the order is delivered and its seller sale is
  released, to that instant plus the snapshotted `affiliate_hold_days`;
  `eligible_at <= now()` derives readiness, no stored ready flag. Pending
  attribution is not wallet money. In-transit, returned-in-transit, refused or
  cancelled orders earn nothing: the frozen snapshot is voided (attribution
  `void`) without ever being credited, and no wallet entry is written.
  Post-delivery returns are out of scope (ADR-0006); a correction is a
  four-eyes `adjustment`, never an automatic claw-back or negative payout.
- Constraints: BILL-2, BILL-4, BILL-5, BILL-6, BILL-9, DATA-11, IAM-3, PRIV-2,
  PRIV-6, NFR-2, ADR-0009, ADR-0012. No subscription charge is deducted from
  these proceeds.

| Affiliate money event | Required atomic outcome |
|---|---|
| Checkout | Freeze attribution winner, source `bukalaris`, eligible net-goods bases/rates, total `affiliate_commission_idr` and policy versions in `order_financials`, independent of later rate edits |
| Delivery, release and hold expiry | Under affiliate/attribution lock, ensure the order is delivered, its seller sale is released (reconciled where applicable) and the hold has elapsed, then insert one credit; never credit at shipped, merely on payment, or for an unreleased sale |
| Cancellation / return (in transit only) | Void the pending attribution once (a state change, no wallet entry because nothing was credited); retain the immutable snapshot and audit. After delivery there is no automatic action |
| Payout request | Step-up (fresh proof), then lock the affiliate wallet (two-key lock, ADR-0009 section 6), validate an `active` own payout destination (held until `hold_until` after any change, previous contact notified, account-holder name checked) and the available amount (and tax identity only when `tax_identity_required_for_payout` is ON, default OFF), reserve gross with debit under a unique request key and immutable commission allocations and, only when `withholding_enabled`, one immutable `tax_computation` snapshot; overlapping requests cannot spend the same amount |
| Approve for transfer | `requested -> processing` needs a four-eyes `approval_request` (action `affiliate_payout.approve_transfer`, capability `affiliate.payout.process`) whose payload hash binds the payout id, gross, tax, net and the bank snapshot shown to the approver; the transfer is made only after approval |
| Payout completion | `processing -> paid` records transfer evidence only (operator, reference, time; no second approval and no wallet movement): retain gross, tax (0 unless withholding applied), net, bank and `tax_setting` version/computation snapshots; mark paid allocations once. An unknown transfer outcome stays `processing` |
| Rejection | One exact payout reversal releases reservation; record reason; no second reversal on replay |

Affiliate typed code wins over captured link; otherwise the last eligible
server-captured click within the configured window wins. A bad/expired/blocked
typed selector may fall back to an eligible link (ADR-0009); chosen
self-referral (normalized affiliate phone equals buyer phone) suppresses
commission silently, without falling back to another affiliate or failing order.
No affiliate-facing money DTO contains buyer PII; bank/phone masking is enforced
by role in the data layer, not just the UI.

Credit and payout reservation take the same per-affiliate payout lock
(two-key advisory form, ADR-0009 section 6; global lock order in ADR-0006 decision 4). A return can only occur before delivery, hence before any credit, so a return never touches a wallet entry or a payout; a processing transfer stays unresolved until finance confirms paid or rejected.
Seller sale reversal (prepaid, in transit), attribution void and buyer refund
reconcile in the order finance transaction so funds are never restored twice.
Wallet balance queries do not inner-join orders; payout entries have no order
reference.

Tax treatment is policy-controlled (ADR-0012, BILL-9). Startup defaults:
`withholding_enabled` OFF and `tax_identity_required_for_payout` OFF, so a payout
carries `tax_idr = 0` and `net = gross`; affiliates are responsible for tax on
their own commission and receive earnings statements (BILL-9 W5) instead. This
supersedes, for the startup phase, the earlier owner wording "NPWP/KTP tax
identity before the FIRST payout" and "Bukalaris acts as withholding agent"; both
stay as the Phase 2 behaviour that the platform owner activates (approved with `tax.approve`) under the ADR-0012
criteria. When activated: payout is blocked until a reviewed identity and an
effective advisor-confirmed `tax_policy_version` exist, the payout snapshots gross,
base, tax, net, policy version and identity version (`tax_computation`, DATA-15),
and `gross = withheld tax + net`; tax is not deducted a second time from the
wallet. No tax rate is hard-coded. Web claims of PPh 21 for individual
non-employees and PPh 23 near 2% for entities are UNVERIFIED against primary
regulation. Withholding liability is tracked separately from net transfer in the
tax ledger (BILL-9 W4, T-67). `affiliate_hold_days` is decided at **3 days** default (Owner-configurable in `SA-12`; reference points: Tokophi 3, 99ribu 10, Shopify 30). Attribution window, any platform
fee on commission (and its effect on a tax base, OPEN-T12), minimum payout and
transfer mechanism are OPEN; no other product's default or provider payout
endpoint is assumed.

**Delivered-only commission across all opted-in orders (owner decision, closes OPEN-A1 and D-16).** Because Bukalaris manages 100% of shipping and payments in one unified system (ADR-0007), both prepaid and COD orders are commission-eligible. A commission is created and eligible only for orders that were DELIVERED and whose seller sale is released (reconciled), then after `affiliate_hold_days` (default 3 days). In-transit, returned-in-transit, refused or cancelled orders earn zero commission.

**Payout-destination controls (anti-fraud, not tax or KYC; decided mandatory by owner decision D5 / D-19).** These apply to all affiliate payouts from Bukalaris. Creating or changing an affiliate payout destination needs a step-up and notifies the previous verified contact; a new or changed destination is `held` for **72 hours** (`hold_until`, default 72 hours, Owner-configurable) and payouts use only an `active` destination whose hold has elapsed; the account-holder name is compared with the affiliate's registered name and a mismatch is acknowledged in the approval payload.
## BILL-9 — Platform tax workflows

- Status: Proposed (2026-10-27; startup-off defaults, Phase 2 dormant)
- Owner: Bukalaris finance owner with qualified tax advisors
- Source: Owner decisions 2026-10-27 (tax handled by the platform; startup relaxed); PR-31, ADR-0012; BILL-7, BILL-8; DATA-15.
- Statement: Bukalaris is an online-store platform; sellers handle their own sales
  taxes and affiliates handle tax on their own commission. In startup mode the
  platform withholds nothing, collects nothing, gates no payout on tax identity
  and requires no PKP/e-Faktur or seller tax KYC; it provides earnings statements,
  invoice-register exports and optional voluntary tax identity capture. The
  withholding/collecting workflows below are specified in full as a dormant
  Phase 2 capability, driven by a versioned, effective-dated, advisor-confirmed
  policy engine with no hard-coded rate, activated only by the ADR-0012 criteria.
- Acceptance: With default `tax_setting`, a payout has `tax_idr = 0`, `net = gross`,
  no `tax_computation` row and no tax identity prerequisite; a statement for any
  affiliate month reconciles exactly to ledger entries and contains no buyer or
  order identifier; no code path or seed contains a tax rate, base fraction,
  bracket or deadline. With a fixture policy and activation (tests only), W3
  produces one immutable computation per payout, replay produces no second
  computation, and every amount is integer IDR with `gross = tax + net`.
- Constraints: BILL-5, BILL-7, BILL-8, DATA-10, DATA-11, DATA-15, IAM-15, PRIV-6,
  PRIV-10, NFR-2, ADR-0006, ADR-0009, ADR-0012. Not legal or tax advice; every
  legal statement below is UNVERIFIED until a qualified advisor confirms it.

### Modes and phase tags

| Tag | Meaning |
|---|---|
| S | Startup mode: tax foundation by T-65 (lands before T-50 and T-53), statements and invoice registers by T-71, screens by T-66; active with default `tax_setting` |
| D | Dormant Phase 2: specified here, built by T-67, inert until activation (ADR-0012 section 5) |

Illustrative figures in this section are arbitrary test fixtures, not rates and
not advice. Descriptions of the Indonesian rules come from secondary sources
(UNVERIFIED, ADR-0012 F2/F3) and exist only to shape the model.

### Computation contract (pure function shared by payouts and fixtures)

Inputs: `tax_type`, `category`, `as_of_date` (Asia/Jakarta date of the payout
request), `gross_idr`, `tax_year`, and for `cumulative_true_up` the payee's
`ytd_base_before_idr` and `ytd_tax_before_idr`, derived from non-void
`tax_computation` rows of that payee, type and tax year under the per-affiliate
lock (the per-affiliate payout lock, ADR-0009 section 6); no stored running counter exists.

1. Resolve exactly one `confirmed` policy version effective on `as_of_date` for
   `(tax_type, category)`; none means refuse `no_effective_policy` (no debit).
2. `base_idr = round(gross_idr * base_fraction_bps / 10000)`.
3. Brackets are a list `{up_to_idr | null, rate_bps}` (a flat tax is one bracket;
   a no-tax tranche is a 0 bps bracket). `per_payment` applies them to this
   payment's base only; `cumulative_true_up` computes `T(B0 + base)` with
   `B0 = ytd_base_before_idr`.
4. `tax_idr = round(T(base))` for `per_payment`; for `cumulative_true_up`
   `tax_idr = round(T(B0 + base)) - ytd_tax_before_idr`, clamped at 0 and flagged
   `clamped`. `tax_idr > gross_idr` refuses `policy_invalid`.
5. `net_idr = gross_idr - tax_idr`.

`round` is the policy's `floor`, `half_up` or `ceil` on a non-negative rational,
applied exactly once to the base and once to the tax (never per bracket). Use
BigInt/PostgreSQL `numeric` intermediates; bigint IDR results. Illustrative
fixture (arbitrary numbers): `base_fraction_bps = 5000`, brackets
`[{60000000, 500}, {null, 1500}]`, `cumulative_true_up`, `floor`. Gross
1.000.000 with YTD 0 gives base 500.000 and tax 25.000 (net 975.000); a second
gross 130.000.000 gives base 65.000.000, cumulative base 65.500.000,
`T = 3.000.000 + 825.000`, tax this payout `3.825.000 - 25.000 = 3.800.000`.

### W1 — Tax identity onboarding and review

- Phase: S for voluntary capture; D for review, gating and seller identity.
- Actors: payee (affiliate; seller only in D when `pkp_gate_enabled`), reviewer (`tax.identity.review`, D), system.
- Trigger: payee opens the protected form while `identity_capture_enabled`; in D a payout/invoice path reports `tax_identity_missing`.
- Steps: payee chooses class `individual` or `entity`, id kind (`npwp` or `nik`; entities need an NPWP) and enters the value and the registered name; the server runs the syntactic check (digits only, 15 or 16 characters until the advisor confirms rules; UNVERIFIED), seals the value (AES-256-GCM, AAD bound to subject, version and kind), stores a keyed fingerprint for duplicate detection and inserts a new immutable version `submitted`. D: the reviewer sees class, registered name, masked last four characters and a "bank holder name differs" hint; approves or rejects with a reason code; approval supersedes the previous `approved` version in the same transaction. Seller extension (D): `pkp_status` (`unknown`, `pkp`, `non_pkp`), PKP-since date and an opaque evidence reference.
- Data written: `tax_identity` version, `tax_event` per transition; no document image is collected (PRIV-6).
- States: `submitted -> in_review -> approved | rejected`; `approved -> superseded | revoked`; `submitted -> withdrawn`. Class change is a new version, effective for later computations only.
- Failure/replay: client request key unique per subject; sealing key unavailable fails closed with no row; concurrent approval loses on the partial unique `approved` index and returns a recorded `already_approved`; a duplicate fingerprint across subjects flags the review, never auto-rejects.
- Audit: every transition and every reveal (PRIV-9 break-glass) writes `audit_log` with capability, purpose and case.
- Acceptance: S: with the flag OFF the form is absent and no payout depends on it; with it ON a submission needs no review for anything to proceed. D: a payout with required identity and none approved creates no debit; two concurrent approvals leave exactly one `approved`; no DTO, log, export or audit reason contains a full identifier except the break-glass-gated flows.

### W2 — Tax policy management

- Phase: D (S only for an optional owner-confirmed `vat_output` version feeding the PPN toggle).
- Actors: author (`tax.manage`), approver (`tax.approve`), advisor (external; recorded by reference only).
- Trigger: owner/finance needs a rate or rule for a tax type/category, or the advisor reports a change.
- Steps: author drafts a version (tax type, category, `base_fraction_bps`, brackets, `rate_method`, `rounding`, `recognition_event`, deposit/report due days, `effective_from`, source citation, tax label, identity kinds accepted, clawback treatment); submit; approver (a different operator for `commission_withholding`) records `confirmation_basis` (`advisor` with a confirmation reference, or `owner_decision` for `vat_output` in startup mode) and confirms. `effective_from` must be on or after today (Asia/Jakarta); retroactive dates are not supported (use W10). Rollback creates a new version copying the earlier content with a later `effective_from`; nothing is edited or deleted. Retiring sets `effective_to` once.
- Data written: `tax_policy_version`, `tax_event`.
- States: `draft -> submitted -> confirmed | rejected`; `confirmed -> retired`; active is derived.
- Failure/replay: a database exclusion constraint forbids overlapping effective ranges per `(tax_type, category)` among confirmed versions (needs `btree_gist`, a superuser bootstrap like the roles in ADR-0005; if rejected by DBAs, an advisory-locked writer plus constraint trigger gives the same guarantee); content columns are frozen once submitted; confirmation twice is a no-op.
- Audit: author, approver, basis, advisor reference and citation retained; `owner_decision` versions are labelled "not advisor-confirmed" everywhere they are shown.
- Acceptance: overlap insert fails at the database; an edit of a confirmed row fails; a payout computed before a rollback keeps its old `policy_version_id` and amounts; `commission_withholding` cannot be confirmed with `owner_decision`, with author = approver, or without an advisor reference.

### W3 — Commission payout withholding computation

- Phase: S hook (no-op), D computation.
- Actors: affiliate (requests), platform payout service, finance (`affiliate.payout.process`, separate from `tax.*`).
- Trigger: payout request inside the BILL-8 transaction.
- Steps: with the per-affiliate lock held and the effective `tax_setting` read once: if `tax_identity_required_for_payout`, require an `approved` identity matching a policy category, else refuse `tax_identity_missing`; if `withholding_enabled`, run the computation contract, insert one `tax_computation` (`computed`) before the payout row, reserve gross as BILL-8 says, and set payout `gross/tax/net` equal to it (composite foreign key); if off, `tax_idr = 0`, no computation, `tax_setting_version_id` still snapshotted. Partial payouts compute independently on their own gross; year-to-date inputs include earlier non-void payouts. Paid: computation `computed -> recognized` with its tax period and (T-67) one `accrual` ledger entry. Rejected: computation `-> void`, no ledger entry. Processing with unknown outcome: stays `computed`; tax is never recognised on a presumed transfer.
- Reversal/void after withholding: returns before payout never touch tax (withholding happens at payout); a return of a paid portion is flag-only (ADR-0009) and opens a W10 case, never an automatic tax reversal.
- Data written: `tax_computation`, `affiliate_payout` snapshot columns, (T-67) `tax_ledger_entry`.
- States: see ADR-0012 section 7.
- Failure/replay: partial unique `(source_kind, source_id) WHERE kind = 'original'` and the payout request key make replay return the first computation; missing/ineffective policy or identity aborts the whole transaction with no debit; changing a flag or policy afterwards never rewrites a snapshot.
- Audit: computation inputs (including policy parameters and an `inputs_sha256`) are stored in the row; payout decisions already audited under BILL-8.
- Acceptance: with a fixture policy the fixture amounts above are reproduced; two concurrent payout requests are serialized and the second sees the first in its year-to-date; replay yields one computation; with defaults no computation exists and net equals gross.

### W4 — Withheld-tax liability ledger and remittance batches

- Phase: D (T-67).
- Actors: system (accrual), preparer (`tax.remit`), approver (`tax.approve`), accountant (external).
- Trigger: payout paid (accrual); month end or accountant request (remittance).
- Steps: `tax_ledger_entry` is append-only and signed: `accrual` (+, per computation or per VAT invoice), `correction` (signed, references the original), `remittance` (-, once per paid batch), `remittance_reversal` (+), restricted `adjustment`. Outstanding liability per `(tax_type, tax_period)` is `SUM(amount_idr)` over this table only; no balance query joins payouts, orders or invoices (the ADR-0006 inner-join pitfall). A remittance batch is prepared for one `(tax_type, tax_period)`, its amount frozen at approval, must not exceed outstanding minus other open batches (period row locked), and records opaque evidence: `billing_code`, `payment_receipt_number`, `paid_on`, `deposit_account_label`, evidence reference. The platform calls no provider or tax-authority API; the accountant deposits and the operator records the evidence.
- States: batch `draft -> approved -> paid`; `void` before payment; `paid -> void` only through a reversal entry.
- Failure/replay: partial unique indexes (one accrual per source, one `remittance` and one `remittance_reversal` per batch, unique business reference on correction/adjustment); preparer and approver must differ (`approval_request` CHECK); recording paid twice is a no-op.
- Audit: every entry carries actor, reason, source; evidence fields are opaque text, never full account numbers or credentials.
- Acceptance: concurrent accrual events insert one entry; two batches cannot together exceed outstanding; ledger sum equals computations recognized minus remitted for every period (reconciliation R1/R3).

### W5 — Documents: earnings statements (S) and tax evidence (D)

- Phase: S for earnings statements, D for tax evidence.
- Actors: system job (`tax.statement.generate`), `tax.documents.issue` holder, payee, accountant.
- Trigger: month end (statements); payout paid (withholding slip data) in D.
- Steps (S): after each Asia/Jakarta calendar month, for every affiliate with activity or a non-zero balance, build the payload from `affiliate_ledger_entry` rows with `created_at` in the month: credits, payout gross, tax withheld (0 in startup mode, stated), net, reversals, adjustments, opening and closing available balance, pending amount (frozen commissions not yet credited) as information only; no order, buyer or click data. Allocate a number, store the frozen payload and its SHA-256, then render PDF and CSV from the payload on demand. An annual statement (W11) uses the same builder. The affiliate downloads their own; Owner `tax.read` can export any (audited). Correction creates `revision + 1` and marks the earlier `replaced`. The statement says it is not a tax invoice or withholding slip, and tax is the payee's responsibility; wording is OPEN-T10.
- Steps (D): per recognized computation, issue a `withholding_slip` document with fields needed for e-Bupot-style filing (issuer profile, payee class/name/identity reference, tax base, rate label from policy, tax, date, policy version); number from `tax_document_sequence` allocated in the issuing transaction; `official_number` and `filed_on` recorded later by the accountant; payee gets a PDF in their portal (email only if an approved mailer exists, PR-21/Q-16); correction issues a replacement and marks the original `replaced` or `cancelled`.
- Data written: `tax_document`, `tax_document_sequence`; payload immutable, PDF/CSV are renders, not records.
- Failure/replay: partial unique one `issued` document per `(kind, subject, period)` and unique `(kind, number)`; the job replays safely and a repeated run with identical ledger inputs produces the same `payload_sha256` and no new row; a late ledger entry cannot appear in a finished month (entries are inserted with their insertion time), so it shows in the next statement.
- Audit: generation, export, replacement and cancellation audited; exports carry `Cache-Control: no-store`.
- Acceptance: monthly statements sum to the annual statement; a statement equals the ledger by independent query; the CSV and PDF show the same figures; no buyer PII or order identifier appears; a replayed job creates no duplicate.

### W6 — Periodic filing pack and period close

- Phase: D (T-67). Startup equivalent: the invoice-register export and statements only.
- Actors: accountant/finance (`tax.read`), `tax.period.close`, approver (`tax.approve` for reopen).
- Trigger: month end for each tax type with activity.
- Steps: the filing pack for `(tax_type, tax_period, revision)` contains `summary.csv`, `detail.csv` (one row per recognized computation or VAT invoice with document number, payee name, identity kind and value unsealed only for `tax.read` plus the PRIV-9 export purpose, gross, base, tax, date, policy version), `corrections.csv` and `reconciliation.csv`. Deadlines are policy settings (`deposit_due_day`, `report_due_day`, day of the following month, nullable until the advisor confirms); the secondary-source suggestion of the 10th (deposit) and 20th (report) for commission withholding is UNVERIFIED and is never a default. Holiday shifts are OPEN-T14. Mapping to the e-Bupot import format is UNVERIFIED and left to the accountant until a format is confirmed. Reconciliation checks: R1 ledger accruals equal recognized computations plus VAT accruals; R2 issued slips equal recognized computations by count and tax; R3 paid remittances equal ledger `remittance` entries; R4 every paid payout with `withholding_enabled` has a recognized computation; R5 no payout paid without a computation after activation; R6 no open W10 case; R7 revenue lines with no policy are listed as "unclassified" (information, not failure). Close requires R1 to R6 clean, then locks the period (inserts referencing it are rejected by a trigger); later events post to the current open period with `corrects_period_id` information for the accountant. Reopen needs four-eyes approval, a reason and increments `revision` (the accountant files a "pembetulan" if needed).
- Data written: `tax_period`, `tax_export_run` (actor, revision, row count, SHA-256), `tax_event`.
- States: `open -> closed`; `closed -> open` by audited reopen only.
- Failure/replay: exporting a closed period at the same revision is byte-identical (deterministic ordering); `tax.period.open` and `tax.reconcile` jobs are idempotent on `(tax_type, year, month)`.
- Acceptance: close is refused when R1 to R6 fail; a closed period refuses new entries at the database; reopen without a second approver is refused; deadline alerts use the stored policy days and never a constant.

### W7 — Subscription and platform-fee VAT

- Phase: S for the PPN toggle and invoice register; D for VAT documents and credit notes (e-Faktur readiness is the future task T-75).
- Actors: owner/finance (`tax.manage`), invoice creator (BILL-7, one creator), seller, accountant.
- Trigger: invoice creation; PPN toggle change.
- Steps: PPN is OFF by default. Switching it ON (`tax.manage`; confirmation dialog stating that legal and tax documents and PKP status are the Owner's responsibility; reason and audit; no hard PKP gate) requires entering an effective-dated `vat_output` version for the `subscription` revenue line (owner-decision basis, rate entered at that moment, never a constant or code default); no VAT computation exists in startup mode while PPN is OFF. The single invoice creator computes `ppn_idr` from the consideration base (the DPP, the already-decided Rp175.000 per store per month) with the contract above (flat bracket, `base_fraction_bps = 10000` unless the advisor says otherwise), snapshots rate and `tax_policy_version_id`, and never re-derives a stored PPN. The switch affects only NEW invoices. The COD handling fee's VAT (ADR-0006 decision 2) uses the same contract from a `vat_output` version for the `cod_fee` revenue line and is `0` while PPN is OFF or no effective version exists. D (deferred T-75 "PPN activation readiness"): each taxed invoice issues a `vat_invoice` document: e-Faktur data export fields for PKP counterparties (store tax identity via W1 seller extension) and a "document equivalent to a tax invoice" for non-PKP counterparties (UNVERIFIED format); recognition event follows the policy (`invoice_created` or `payment_confirmed`, OPEN-T13). Comp invoices (Rp0, `kind=comp`) issue no tax document. A refunded or voided paid taxed invoice issues a `credit_note` with negative amounts and a `correction` entry; the subscription refund policy itself is OPEN-T17.
- Data written: invoice snapshot columns (DATA-10), `tax_document` (D), `tax_ledger_entry` accrual (D).
- Failure/replay: invoice uniqueness (DATA-10) and one document per invoice by partial unique index; toggling PPN never rewrites an issued invoice.
- Audit: toggle, policy confirmation basis and each export audited.
- Acceptance: with PPN OFF every new invoice has `ppn_idr = 0` and no policy reference is required; with it ON the invoice references one effective policy version and total = DPP + PPN; changing the policy affects only later invoices; a document can be issued once per invoice and credit-noted at most to the original amounts.

### W8 — Other platform revenue lines (tax treatment OPEN)

Not decided here. In startup mode the platform computes no tax on these lines beyond
what DATA-7 and BILL-6 already snapshot. Phase 2 reports them per line as
"unclassified" until a `vat_output` policy for the line, or an advisor note, exists.

| Revenue line | Source field | Open advisor questions (OPEN-T16) |
|---|---|---|
| Platform shipping margin (platform-account shipments only) | `shipment_cost.platform_shipping_margin_idr` (DATA-7; recorded at booking) | Taxable service? supplier and base? |
| Payment-fee margin | `payment_attempt.admin_fee_idr` versus `payment_attempt.provider_fee_idr` (DATA-7; `expected_gateway_fee_idr` is only the checkout estimate) | Taxable? base net of provider cost? |
| COD fee and its VAT component | `cod_fee_idr`, `cod_fee_vat_idr` (snapshotted by DATA-7; the VAT is a policy value, `0` while PPN is OFF or no effective `cod_fee` version exists, ADR-0006) | Whether the platform may charge VAT on this fee at all, and on what base (UNVERIFIED); deferred to T-75 |
| Cashback share | ADR-0007 (mechanism and receipt UNVERIFIED) | Revenue recognition and tax treatment |
| Affiliate platform fee | PR-28 (OPEN, none charged) | Taxable service to the seller or affiliate? effect on commission base |

### W9 — Marketplace collection (retired, not in scope)

The platform is not a designated marketplace collector (ADR-0012 F1: four named operators; Bukalaris not designated). No workflow is built. Revisit only if the authority designates Bukalaris or licensing alignment changes its classification, via a new ADR.

### W10 — Corrections, refunds and disputes

- Phase: S flag-only, D corrections.
- Actors: finance, `tax.documents.issue`, `tax.approve`.
- Trigger: a return, buyer refund, chargeback or fraud finding touching a commission already paid out; a wrong payout status; a refunded taxed invoice.

| Situation | Startup (S) | Phase 2 (D) |
|---|---|---|
| Order refunded or returned before the commission is paid out | Void/reversal per BILL-8; no tax effect | Same: tax arises at payout, so no tax effect |
| Return, refund or chargeback after the commission was paid | Flag-only on the paid portion (ADR-0009) | Opens a case; resolved by the policy's `clawback_treatment`: `manual_review` (default, blocks period close), `no_tax_effect`, or `reduce_base_current_period` (a negative `correction` computation and ledger entry in the current open period, replacement document) |
| Affiliate fraud clawback recovered through an approved wallet `adjustment` | No tax effect | Same treatment as the previous row |
| Payout wrongly marked paid and corrected | Wallet correction per BILL-8 | Reversal entries plus replacement document; closed periods stay closed, the correction posts to the open period |
| Refunded taxed subscription invoice | Not applicable (policy OPEN-T17) | `credit_note` and `correction` entry |

Corrections append rows (`kind = correction`, signed, original referenced); an issued
document is replaced, not edited. Failure/replay: unique `correction_key` per original;
audit as W4. Acceptance: a correction can never exceed the original amounts; replay
creates one correction; the closed period it concerns is untouched.

### W11 — Year-end statements and access reviews

- Phase: S for the annual earnings statement; D for the annual tax statement and reviews.
- Steps: in January the statement job issues the annual earnings statement per affiliate (S) from the same builder, equal to the sum of the twelve monthly statements. D: one `annual_tax_statement` per payee and tax year whose totals equal the issued slips; the cumulative year-to-date inputs of W3 restart at the tax-year boundary defined by the policy. Access review (D): at least quarterly (internal control proposal, owner may change) a reviewer with `tax.read` who is not the reviewed person records, in `tax_event`, the list of holders of `tax.*` capabilities, break-glass reveals and exports in the quarter, open cases and stale `submitted` identities, with a revoke/keep decision per holder.
- Acceptance: annual equals the monthly sum; an access review row exists per quarter; a reveal without a case or reason is impossible.

### W12 — Access control and audit

| Capability | Startup use (S) | Phase 2 use (D) |
|---|---|---|
| `tax.read` | View/export statements, settings, invoice register (masked) | Ledger, computations, documents, filing pack reads |
| `tax.manage` | Edit `tax_setting` flags except activation; switch PPN ON/OFF (confirmation dialog, reason, audit; not four-eyes) and enter the effective-dated `vat_output` rate; draft `vat_output` | Draft policies, edit settings versions |
| `tax.approve` | n/a in startup mode (the PPN switch is not four-eyes) | Confirm policies, approve remittance, reopen, activation (always a different operator than the requester) |
| `tax.remit` | n/a | Prepare and record remittance batches |
| `tax.documents.issue` | Replace a statement revision | Issue, replace, cancel documents and corrections |
| `tax.identity.review` | n/a | Review queue (masked) |
| `tax.period.close` | n/a | Close periods |

Rules: four-eyes uses `approval_request` (DATA-14) with `requested_by <> decided_by`
enforced by CHECK; `payouts.process` and `affiliate.payout.process` never imply a `tax.*` capability and no
`tax.*` capability allows wallet movements; every read/export of identity data is
masked in the data layer before serialization and is audited with capability,
purpose and case; full values only through the PRIV-9 break-glass and the export
service. Tax records may have a statutory retention that overrides erasure
requests; the duration is UNVERIFIED and no value is asserted (PRIV-10, OPEN-T18).
Account closure never cascades into tax or statement records.

### OPEN owner inputs

Platform legal entity type, NPWP and PKP status (OPEN-T1 to T3); tax advisor and
accountant (T4); e-Bupot and e-Faktur access evidence (T5); tax deposit bank
account and billing-code procedure (T6); any expectation of marketplace designation
(T7); when to activate Phase 2 and the notice period (T8); notices and wording
(T9, T10); payer named on evidence (T11); fee-on-commission base (T12); recognition
event (T13); deadline shifts and import format (T14); clawback treatment (T15);
revenue-line treatments (T16); subscription refunds (T17); retention (T18). The
full register is in ADR-0012. Nothing here may be marked decided until supplied.

## Initial commerce implementation handoff

Status: Proposal. Owner: Bukalaris finance owner. Source: PR-4, PR-5, Q-1,
Q-2 and Q-10. Provider capability assumptions require current account evidence.

Keep order, payment and fulfillment states separate. A cart is editable intent;
checkout produces an immutable order snapshot; payment instruction is not
settlement; settlement is not a shipment booking. A shipment tracking event does
not settle prepaid payment. COD has its own confirmation/remittance policy and
must not be forced through prepaid paid-state rules.

| Failure / change | Required outcome |
|---|---|
| Price/stock/quote changes before submit | Requote, explain differences, obtain a valid buyer submission |
| Provider creation times out | Keep stable local reference and pending outcome; reconcile before recreate |
| Duplicate request or callback | Return prior result / apply transition once |
| Shipping booking returns no usable booking reference | Show pending/unbooked; do not claim dispatched |
| Payment settles after cancellation/stock expiry | Quarantine for explicit Q-10 policy; no silent fulfillment |
| Provider reconciliation unavailable | Truthful pending state with bounded retry/escalation |

Initial release does not assume subscriptions, commissions, refunds or payouts
are implemented. Product tax/discount rules, cancellation windows, stock expiry,
COD order confirmation, and late-settlement handling must be resolved before
those paths accept real orders. Schema fields do not authorize financial policy.

Integration skill review: `autolaris-h2h` requires account-specific reconciliation
and distinguishes payment from shipping callbacks. `mengantar-api` contains
historical account/route/sandbox observations that require current provider
verification. This pass does not turn those snapshots into a verified provider
contract, create a sandbox order, or inspect credentials.
