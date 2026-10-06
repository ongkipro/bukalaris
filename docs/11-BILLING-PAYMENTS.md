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

Only a merchant-account-specific settlement policy can move `awaiting_payment`
to `paid`. A shipping callback, tracking status, or generic success phrase is
not settlement proof.

## BILL-3 — Marketplace finance is not Phase 1

- Owner: Bukalaris finance owner

Marketplace commission, seller proceeds, shipping subsidy, gateway fee,
refund, chargeback, COD remittance, payout timing, reserve/hold, tax, and
ledger rules are `Unknown`. A marketplace listing can be built before any of
these are accepted, but marketplace checkout cannot.

## Provider ownership decision

Whether AutoLaris and Mengantar accounts/balances belong to Bukalaris or to
each seller changes fees, support, settlement, compliance, and reconciliation.
Finance owner must accept Q-1/Q-2 with current provider account terms before
implementation. This document makes no legal or payment-service claim.

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
