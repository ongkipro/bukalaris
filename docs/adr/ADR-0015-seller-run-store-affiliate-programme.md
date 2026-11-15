## ADR-0015: Store affiliate programme run by the seller — platform identity and attribution, seller-paid commission

- **Status:** Accepted (owner, 2026-11-14, DECISIONS D-29; accepted as a decision, not implementation evidence)
- **Date:** 2026-11-14
- **Author:** Architecture + finance planning
- **Deciders:** Paduka Ongki (product + finance owner)
- **Supersedes:** in [ADR-0009](ADR-0009-platform-owned-affiliate-programme.md) the platform-funded parts only: the affiliate wallet, platform payouts, commission deduction from seller proceeds, payout withholding, and platform approval of affiliates as the gate to earn. ADR-0009's affiliate identity, link/code/click capture, attribution rules, self-referral rule and privacy boundaries stand. Also supersedes D-16's premise that every order settles through Bukalaris (its delivered-only rule and 3-day hold stand).
- **Related:** PR-28, PR-29, BILL-8, DATA-11, IAM-13, UX-19, UX-20, D-16, T-52, T-53, T-54, T-55, T-72, [ADR-0013](ADR-0013-seller-owned-shipping-and-payment-accounts.md), [ADR-0014](ADR-0014-two-registrable-domains-and-custom-domain-target.md)

## Context

ADR-0009 pays affiliates from money Bukalaris holds: the commission is deducted from the seller's sale in `order_line_financials`, credited to a platform affiliate wallet after delivery, reconciliation and a hold, and paid out by the platform (T-53). That only works while every order settles through Bukalaris.

[ADR-0013](ADR-0013-seller-owned-shipping-and-payment-accounts.md) moves buyer money to the seller's own payment and courier accounts. Bukalaris then holds nothing it could deduct a commission from. Collecting commission from sellers first (deposit or invoice) and paying it on would make Bukalaris a holder of third-party money again: a wallet, payouts, a custody review and withholding questions, for a feature that is not part of the first release.

What is already built and stays useful (T-52, `packages/db/src/affiliate/**`): platform affiliate identity, links, typed codes, the `GET /r/[token]` click route, one immutable attribution per order with frozen base, rate and commission, the self-referral rule, seller opt-in settings, offers and blocks.

**Non-goals:** cross-store discovery and the affiliate storefront (PR-29), any platform-held affiliate money, tax withholding on commission.

## Decision

1. **One affiliate account on the platform, membership per store.** An affiliate registers once (the existing platform `affiliate` identity) and applies to individual stores. A membership is `pending`, `active`, `rejected` or `suspended` per store. The seller approves, rejects and suspends memberships of their own store. The Owner console can suspend an affiliate account platform-wide for abuse; it does not approve store memberships.

2. **The programme is off until the seller turns it on.** A store enables its programme and sets a default commission rate, with an optional override per product. Rates are basis points on the eligible net-goods base (shipping, tax, gateway fees and platform fees excluded), within Owner-console bounds. A rate change never reprices an existing attribution.

3. **Attribution is unchanged.** A valid typed code wins; otherwise the last eligible click inside the attribution window for that store. One attribution per order, frozen at order creation. A self-referral earns nothing and does not fall through to another affiliate. Only an affiliate with an `active` membership of that store at order time can be attributed.

4. **A commission is an obligation of the seller, not platform money.** It is recorded per attributed order and never enters the seller ledger (`ledger_entry`) or any platform wallet. States:

   | State | Meaning | Set by |
   |---|---|---|
   | `pending` | Order placed, parcel not delivered | order creation |
   | `void` | Order cancelled or returned before delivery | order status writer |
   | `payable` | Delivered and `affiliate_hold_days` passed (default 3, D-16) | scheduled job |
   | `paid` | Seller recorded a payment that covers it | seller |
   | `confirmed` | Affiliate confirmed receipt | affiliate |
   | `disputed` | Affiliate reports it unpaid or short | affiliate |

   A parcel returned after it became `payable` or `paid` is not reversed automatically; the seller records a manual correction against that affiliate's next payment, visible to both sides.

5. **The seller pays outside Bukalaris and records it.** The seller transfers the money by their own means, then records one payment for one affiliate: amount, date, method, the commissions it covers and the **bank transaction data typed by the seller**: paying bank, payer account name, receiving bank and account (masked on display), the bank's transaction reference, and the transfer date and time. No file is uploaded at this step (owner, 2026-11-15); a transaction proof is uploaded only later, inside a complaint or ticket about a disputed payment, a flow that is not built yet. The sum of the covered commissions must equal the amount, apart from recorded corrections. Recording a payment moves no money and calls no provider. A recorded payment cannot be edited; a mistake is fixed by a reversing record.

6. **Both sides read the same statement.** Seller Admin and the affiliate portal show the same per-store figures from the same query: `pending`, `payable`, `paid`, `confirmed`, `disputed`, and the age of the oldest `payable` item. The affiliate sees aggregate outcomes and their own commission lines without buyer name, phone, e-mail, address or order number (PRIV-7 unchanged).

7. **Arrears are visible and have a consequence.** A `payable` commission older than `affiliate_arrears_days` (default 14, Owner-configurable) is in arrears. Arrears show on the affiliate's statement and in an Owner console queue. The Owner console can freeze a store's programme: no new memberships and no new attributions for that store, while existing obligations stay payable. Unfreezing is an Owner console action.

8. **Affiliates are told who pays.** The application screen and the statement state that commission is owed and paid by the seller and that Bukalaris does not hold, guarantee or advance it. The seller accepts the matching terms when enabling the programme. Wording is owner-approved copy, recorded with a version on acceptance.

9. **No withholding, no payout destination custody.** Bukalaris pays no commission, so the T-53 payout tax hook, the 72-hour payout-destination hold (D-19) and four-eyes payout approval do not apply to affiliate commission. The affiliate's bank details, if shown to the seller for payment, are shown only to sellers with an active membership relation and the store's finance capability, and are masked elsewhere.

## Alternatives considered

- *Keep the platform-owned programme of ADR-0009* — affiliates are paid by the platform and can work across stores, but it needs buyer money in Bukalaris's hands, which ADR-0013 removes.
- *Platform collects commission from sellers (deposit or invoice) and pays affiliates* — protects affiliates, but rebuilds the wallet, payouts, custody review and withholding for a non-core feature. Kept as the later path for stores that choose a platform-held gateway, if that mode returns.
- *Separate affiliate account per store* — simplest isolation, but an affiliate working with ten stores needs ten logins, and the later cross-store storefront would need an account merge.

## Consequences

- **Positive:** no affiliate money in custody; no wallet, payout or withholding code for the first release; reuses the delivered T-52 identity and attribution; one affiliate account already fits a later cross-store stage.
- **Negative:** an affiliate's payment depends on the seller; Bukalaris can only make non-payment visible and freeze the programme. The seller does manual transfers and bookkeeping. T-52's deduction of commission from the seller sale must be removed, so `order_line_financials` no longer carries a platform-collected commission.
- **Neutral:** T-53 is superseded in its current form; T-54 is re-scoped to membership, statement and payment record screens; T-55 (affiliate storefront) and cross-store discovery are deferred, not cancelled.

## Confirmation

- Database tests: one obligation per attributed order; `payable` only after delivered plus the hold; `void` on return before delivery; a payment record must sum to its covered commissions; a recorded payment is immutable; the seller ledger balance is identical with and without an attributed order.
- Isolation tests: store A cannot read or change store B's memberships, commissions or payment records; affiliate A cannot read affiliate B's statement; no buyer contact data or order number in any affiliate response.
- Browser tests at 320 px and desktop: apply → seller approves → attributed order → delivered → payable → seller records payment with its bank transaction data → affiliate confirms; a dispute; arrears shown after the configured age; a frozen store attributes nothing.
- A copy test asserts the "paid by the seller" statement on the application screen and the statement page.

## Owner decisions on the former open items (2026-11-14, D-31)

The owner accepted the recommended defaults on 2026-11-14 (DECISIONS D-31). The IDs are kept so earlier references still resolve. Decided, not implemented.

| ID | Item | Decision |
|---|---|---|
| OPEN-A1 | Rate bounds a seller may set | 100 to 5000 bps (1% to 50%), Owner-configurable; replaces the T-52 placeholder of 100 to 2000 |
| OPEN-A2 | Attribution window | 7 days, Owner-configurable |
| OPEN-A3 | Platform fee on commission | None in the first release |
| OPEN-A4 | Affiliate bank details | Stored on the platform, shown only to the paying store's finance role, masked elsewhere |
| OPEN-A5 | Auto-approval of applicants | Off by default; the seller can switch it on per store |

## Clarifications (2026-11-15, D-32; accepted by the owner)

The document alignment of 2026-11-15 found questions this ADR did not answer. Each row is the smallest answer consistent with the accepted decisions. The owner accepted every row on 2026-11-15 (D-32), with the changes marked in the rows. Decided, not implemented.

| ID | Question | Answer | Owning task |
|---|---|---|---|
| C-A1 | Where is the click captured? | On the store host (ADR-0014 C-D1) | T-103, T-108 |
| C-A2 | Decision 5 said "a proof file"; the platform takes no uploads (ADR-0016, ADR-0013 section 10) | **Decided by the owner 2026-11-15:** the seller types the bank transaction data (decision 5); no file is uploaded when a payment is recorded. Uploading a transaction proof belongs to a later complaint or ticket flow and is asked for only when a payment is disputed. That flow is not designed or scheduled | T-109 |
| C-A3 | Is an affiliate account active on registration? | Yes, after e-mail verification. There is no platform application step; earning needs an `active` membership of a store | T-108 |
| C-A4 | What does a seller see when reviewing an application? | Display name, the promotion channels the affiliate lists, and the application note. No e-mail, phone or tax identity. Bank details appear only when a commission is payable (decision 9) | T-108, T-110 |
| C-A5 | Earnings statements and voluntary tax identity (PR-31, ADR-0012, T-65, T-71) | Bukalaris pays no commission, so it issues no affiliate earnings statement and collects no affiliate tax identity in the first release. The shared statement (decision 6) is a record of seller-recorded payments, not a tax document. The affiliate part of PR-31 is deferred | T-109 |
| C-A6 | Existing T-52 tables | `affiliate_seller_policy`, `affiliate_offer` and `affiliate_attribution` are reused; the attribution statuses that describe platform payment (`credited`, `paid_out`) are no longer written. The `affiliate_catalog` projection stays unused while cross-store discovery is deferred | T-108 |
| C-A7 | Change of an affiliate's bank details | Fresh step-up and an audit entry, with a notice to the affiliate's e-mail; no 72-hour hold, because Bukalaris pays nothing | T-109 |
| C-A8 | Owner console freeze and arrears settings | One operator with a recorded reason, audited; not four-eyes, because a freeze moves no money and can be undone. Capability identifiers are defined by the task | T-109 |

## Change history

- 2026-11-14: created from the owner decision of the same day.
- 2026-11-14: owner accepted the recommended defaults (D-31).
- 2026-11-15: eight clarifications proposed (D-32, awaiting owner confirmation).
- 2026-11-15: owner decided C-A2. Decision 5 now asks for typed bank transaction data instead of a proof file; proof upload moves to a later complaint or ticket flow.
- 2026-11-15: owner accepted the clarification table (D-32).
