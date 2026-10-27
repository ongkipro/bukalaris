## ADR-0009: Platform-owned affiliate programme, cross-store discovery, attribution and wallet

- **Status:** Accepted (owner, 2026-10-28, DECISIONS D-20; accepted as a decision, not implementation evidence). **Tax passages amended 2026-10-27 by [ADR-0012](ADR-0012-platform-tax-workflows.md):** the tax identity gate and withholding are policy-controlled and OFF in the startup phase (sections 2, 3 and 7 and the open-decision table below); ADR-0012 is itself Accepted as a decision (owner, 2026-10-28, D-21; not implementation evidence), so the tax passages are accepted on the same basis as the rest of this ADR.
- **Date:** 2026-10-27
- **Author:** Architecture + finance planning
- **Deciders:** Paduka Ongki (product + finance owner)
- **Owner:** Bukalaris product owner with security, finance and privacy owners
- **Related:** ADR-0001, ADR-0002, ADR-0005, ADR-0006, ADR-0007, ADR-0008, ADR-0010, ADR-0012; PR-6, PR-7, PR-28, PR-29; TD-5, TD-7; DATA-7, DATA-11, BILL-3, BILL-4, BILL-8, IAM-3, IAM-13, PRIV-2, PRIV-6, PRIV-7, UX-19, UX-20; T-52 through T-56 (T-8 is superseded by T-57/T-58)

## Context

Owner decision (2026-10-27): Bukalaris runs one platform affiliate programme.
One approved affiliate can promote opted-in products from many Bukalaris seller
stores, operate an affiliate storefront, and receive seller-funded commission
through a platform wallet and payout. This is chain B, built after chain A
(Owner console -> Seller Admin -> Storefront), not functionality already present
in M2. The account and financial domain must not be implemented as another
seller-owned affiliate list.

PR-6/TD-5 already separate discovery projections from seller-owned products;
PR-7/IAM-3/PRIV-2 already reserve affiliate attribution without buyer-data
access. TD-5 and ADR-0002 keep each checkout/order in one seller store.
BILL-3 still gates multi-seller settlement: an affiliate storefront is
cross-store discovery, not permission to introduce a multi-seller cart.
Buyer-account linking/recovery and shared buyer privacy decisions belong to T-57/T-58
(ADR-0010; T-8 is superseded); chain B must not invent a buyer account as an affiliate login shortcut.

Reference review: Tokophi's `specs/AFFILIATE_SPEC.md`,
`packages/lib/src/affiliate.ts`, `apps/admin/lib/affiliate-attribution.ts` and
`packages/db/drizzle/0116_store_affiliates.sql` were read as local, read-only
references. They demonstrate typed-code priority, last-click selection,
self-referral suppression, frozen integer-IDR commission, a unique order
attribution and derived readiness. Its store-owned accounts, merchant-paid
commissions, buyer-account direction and browser-local timestamp authority are
**not** adopted. Tokophi's prose contains historical default differences; no
hold/window/rate default is imported. Shopify comparisons supplied by the owner
are context only, UNVERIFIED against primary provider documentation here.
ADR-0006 supplies the ledger/reversal/locking pattern, not an affiliate schema
or evidence that affiliate money is implemented.

**Decision drivers:** platform ownership across stores; seller-controlled
product participation; no weakening of seller RLS; atomic financial allocation;
database-enforced exactly-once effects; no affiliate access to buyer PII; and
an explicit, policy-controlled tax gate before platform payouts (OFF in the startup phase, ADR-0012).

**Non-goals:** external product connectors, multi-seller cart/split checkout,
multi-level commissions, unrequested buyer discounts, automatic provider payout
integration, or a hard-coded legal/tax conclusion. No connector contract or
provider payout endpoint is specified by this ADR.

## Decision

### 1. Ownership, surfaces and product participation

- Affiliate accounts, storefronts/items, links/codes, clicks, attributions,
  commission obligations, wallet entries, payouts and tax policies are platform
  data. They do not inherit ownership or lifecycle from a seller store.
- Seller products, participation settings, offers and affiliate blocks remain
  seller-owned and store-scoped. Products are closed by default. A seller opts
  each product in, using the store default commission rate or a product override
  in integer basis points. The Owner console sets valid minimum/maximum rates; there
  is no invented initial rate. A seller may block an individual affiliate only
  for its own store. No separate seller approval is required for every affiliate
  on an otherwise open offer.
- The Owner console approves/suspends the platform affiliate account and manages
  platform rate/tax policies. Seller membership grants no platform affiliate
  account, wallet, payout or tax authority.
- Keep one Next.js app and bounded contexts under ADR-0008/TD-7. Proposed portal:
  `affiliate.bukalaris.com`; public affiliate storefront:
  `<handle>.affiliate.bukalaris.com`. DNS/TLS/deployed routing are UNVERIFIED.
  IAM-13 defines a separate affiliate account type, role and login/session
  context; neither buyer identity nor seller membership substitutes for it.
- An affiliate link/storefront hands off to the selected seller's storefront
  and seller-scoped checkout with attribution continuity. The platform-origin
  checkout remains one store per order; items from another seller start a
  different seller checkout, not a hidden split order. Product discovery never
  supplies authoritative stock, price, shipping or payable totals.

### 2. Proposed entities and authoritative fields

Logical records below align with DATA-11; physical migrations remain Proposed.

| Entity | Ownership and minimum contract |
|---|---|
| `affiliate` | Platform identity, authenticated account reference, canonical contact phone, account state, review actor/reason/times; no owning `store_id` |
| `affiliate_seller_policy` | One per store: participation state, default rate in basis points, policy revision; platform bounds are separately versioned |
| `affiliate_offer` | Store/source/product opt-in, state, nullable product rate override, policy revision; unique `(store_id, source, product_id)` binding validated against the actual seller product |
| `affiliate_block` | Seller's block of a platform affiliate, unique store/affiliate, actor/reason/time; not a global affiliate suspension |
| `affiliate_catalog` | Platform read model of public seller fields and active opted-in offers, source identity/revision, availability and rate display; unique `(source, store_id, product_id)` plus unique `(source, offer_id)` for item references, `source='bukalaris'` only in phase 1 |
| `affiliate_storefront` / `affiliate_storefront_item` | Platform affiliate-owned handle, draft/publication state, safe presentation and ordered item references to catalog offers; unique normalized handle in the affiliate namespace, not seller product copies |
| `affiliate_link` / `affiliate_code` | Platform affiliate identity, target store/optional offer or storefront destination, unique public token or globally unique normalized public code, active/revoked/expiry metadata; selectors carry no authentication authority |
| `affiliate_click` | Opaque first-party click id, affiliate/link, target store/offer, server capture/expiry times and minimal continuity reference; no buyer identity, raw referrer URL or default browser fingerprint |
| `affiliate_attribution` | One commission obligation per order (for every opted-in order, prepaid and COD alike, because all orders settle through the one Bukalaris-managed shipping and money system, D-15 / D-16; no order is excluded by payment method or shipping account): `UNIQUE(order_id)`, same-store order binding, affiliate, `source='bukalaris'`, selected method (`code`/`link`), optional click evidence, policy/window snapshots (including `affiliate_hold_days`), commission base/amount, rate snapshots, state (`pending`, `credited`, `paid_out`, `void`), `eligible_at` and credit reference |
| `order_financials` affiliate fields | Immutable `affiliate_commission_idr`, affiliate/attribution reference, commission base and per-line rate/base snapshot, seller deduction and effective policy versions; written with the order, never reconstructed from current offers |
| `affiliate_ledger_entry` | Signed integer-IDR entry, affiliate, optional attribution/payout reference, kind, status, original-entry reference and audit metadata; immutable amount/identity and append-only reversal |
| `affiliate_payout` / `affiliate_payout_allocation` | Affiliate, gross reserved amount, immutable bank/tax-policy/withholding/net snapshot, unique request key, state, `approval_request_id` (set by the four-eyes approve-for-transfer step), actor/times and transfer evidence; allocations identify the gross commission portions reserved/paid, including partial payouts |
| `affiliate_payout_destination` | Affiliate-owned bank destination: protected account reference, account-holder name, `holder_name_check`, `hold_until`, step-up reference, previous-contact notification time, `active`/`held`/`superseded` state; payouts reference one `active` destination and snapshot it (DATA-11) |
| Tax identity, tax policy, tax settings and computation | Not entities of this ADR: `tax_identity` (affiliate subject), `tax_policy_version`, `tax_setting` and `tax_computation` are defined once in DATA-15 and replace the earlier `affiliate_tax_identity` and `tax_policy` rows; startup mode needs none of them for a payout; no hard-coded statutory rates |

The outbox projects seller opt-in, product publication/price/availability,
rate changes and removal into `affiliate_catalog`, idempotently by source
revision. Consumers use explicit store context; the projection is not a global
seller-table bypass. Revoked/unpublished offers are removed or tombstoned, and
stale or reordered events cannot republish a newer revocation. Storefront items
retain their references but unavailable offers cannot be purchased or attributed.
At checkout the commerce service rechecks current seller policy, product,
account, block and rate bounds; a stale projection cannot authorize commission.

`source` identifies product origin, never attribution method. It carries only
`bukalaris` today, including the product identity used by offers/storefront items.
T-56 is deferred; no external credentials, synchronization or checkout adapter
is implied by reserving that column.

### 3. State machines and one-writer rule

| Aggregate | Proposed transitions and invariants |
|---|---|
| Affiliate account | `pending -> active` or `pending -> rejected`; `active -> suspended`; `suspended -> active` or `suspended -> closed`; `rejected -> pending` only on explicit resubmission; `active -> closed` on authorized closure. Reviews/reactivation are audited Owner console actions. Closed is terminal. Only active accounts create new promotional links/storefront publications or receive new attribution; suspension never deletes earned money. Processing existing obligations follows finance controls, not an automatic confiscation. |
| Seller offer | Absent/default is closed; explicit opt-in creates `active`, seller pause gives `active -> paused`, and opt-out gives `active -> withdrawn` or `paused -> withdrawn`. Re-opt-in/resume requires renewed eligibility and rate validation. Product publication/store/policy status additionally gates effective availability; a projection is never the state writer. |
| Affiliate storefront | `draft -> published -> unpublished`, with explicit republish; publication requires active account and valid public items. Unavailable items are not a reason to fabricate a current offer. |
| Attribution/commission | `pending -> credited` only for a DELIVERED order whose seller sale is released (reconciled where applicable) and after `affiliate_hold_days`; `pending -> void` on an in-transit return, refused COD or cancellation before delivery, without ever being credited (a state change, no wallet entry); `credited -> paid_out` once its full gross amount is paid. Partial paid amounts are tracked by allocations. There is no automatic post-delivery return effect: a late claim after credit or payout is an explicit finance case and a four-eyes `adjustment`. No `unfunded` state exists: every opted-in COD order creates an attribution like a prepaid order (section 5, D-16). |
| Payout | `requested -> processing`, then `processing -> paid` or `processing -> rejected`; `requested -> rejected` also allowed. **`requested -> processing` is "approve for transfer", the four-eyes step** (`approval_request`, action `affiliate_payout.approve_transfer`, capability `affiliate.payout.process`; the payload hash binds payout id, gross, tax, net and the bank snapshot shown to the approver; stored as `approval_request_id`). `processing -> paid` only records transfer evidence (no second approval). Request reserves/debits once; rejection reverses once; paid is terminal and marking paid creates no second wallet debit. Unknown transfer outcome stays processing for reconciliation, not a presumed rejection/retry. |
| Tax policy | Moved to ADR-0012/DATA-15: `draft -> submitted -> confirmed` or `rejected`, `confirmed -> retired`; activation of withholding requires advisor confirmation and an applicable effective range. A used version is immutable; correction creates a new version, never rewrites a payout snapshot. Not applied in the startup phase. |

Each aggregate has one authoritative transition service; operator actions,
checkout, callbacks and jobs invoke it, never write competing status logic.
Same-state events are no-ops; rejected/stale transitions return a recorded
outcome rather than silently report success. The order-status service from
ADR-0006 remains the only order-status writer and calls commission effects in
its transaction. Its forward delivery jumps must produce the same commission
effect as the full intermediate sequence; `completed -> returned` is illegal, so
there is no post-delivery commission reversal.

### 4. Attribution algorithm and first-party continuity

1. Resolve the destination seller and cart on the server using existing checkout
   authority. Codes, query parameters and click ids are selectors only. Normalize
   code syntax and canonical phone values once; a client-supplied affiliate,
   store, rate or timestamp is not trusted.
2. On an eligible public link visit, create a server-timestamped opaque click
   record bound to the affiliate, link and target seller/offer. Use first-party
   continuity on the current origin. Cross-origin seller/custom-domain and
   platform checkout handoff use the validated checkout handoff contract to
   carry the reference; no shared parent-domain admin cookie, buyer identifier
   or portal session is sent. A replayed or edited reference cannot change its
   recorded actor, capture time or destination seller. Concrete browser storage
   and notice/consent policy must be approved under PRIV-5/PRIV-7 before launch.
3. In the checkout transaction, first resolve a valid explicit code to an active
   affiliate permitted for this seller. It wins over captured links. If the
   explicit code is unknown, malformed, expired, revoked, blocked or otherwise
   ineligible, try the most recent eligible server-captured click for that
   destination seller within the approved attribution window. Use server time,
   with a deterministic click-id tie-breaker for equal capture times. No eligible
   candidate means no attribution, not checkout failure.
4. Compare the chosen affiliate's canonical phone to the buyer's canonical phone
   server-side. A match silently suppresses all commission for this order;
   do not fall back to another affiliate or reject the order. This is a minimum
   guard, not proof that all fraud is detected.
5. Revalidate current product opt-in, seller block, account state and rate bounds.
   Compute commission only for eligible lines; non-opted-in lines earn zero.
   Attribute at most one affiliate per seller order, even when several eligible
   products/rates are present. Persist the immutable attribution and financial
   allocation in the same transaction as the order.
6. Enforce `UNIQUE(order_id)` in the database and use the checkout's existing
   idempotency identity. Concurrent/replayed checkout cannot overwrite the first
   frozen affiliate or create a second commission. Aborted order transactions
   leave neither attribution nor deduction behind.

The attribution-window length is OPEN. It is checked server-side against
persisted capture time, not a browser-provided age. Invalid/expired referral
input is an expected no-commission outcome; it never fails an otherwise valid
order. Infrastructure or financial-integrity errors are not disguised as a bad
code: the order transaction remains atomic and uses the existing failure policy.
Guest checkout and existing privacy-reviewed buyer recovery remain unchanged.

### 5. Commission freeze, seller deduction and eligible orders

- The base is net goods value after store-funded goods discounts, excluding
  shipping, gateway fees, platform fees and goods tax. Per line,
  `commission_base_i = net_goods_i - included_tax_i`, where `net_goods_i` (the
  line gross after the largest-remainder discount allocation) and `included_tax_i`
  come from the single per-line allocation defined in BILL-4 and frozen in
  `order_line_financials` (DATA-7); added tax is never in the base. Snapshot each
  applied line rate (product override, else store default), base and policy
  revision; use exact integer arithmetic and floor the summed basis-point
  calculation once to integer IDR, `affiliate_commission_idr =
  floor(sum(commission_base_i * rate_bps_i / 10000))` (named rounding: floor
  once), as in the reviewed Tokophi pure calculation. Mixed-rate, zero-base and
  discount-boundary examples are acceptance fixtures, not current production
  evidence.
- In the order transaction, freeze `affiliate_commission_idr` and the rate/base
  snapshots in `order_financials` plus the unique attribution. Seller entitlement
  is the BILL-4/BILL-6 entitlement **minus** this commission, only from goods
  proceeds; the shipping entries of BILL-6 are unchanged. A rate
  edit, block, deactivation or catalog refresh never reprices an existing order.
- The platform holds the withheld commission as an affiliate obligation, not
  platform revenue or seller-withdrawable cash. Attribution at checkout is not
  a wallet credit or proof of collection. Platform-managed prepaid/COD flows
  must first establish collected/held funds under the accepted payment/custody
  rules. No sale/commission credit is created for an already terminal order;
  a late payment follows ADR-0006's quarantine/refund policy.
- **All opted-in seller orders (prepaid and COD) are commission-eligible (owner
  decision 2026-10-27, D-15 / D-16):** Because Bukalaris manages 100% of
  shipping and payments under one unified system (AutoLaris for prepaid and
  Bukalaris-provisioned Partner Mengantar accounts / platform master account for
  shipping and COD, ADR-0007), every opted-in seller order settles through
  Bukalaris and is eligible for affiliate commission. There is no separate
  seller-account COD exclusion (the interim "System A / System B" split is superseded) and no `unfunded` state.

### 6. Release, append-only wallet and return parity

- Eligibility (owner decision, closes OPEN-A1): a commission can become eligible
  only for an order that was DELIVERED (`completed`) and, for platform-account COD,
  whose seller `sale` has been released by reconciliation (ADR-0006); a prepaid
  order qualifies at delivery. `eligible_at` is set once, at the later of those
  two events, to that instant plus the snapshotted `affiliate_hold_days`
  (decided default: **3 days**, Owner-configurable in the Owner console;
  reference points: Tokophi 3, 99ribu 10, Shopify 30).
  `shipped` never releases commission. Readiness is derived from a non-void
  obligation with `eligible_at <= now()`, never a stored `ready_to_pay` status or
  an automatically mutable balance counter.
- Only after that gate does the release worker insert one available
  `commission_credit` in `affiliate_ledger_entry` and transition the attribution
  to credited atomically. Before release, pending obligations are reported from
  attribution, outside the wallet. Duplicate jobs/delivery events cannot move
  `eligible_at` forward or credit twice.
- Ledger kinds: `commission_credit` (positive released gross commission),
  `payout` (negative gross reservation at payout request), `payout_reversal`
  (exact opposing release on rejection), and restricted `adjustment` (audited
  four-eyes finance correction with a unique immutable business reason/reference,
  never an unapproved claw-back or mutation of the original financial snapshot).
  There is no automatic `commission_void` entry: a void happens only on the
  attribution, before any credit.
  Amount, owner and references are immutable. Balances derive from signed
  entries by status; the pending/available status vocabulary and any controlled
  status transition follow ADR-0006. Normal affiliate credit starts available
  only after the hold, never as an early pending wallet credit.
- Database partial unique indexes enforce one `commission_credit` per
  `(affiliate_id, attribution_id)`, and one `payout` and one `payout_reversal`
  per `(affiliate_id, payout_id)` by kind. Writers use conflict-safe inserts;
  database uniqueness, not a read-before-insert check, prevents duplicate
  effects. Adjustment uses a unique business reference.
- Return or cancellation, possible only before delivery, voids the attribution
  and prohibits release; it creates no wallet entry because nothing was credited.
  Immutable commission, allocation and ledger amounts must reconcile exactly.
- Credit and payout reservation take the same per-affiliate payout lock,
  `pg_advisory_xact_lock(hashtext('bukalaris.payout.affiliate'), hashtext(affiliate_id::text))`
  (two-key form: its own namespace, so it can never collide with the store lock),
  and a consistent row-lock order. ADR-0006 decision 4 fixes the global order: order
  row, then the store payout lock, then ledger rows, then this affiliate lock; no
  provider call is made while a lock or transaction is open. A processing payout
  is an unknown transfer obligation: freeze further allocation changes until
  finance confirms paid or rejected. No presumed refund, duplicate transfer or
  automatic claw-back.
- Post-delivery returns are out of scope in M3 (ADR-0006): no automatic wallet
  effect. A late claim after credit or payout is an explicit finance case resolved
  by a four-eyes `adjustment`, never silently debited from a later payout. The
  prepaid seller sale reversal (in transit), the attribution void and the buyer
  refund reconcile in the order finance transaction so the same funds are never
  restored twice.
- **Closed (owner decision D3, former OPEN-A1):** commission exists only for
  delivered orders, as stated above; who would bear a paid-out commission on a
  post-delivery return no longer arises in M3.
- Wallet sums never inner-join orders: payout entries have no order reference.
  Read-only reconciliation compares gross obligations, credits, payout
  allocations, withholding and net transfers per affiliate/store, without
  exposing buyer identity in the affiliate result.

### 7. Payout, policy-controlled tax and identity gate (amended by ADR-0012)

- An authenticated affiliate, after a step-up (fresh proof, IAM-13), requests
  only its own available balance. In one transaction, acquire the affiliate
  payout lock (section 6 form and lock order), re-read the signed balance,
  validate that the payout destination is `active` (destination controls below)
  and, only when `tax_identity_required_for_payout` is ON, an applicable
  reviewed tax identity; and, only when `withholding_enabled` is ON, an effective
  confirmed `tax_policy_version`; allocate unreserved commission portions,
  snapshot the payout (guarded by its unique request key) and insert its
  negative gross `payout` entry. Concurrent requests cannot reserve the same
  money. Minimum payout and transfer mechanism require finance-owner
  acceptance; no minimum amount or provider endpoint is invented here.
- **Payout-destination controls (anti-fraud, not tax or KYC; decided mandatory
  by owner decision D5 / D-19):** these apply to all affiliate payouts from
  Bukalaris. Creating or changing a destination needs a step-up
  and notifies the previous verified contact; a new or changed destination is
  `held` for **72 hours** (`hold_until`, default 72 hours, Owner-configurable)
  and payouts use only an `active` destination whose hold has elapsed; the
  account-holder name is compared with the affiliate's registered name and the
  result is stored; a `mismatch` is shown on the approval request and
  acknowledged in its payload.
- After an account recovery or MFA reset (IAM-13), a bank-destination change and
  a payout request are held for the same **72-hour** period (Owner-configurable).
- **Tax defaults (startup phase): nothing is withheld and no tax identity is
  required.** Affiliates are responsible for tax on their own commission and
  receive earnings statements (BILL-9 W5); a payout carries `tax_idr = 0` and
  `net = gross`. The earlier owner wording in this section, "NPWP/KTP tax identity
  is required before the first payout" with the platform as withholding agent, is
  superseded for the startup phase and is the Phase 2 behaviour that the platform
  owner activates (recorded and approved with `tax.approve`) under ADR-0012
  section 5. When activated: snapshot gross commission,
  taxable base, applicable policy and identity category/version, calculation
  inputs, withheld integer IDR and net transfer in one immutable
  `tax_computation`; `gross = withholding + net`; tax is not deducted a second
  time from the wallet; the withholding liability is recorded separately from
  the affiliate net transfer in the tax ledger (BILL-9 W4).
- Owner console finance processes requested payouts with explicit capability,
  audit and transfer evidence. `requested -> processing` is "approve for
  transfer": a four-eyes `approval_request` (section 3) shows the approver the
  immutable bank snapshot, and the manual transfer is made only after approval.
  **Operator claim lease & non-reusable transfer evidence (99ribu precedent):**
  an operator executing a `processing` affiliate payout acquires an exclusive
  **30-minute claim lease** (`claimed_by_user_id`, `claim_expires_at = now() + 30 min`,
  409 `PAYOUT_ALREADY_CLAIMED`) after a single-use step-up reauthentication proof.
  Marking `paid` requires a cross-payout unique bank `transfer_evidence_ref`
  (409 `DUPLICATE_BANK_TRANSFER_REFERENCE`) and a non-reusable transfer receipt
  artifact ($\le 10\text{ MB}$, magic-byte sniffed PNG/JPEG/WebP/PDF, SHA-256
  digest checked across payouts with 422 `EVIDENCE_REUSE_FORBIDDEN`): it is
  bookkeeping after the verified transfer (platform absorbs bank transfer fees),
  not a provider API call, not another wallet debit and not a second approval.
  Rejection adds one exact opposing `payout_reversal`; bank/policy edits never
  mutate the original snapshot. Unknown transfer outcomes remain `processing`
  and cannot cause blind retransfer or reversal.
- Rates, legal classifications, thresholds, proof-of-withholding and remittance
  procedures are UNVERIFIED until primary-regulation/advisor confirmation.
  Secondary summaries of individual PPh 21/entity PPh 23 at about 2% are not an
  accepted rate table. PRIV-6 and PRIV-10 govern identity handling and retention.

### 8. Authorization, fraud guards and reporting

- Seller RLS remains intact for policies, offers, blocks, products and orders.
  Platform affiliate tables have platform ownership and affiliate-id-scoped
  access, with restricted operation-specific writers. Cross-store affiliate
  discovery reads only `affiliate_catalog`; reporting reads a platform-owned
  aggregate model, not arbitrary cross-store orders through a bypass role.
  Outbox/service tasks carry explicit source store, operation and audited actor.
- Enforce separate affiliate login/account context (IAM-13), server ownership
  checks and deny-by-default capabilities on profile, storefront, link, wallet,
  tax and payout mutations. Seller A cannot inspect/change seller B's policies
  or funding; affiliate A cannot inspect/change affiliate B's private data.
  Public offers are intentionally cross-store, private seller data is not.
- Use server rate limits for application, link/click capture, code resolution
  and payout operations under existing abuse-control patterns; bounded inputs,
  cryptographically opaque click references, server timestamps, target binding,
  uniqueness and canonical-phone self-referral guard are mandatory. Click volume
  alone is never a payable commission. Do not add fingerprinting, arbitrary
  off-site redirects, click stuffing or client-selected commission rates.
- Recheck account/offer/block eligibility on checkout rather than trusting a
  cached public item. A seller block or platform suspension stops future earning
  but does not delete historical obligations. Tax/bank/payout policy changes and
  manual finance corrections require restricted grants and audit records.
- Affiliate reports expose own aggregate clicks/outcomes/commission amounts and
  own wallet/payout history only. No buyer name, phone, email, address, payment
  details, order id/number, raw click log or individual buyer order is returned
  in HTML, RSC, JSON or exports. Seller funding views stay store-scoped.
  Bank/phone masking is applied in the data layer before serialization, not in
  UI components. Small-count/grouping safeguards require privacy-owner approval
  under PRIV-2; tax identity stays outside ordinary projections entirely.
- **Suspension effect:** suspending an affiliate unpublishes the public
  storefront (it answers not-found, AF-08), deactivates its links and codes (a
  deactivated link redirects without capturing a click; a deactivated code
  resolves as unknown and checkout continues), and stops new attribution. It
  never touches earned or paid money. Reactivation restores the last published
  storefront revision and the links that were active at suspension.
- **Click capture (entry point HTTP-27 `GET /r/[token]` on the apex host, ARCH-5; 12-SECURITY SEC-20):** a click is captured only on a GET
  top-level navigation (`Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest:
  document`, no prefetch). HEAD, subresource requests and requests missing the
  Sec-Fetch headers redirect without capturing. The continuity cookie is
  `__Host-bl_click` (Secure, HttpOnly, SameSite=Lax, no Domain), and the redirect
  target is never client-supplied (no open redirect). Click and code resolution
  have rate rows RL-CLICK and RL-CODE in 16-OBSERVABILITY-RATE-LIMITING.
- Raw click retention is finite and separately approved under PRIV-7. No default
  raw IP/UA/full URL/fingerprint is stored. Expiry deletes/anonymizes tracking
  and detaches raw click references without deleting immutable financial
  evidence or earned commission. Backup/restore and legal holds follow PRIV-4;
  account closure never cascades into wallet/payout deletion.

## Alternatives considered

- **Seller-owned affiliate programme copied from Tokophi:** simpler merchant
  workflow, but rejected for this product because one affiliate would need many
  seller accounts and disconnected balances, with seller ownership of platform
  identities and no unified withholding or payout boundary.
- **Platform account with direct cross-store seller-table reads:** fewer
  projections, but rejected because it turns affiliate discovery/reporting into
  an RLS bypass and risks buyer/order disclosure. Outbox projections deliberately
  accept staleness, with authoritative revalidation at checkout.
- **Mutable affiliate balance or application-only deduplication:** simpler
  initial writes, but rejected because retries/races can double-credit or
  overspend, and corrections cannot be audited. Use signed append-only entries,
  partial unique indexes and transaction locking from ADR-0006.
- **Multi-seller affiliate checkout now:** unified cart presentation, but rejected
  for chain B because split money/refund/tax responsibilities remain BILL-3
  scope. Keep seller checkout handoff until that finance decision is accepted.

## Consequences

- **Positive:** a single affiliate identity promotes many stores without eroding
  seller ownership; one immutable commission per order; auditable funded wallet,
  tax snapshot and payout; no affiliate buyer-PII entitlement.
- **Negative:** new platform read models, bounded financial writers, tax/privacy
  review and cross-origin continuity are required. Asynchronous catalog data
  needs authoritative revalidation. Returns racing payouts require allocation
  and reconciliation rather than a naive state update.
- **Neutral:** phase 1 products come only from Bukalaris sellers. Reserving
  `source='bukalaris'` does not implement a connector. Platform subscription
  invoices and seller proceeds remain separate from affiliate wallet/payout
  data. All sections are accepted as decisions (D-20) but none is implementation evidence; each requires task-level acceptance/evidence.

## Confirmation

T-52 through T-55 define independently executable slices and future evidence,
not checks already run. Use Vitest policy/unit coverage and real-PostgreSQL
integration coverage for uniqueness, RLS, row/advisory locks, transaction
rollback, release/return parity, partial payout and withholding. Use Playwright
for separate affiliate context, seller opt-in and blocks, Owner console review,
no-PII serialized/report views, first-party seller/custom-domain handoff and
single-store checkout. Tests must prove same-context success as well as
cross-store/cross-affiliate denial, concurrent double-attribution impossibility,
no commission credit before delivery or release and no duplicate payout/reversal. A clock-controlled
retention test must preserve financial reconciliation after click removal.
No build, test, sandbox call or production write was performed for this ADR.

## Open decisions and entry gates

| OPEN item | Owner / gate |
|---|---|
| Attribution-window length and prospective policy-change behavior | Product + privacy owners before T-52 production attribution; reference 30-day windows are not an accepted default |
| `affiliate_hold_days`: prospective changes to the hold duration | Decided default is **3 days** after delivery and seller-sale release (Owner-configurable in `SA-12` under `affiliate.policy.manage`, four-eyes `affiliate.rate_bounds`) |
| Any platform fee on affiliate commission | Product + finance owners before money schema/payout acceptance; do not silently choose zero or invent a fee |
| Payout minimum and transfer method | Finance owner before T-53 live payout; no provider contract assumed |
| Tax mode activation: withholding, identity gate, policy applicability, rates, bases, rounding, effective dates, evidence, reporting and liability operations | Owner activation under ADR-0012 section 5 with advisor confirmation; startup default is OFF; secondary summaries remain UNVERIFIED |
| Click/aggregate/identity/financial retention, legal basis, notice/consent and small-count disclosure controls | Privacy/legal/tax owners before relevant production data collection/disclosure; no indefinite tracking retention |
| Concrete first-party storage and validated cross-origin referral handoff | Security/privacy owners before T-52/T-55 release; must preserve existing checkout session authority |
| Multi-seller cart and split checkout | Deferred until BILL-3 closure and a separate accepted finance/checkout contract |
| External products (Shopify, Etalashop/Tokophi or others) | Deferred T-56; accepted source/ownership/consent, connector contract, RLS/read-model boundary and checkout/funding/tax policy are entry criteria, not a specified integration |

## More information

- [ADR-0006 — Seller proceeds ledger and reconciliation](ADR-0006-net-seller-proceeds-ledger-and-mengantar-reconciliation.md)
- [ADR-0007 — Platform-managed Mengantar Partner seller provisioning and cashback ledger](ADR-0007-hybrid-mengantar-shipping-accounts.md)
- [DATA-11 — Platform-owned affiliate domain](05-DATA-MODEL.md#data-11--platform-owned-affiliate-domain)
- [IAM-3 and IAM-13 — Affiliate policy and capabilities](07-IAM-RBAC-ABAC.md#iam-3--marketplace-and-affiliate-policy)
- [PRIV-2, PRIV-6 and PRIV-7 — Reporting, tax identity and click retention](13-COMPLIANCE-PRIVACY.md#priv-2--buyer-and-affiliate-boundary)

## Change history

- 2026-10-27 documentation audit pass: audit FIN-15 (per-line allocation by reference to BILL-4), FIN-16 (two-key lock, lock order), FIN-17 and SPV-05 (four-eyes on approve-for-transfer), SPV-04 (destination controls), TRC-5 and TRC-18 wording applied here. Owner decisions of the same day: unified Bukalaris-managed shipping so all opted-in prepaid and COD orders are commission-eligible, commission only for delivered orders after the seller sale is released plus `affiliate_hold_days = 3` (decided default), no `unfunded` or `commission_void` state, and mandatory 72-hour bank-destination hold (D-19).
