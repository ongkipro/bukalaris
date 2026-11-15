## ADR-0013: Seller-owned Mengantar and AutoLaris accounts — the seller's money never passes through Bukalaris

- **Status:** Accepted (owner, 2026-11-14, DECISIONS D-27; accepted as a decision, not implementation evidence). Nothing is implemented: the code still runs the platform-managed model of ADR-0006/ADR-0007 on fake adapters.
- **Date:** 2026-11-14
- **Author:** Architecture + finance planning
- **Deciders:** Paduka Ongki (product + finance owner)
- **Supersedes:** [ADR-0006](ADR-0006-net-seller-proceeds-ledger-and-mengantar-reconciliation.md) decision 1 (platform-managed providers and the white-label boundary) and, for stores on seller-owned accounts, its seller ledger, payout, refund and COD-reconciliation decisions; [ADR-0007](ADR-0007-hybrid-mengantar-shipping-accounts.md) decisions 1, 2, 4, 5 and 6 (Partner-provisioned account for every store, Owner-controlled margin and cashback, no seller key); DECISIONS D-14 and D-15 for those stores. The ledger invariants of ADR-0006 stand for any money Bukalaris does hold (subscription invoices, BILL-7).
- **Related:** PR-5, PR-18, PR-19, PR-23, PR-27, BILL-1 to BILL-7, DATA-7, DATA-9, Q-1, Q-2, Q-12, Q-17, OPEN-F3, OPEN-F6 to OPEN-F9, T-34, T-35, T-37, T-39, T-48, T-49, T-61, T-88, T-91, [ADR-0014](ADR-0014-two-registrable-domains-and-custom-domain-target.md), [ADR-0015](ADR-0015-seller-run-store-affiliate-programme.md)
- **Reference system:** AdsBookCMS (`~/Projects/adsbookcms`, branch `local/saratoga-demo`, `9300e1f`, read 2026-11-14). It is a single-store install that already runs on the store's own Mengantar and AutoLaris keys. It is a source of proven rules and of mistakes already paid for, not a template: it stores keys in plain text, accepts any provider base URL and has no tenant boundary, none of which is acceptable here.

## Context

ADR-0006 and ADR-0007 made Bukalaris the holder of every buyer payment and every COD remittance: one platform AutoLaris account, one Mengantar Partner account per store provisioned and sealed by Bukalaris, a seller ledger, payouts, refunds and reconciliation batches. The owner rejected seller-pasted keys on 2026-10-27 for one reason: one ledger for margin, cashback and affiliate commission.

That design carries gates that still block the first real order: the custody review (Q-17), the unverified Partner settlement and cashback sweep (OPEN-F9), free-return terms (OPEN-F7), the reconciliation signal (OPEN-F8), the Partner Secret rotation, a commercial AutoLaris platform account (Q-1), four-eyes payouts and a 72-hour destination hold. None of it is needed when the seller is paid directly.

Owner decision (2026-11-14): the seller connects their own Mengantar account and their own AutoLaris account. Buyer money and COD cash go straight to the seller. Bukalaris is the software, not the cashier.

**Decision drivers:** remove custody of seller money; let a store take real orders without waiting on platform-level provider contracts; reuse behaviour already proven in a running system.

**Non-goals:** marketplace split settlement; Bukalaris-earned shipping margin or cashback; a payment or courier provider other than AutoLaris and Mengantar; multi-warehouse routing.

## Decision

### 1. Account ownership

1. Every store connects **its own Mengantar API key** and **its own AutoLaris H2H API key**. Shipping quotes, bookings and tracking run on the store's Mengantar key; payment instructions and status checks run on the store's AutoLaris key.
2. A new shipping account kind `seller_owned` joins `store_shipping_account`, and a `store_payment_account` holds the AutoLaris connection. Each order snapshots the account it was created under, as today.
3. The platform keeps exactly one use of platform-owned credentials: its own AutoLaris account for **subscription invoices** (PR-18, BILL-7, T-50). Subscription is Bukalaris's revenue; there is no shipping margin, no shipping cashback split and no fee on buyer payments.
4. The `partner_managed` and `platform_master` kinds, the Partner client and the seller ledger stay in the code, unused for `seller_owned` stores. Removing them is reviewed after the pilot (D-31).

### 2. Credential custody (stricter than the reference)

5. A key is **sealed** with AES-256-GCM under a purpose-separated keyring with `key_id` versioning: the existing `shipping_credentials` keyring for Mengantar, a new `payment_credentials` keyring for AutoLaris. A sealed key is opened only inside the server-side provider client, never loaded into a page, a DTO, a log line or an export.
6. Entering, replacing or removing a key needs the store capability `integrations.manage` (owner role) **and a fresh step-up**, writes an audit entry (who, when, which provider, key fingerprint, never the key) and notifies every store owner. The payment key decides where buyer money goes, so it is treated like a payout destination.
7. The form follows the proven rule: an **empty field keeps the stored key; removal is an explicit action**. A stored key is never echoed back; the screen shows only "connected", a masked hint and the last successful check. A key shorter than 24 characters is fully masked; a longer one shows its first and last four characters.
8. A **connection check** runs on save and on demand: Mengantar by a real rate estimate from the store's pickup area, AutoLaris by listing payment channels. A failed check stores nothing new and keeps the previous key.
9. The Mengantar key travels in the URL path of every call. The client strips the raw and URL-encoded key from every error, log entry and trace before it leaves the function.
10. There is **no free-form base URL**. Each account has an `environment` of `sandbox` or `production`, and the platform maps it to a fixed provider origin from server configuration. A seller-supplied URL would let a seller point server-side requests at any host.
11. Sandbox accounts can place and book test orders only; an order created under a sandbox account is marked as a test order and never counts in sales figures or affiliate commission.

### 3. Readiness — a method is offered only when it can complete

12. **Shipping is ready** when the store has a sealed Mengantar key that passed its last check on a new, dedicated account (decision 41), a pickup area and a pickup address registered with Mengantar. Saving the pickup address registers it with Mengantar first; if that fails, nothing changes locally.
13. **QRIS/VA is ready** when the store has a sealed AutoLaris key that passed its last check, the AutoLaris order fields that account needs (origin and destination area ids, shipper e-mail), a sender address, and a recorded confirmation that the account has the provider's payment-only profile. Bukalaris uses AutoLaris as a payment gateway only (shipping runs on Mengantar), and the provider documents that profile as agreed per account, so it is confirmed per store and never assumed ([ADR-0016](ADR-0016-digital-products.md) decision 11). The profile is requested from AutoLaris by hand for each seller, outside Bukalaris; the seller receives the API key from AutoLaris and enters it in Seller Admin (owner, 2026-11-14, D-31). A store that is not ready does not show the method; it is never shown and then failed after the order exists.
14. A store needs one ready payment method to open; a physical product can be activated only when shipping is ready (ties into T-93; digital products in [ADR-0016](ADR-0016-digital-products.md) decision 21).

### 4. Filters — every one enforced on the server at order time

| Filter | Owner | Default | Rule |
|---|---|---|---|
| Courier enabled | Seller, per courier | Off for a courier with no rule row | A quote for a courier the store has not enabled is dropped. An unknown courier is closed, not open |
| Courier COD enabled | Seller, per courier | Off | A COD order only sees couriers with COD enabled |
| Provider says unsupported route | Provider | — | Dropped |
| Provider says COD unsupported on route | Provider | — | Dropped for COD orders |
| Cargo services | Platform | Dropped | Not offered at checkout |
| Missing or zero price | Platform | Dropped | A quote must have a positive price |
| COD-blocked provinces | Seller, list of province codes | Empty until the seller chooses; a suggested list is offered | COD is refused for a blocked province and **when the province cannot be resolved** |
| COD on/off for the store | Seller | On once shipping is ready | Checked at order submit, not only in the method list |
| AutoLaris on/off for the store | Seller | On once payment is ready | Checked at order submit |
| Payment channel excluded | Seller, per channel | None excluded | An excluded channel is refused at order submit |
| Payment channel locked | Platform, Owner console | Channels the provider does not serve | Never offered, cannot be enabled by a seller |
| Courier refuses the seller for COD | Automatic | — | A provider refusal of COD for that seller on that courier turns the courier's COD off for the store and tells the seller; only the seller turns it back on |

The method list a buyer sees and the check at submit use the same function, so a direct request cannot place an order the form would not offer.

### 5. Prices and fees

15. The buyer is charged the provider's **public rate**. The account's discounted rate is the seller's saving and is not shown to the buyer. Bukalaris adds no margin.
16. Order submit **re-quotes**: a changed price or a courier no longer offered is refused with a clear message and the new options; an order is never created at a stale price.
17. Checkout quotes never ask the provider to add its COD fee. The COD fee the buyer sees comes from the store's own fee setting, so the fee cannot be charged twice.
18. Two store settings say who bears a fee: `payment_fee_bearer` and `cod_fee_bearer`, each `buyer` or `seller`, default `buyer`. With `buyer`, the bill is grossed up so the seller nets the full order total; with `seller`, the bill equals the order total. The chosen bearer and the resulting amounts are frozen in `order_financials`.
19. Provider fee rates (payment channel fee, COD fee and its VAT) are **versioned platform settings in the Owner console**, not constants in code. The values seen in the reference system are starting data to verify with each provider, not facts asserted here.
20. Parcel weight is the sum of variant weights (T-61). Volumetric weight stays out until a provider requires it (T-92).

### 6. Payment flow on the seller's account

21. One payment instruction per attempt, created on the store's AutoLaris key with a reference that is unique per attempt. A retry after failure or expiry creates a new attempt and keeps the old one, so a late payment of the old instruction is still recognised.
22. **A callback is evidence, never a state change** (D-21 stands). An order becomes paid only when a status check on the store's key returns the paid code **and** a status word on the allow-list. An unknown status word is recorded and reviewed; it never settles an order.
23. A scheduled check covers pending attempts and attempts that expired in the last 24 hours, newest first, so a backlog cannot starve recent orders.
24. The seller can **confirm a payment by hand** with a reason and evidence. One append-only record per attempt; it cannot be edited or deleted. Four-eyes approval does not apply: it is the seller's own money.
25. A provider error while creating the instruction leaves the order pending with a retry for the buyer; it does not cancel the order.
26. Refunds are made by the seller outside Bukalaris and recorded on the order. Bukalaris calls no refund endpoint.
27. A buyer who pays two instructions of the same order is not detected by the reference system. Here, a second settled attempt on one order raises a payment anomaly for the seller (T-91).

### 7. Shipping flow on the seller's account

28. Checkout and payment never book a parcel. **Booking is a seller action** on the order, choosing drop-off or scheduled pickup.
29. One booking at a time per store; a claimed order cannot be booked twice.
30. A timeout, a dropped connection, a provider 5xx or an unreadable success is an **unknown outcome**: the order is blocked from every further booking attempt until a person has checked the provider and either releases it or links the shipment the provider did accept. It is never retried blindly.
31. A prepaid parcel the provider accepted without a waybill because the seller's courier balance was short is shown as such, with the action the seller must take.
32. COD is allowed on any courier the seller enabled for COD. The return-free restriction of ADR-0006 decision 4 protected a platform ledger and no longer applies: a returned COD parcel is the seller's own cost.

### 8. What no longer applies to a `seller_owned` store

| Platform-managed rule | Status for `seller_owned` |
|---|---|
| Seller ledger `sale`, `cashback`, `shipping_debit`, payouts, payout-destination hold, four-eyes payout approval (ADR-0006, T-37) | Not written, not shown |
| Release only when delivered and reconciled (D-14); reconciliation batches | Not applicable; the seller is paid by their provider |
| Buyer refund paid by the platform (D-20) | Replaced by decision 26 |
| Partner provisioning, routing e-mail, cashback rules, platform margin (ADR-0007, T-48) | Not used |
| White-label names `Bukalaris Kirim` / `Bukalaris Bayar` on seller screens | Seller Admin names Mengantar and AutoLaris, because the seller holds those accounts. Buyer screens show the courier and the payment channel by their own names |
| Custody review Q-17, OPEN-F3, OPEN-F6, OPEN-F7, OPEN-F8, OPEN-F9 as launch gates | No longer gate a `seller_owned` store |
| Partner Secret rotation gate (T-48) | Still gates every call made with **platform** Mengantar credentials. It does not gate a call made with a seller's own key. Owner answer 2026-11-14 (D-31): the exposed secret is not rotated and the owner accepts the exposure; the gate stays in the code and keeps blocking the Partner path |

`order_financials` is still written once per order: it is the record of what the buyer was charged and who bore each fee, and it feeds the seller dashboard and the affiliate commission base.

**Shipping money (owner, 2026-11-15):** everything paid to or received from Mengantar — courier charges, account balance and top-ups, COD remittance, COD fees, return costs, cashback, claims — is between the seller and Mengantar. Bukalaris settles none of it and holds no dispute role. Where the official Mengantar documentation offers the figures, Bukalaris mirrors them read-only as a record for the seller (section 11); the mirror is a copy of Mengantar's data, not a ledger of its own.

**Bukalaris's financial role (owner, 2026-11-15):** a written record of what was transacted on the platform, kept as a backup for the seller. It records each order and its totals, the payment method and status with the evidence behind it, manual confirmations, refunds the seller recorded, and affiliate obligations and payment records. It holds no order money, moves none, and does not reconcile the seller's bank, payment-gateway or aggregator accounts; those records stay the seller's own books.

### 9. Live-call boundary

33. Local development and CI keep fake adapters. A sandbox run is opt-in and uses a test key supplied through `secrets-env`, never a key in a file.
34. Production calls on seller keys are switched on per provider by an Owner console setting, after a recorded sandbox pass for that provider.

### 10. Seller bank transfer (D-31)

35. A store may offer **bank transfer to its own bank account** as a prepaid method. It uses no provider and no platform account. Its method value is `bank_transfer`; the existing `manual_transfer` value keeps meaning a provider channel (QRIS/VA).
36. The seller lists up to five destination accounts (bank, account number, holder name) with `integrations.manage` and a fresh step-up, audited. **Bank transfer is ready** when one account is listed; it counts as a ready prepaid method for decision 14 and for digital products (ADR-0016 decision 21).
37. The buyer is shown the destination accounts and the exact order total on the confirmation and order-status pages and in the order e-mail. The total is not altered by a unique code. **The buyer uploads a proof of transfer** on the signed order-status page (owner, 2026-11-15): up to three images, type checked by content, with a size cap. The page then shows "proof sent, waiting for the seller". Stock is reserved and the order expires unpaid after the store's payment window (default 24 hours), like any prepaid order.
38. The order becomes paid **only by the seller's manual confirmation** (decision 24): finance capability, a reason, one append-only record that links the proof the seller looked at. An uploaded proof never changes the order by itself: it notifies the seller, who compares it with their own bank statement and then confirms or rejects it with a reason; a rejected proof lets the buyer upload again. The seller may confirm without a proof when the money is visible in their bank. Bukalaris checks no bank statement. Everything that follows payment (stock, digital access, booking eligibility, affiliate obligation) runs from that confirmation exactly as from a provider status check.
39. **Proof files are private.** They are stored outside the public media directory, never served by the public media route, readable only by the buyer through the signed order-status page and by the store's finance role, served as a download with a sandboxing content-security policy, and deleted 90 days after the order closes (completed, cancelled or expired; Owner-configurable setting; owner, 2026-11-15, D-33). This is the only buyer upload on the platform. Local disk is the development store; the production store is chosen with the hosting work (T-79).
39a. The filters of section 4 apply: the method can be switched off per store, and the server refuses it at submit when it is not ready.

### 11. Mengantar is mandatory and locked; a dedicated account kept in sync (owner, 2026-11-15)

40. **Mengantar is the only shipping aggregator.** A store that sells physical products must connect a Mengantar account; no other aggregator or direct courier account can be connected, and AutoLaris is never used for shipping. The choice is locked in the platform: no seller setting and no Owner console setting offers another provider. A store that sells only digital products needs no shipping account.
41. **The account must be new and used only by that Bukalaris store.** Every parcel in it is created by Bukalaris, so the order list, statuses and money figures in Mengantar and in Bukalaris describe the same parcels. The connection check reads the account's order list and refuses an account that already holds orders; the seller confirms the account will not be used from another system. A parcel found later in the account that Bukalaris did not create is not imported; it is listed to the seller as a foreign parcel and the store's sync is marked not exact until the seller resolves it.
42. **Status sync covers the whole parcel life.** Bukalaris keeps each parcel's state equal to Mengantar's from creation onward: created, waiting for pickup, pickup failed, picked up, in transit, out for delivery, delivered, returning to sender, returned, cancelled, error. The provider's status history is stored per parcel with its timestamps. A status category Bukalaris does not know is stored as received and shown raw; it never falls into a known state by guess.
43. **Two paths, one writer.** The seller sets Bukalaris's webhook address in their Mengantar settings and enters the Webhook Secret in Seller Admin (sealed like the API key, section 2). A webhook is verified (signature over timestamp and raw body, stale timestamps refused, sandbox marker refused in production) and then only triggers a tracking read on the store's key; the read is the single writer of parcel state. A scheduled read covers every parcel that is not in a final state, because webhook delivery is best effort and missed updates are not resent. Production webhooks are enabled by Mengantar per account, so shipping readiness does not depend on them; the scheduled read alone keeps the state correct, only slower.
44. **What each state does in Bukalaris:** delivered completes a prepaid order, marks a COD order paid (C-P1) and starts the affiliate hold; a return before delivery voids the pending commission; cancel releases the booking. Stock handling on return stays as built (T-39) unless T-115 finds it wrong.
45. **Mengantar money figures are mirrored when the documentation provides them.** The documented balance and invoice list is shown read-only in Seller Admin, and a booking that Mengantar accepted unpaid because the balance was short is shown with the top-up action (decision 31). Per-parcel courier charge, COD amount collected, COD remittance and return charges are mirrored only if the official documentation exposes them; this is UNVERIFIED and is read in T-115, never assumed. Figures are labelled as Mengantar's and carry the time they were read.

## Alternatives considered

- *Keep the platform-managed model (ADR-0006/0007)* — one ledger and platform margin, but every store waits on custody review, Partner settlement terms and a platform AutoLaris contract.
- *Both models side by side, chosen per store* — flexible, but it doubles the test surface of checkout, booking and money, and the owner rejected a two-system split on 2026-10-27 for that reason. Closed by D-31: single mode for the first release.
- *Seller keys with a free-form provider URL, stored as plain text (the reference behaviour)* — fine for a single-store install, unsafe on shared infrastructure.

## Consequences

- **Positive:** no seller money in custody; the first real order no longer depends on Q-17, OPEN-F7/F8/F9 or a platform payment contract; sellers keep their existing courier discounts and payment account; less platform finance code on the critical path.
- **Negative:** Bukalaris earns nothing from shipping or payments; subscription is the only revenue. Each seller must open and maintain two provider accounts, which raises onboarding friction and support load. The delivered T-37 and T-48 work is unused for these stores. Provider-side limits become per-seller problems Bukalaris must explain (for example an AutoLaris IP allow-list: UNVERIFIED for this hosting, to confirm before production).
- **Neutral:** the ledger invariants remain the rule for subscription money. The affiliate programme changes with it ([ADR-0015](ADR-0015-seller-run-store-affiliate-programme.md)).

## Confirmation

- Credential tests: a sealed key never appears in any response body, RSC payload, log, audit row or export (literal scan with a canary key); an empty field keeps the key; removal needs the explicit action; a failed check keeps the previous key; a change without step-up is refused; store A cannot read, use or replace store B's key under the application role.
- An environment test proves no code path builds a provider URL from stored or submitted text.
- One filter table test drives every row of section 4 through the same function used by the method list and by order submit, including the unresolved-province case and a direct submit of a hidden method.
- Money tests: the fee-bearer matrix (`buyer`/`seller` × QRIS/VA/COD) against frozen `order_financials`; no `ledger_entry` row for a `seller_owned` order; stale quote refused.
- Payment tests: callback alone never settles; unknown status word never settles; retry keeps the old attempt and a late payment of it settles; second settled attempt raises an anomaly.
- Booking tests: parallel bookings of one order produce one shipment; an unknown outcome blocks rebooking until released or linked.
- Each money and authorisation invariant above is broken once on purpose and its named test fails (repository mutation rule).

## Owner decisions on the former open items (2026-11-14, D-31)

The owner accepted the recommended defaults on 2026-11-14 (DECISIONS D-31). The IDs are kept so earlier references still resolve. Decided, not implemented.

| ID | Item | Decision |
|---|---|---|
| OPEN-P1 | Single mode or a later platform-held account | `seller_owned` is the only mode in the first release. The platform-managed code (T-37 ledger and payouts, T-48 Partner accounts) stays unused and is not deleted; its removal is reviewed after the pilot |
| OPEN-P2 | Seller bank transfer as a payment method | Accepted: section 10, task T-113 |
| OPEN-P3 | Waiting period after a payment key change | None. Step-up, audit entry and owner notification only |
| OPEN-P4 | Default list of COD-blocked provinces | The reference list (remote eastern provinces and Aceh) is offered as a suggestion the seller confirms; nothing is blocked without the seller's action |
| OPEN-P5 | Per-courier excluded provinces | Not built |
| OPEN-P6 | Per-order platform charge | None; subscription only (decision 3) |
| OPEN-P7 | Sandbox origins for Mengantar and AutoLaris | Not an owner choice. UNVERIFIED until read from each provider's official documentation in T-105 and T-106; no URL is copied from another project |

## Clarifications (2026-11-15, D-32; accepted by the owner)

The document alignment of 2026-11-15 found questions this ADR did not answer. Each row is the smallest answer consistent with the accepted decisions. The owner accepted every row on 2026-11-15 (D-32), with the changes marked in the rows. Decided, not implemented.

| ID | Question | Answer | Owning task |
|---|---|---|---|
| C-P1 | When does a COD order of a `seller_owned` store become paid? | **Decided by the owner 2026-11-15 (principle):** shipping money is a matter between the seller and their aggregator. Bukalaris marks a COD order paid when a tracking read on the store's key reports the parcel delivered, or when the seller marks it collected by hand (decision 24), and that status is information for the seller only. Bukalaris does not track, check or reconcile the COD remittance, the courier balance, return costs or any cashback | T-105, T-107 |
| C-P2 | Does the platform per-service COD policy (`courier_service_policy.cod_allowed`) still filter? | Yes, as a platform ceiling the Owner console can lower; the seller's own COD settings narrow it and never widen it. The dropped `return_free` condition stays dropped (decision 32) | T-105 |
| C-P3 | Mengantar webhooks for a seller's account | **Decided by the owner 2026-11-15:** section 11. A verified webhook triggers a tracking read on the store's key; the read changes the state | T-115 |
| C-P4 | Who owns the per-provider production switch (decision 34)? | T-105 for Mengantar and T-106 for AutoLaris: an Owner console platform setting, audited, off by default, switchable only after the recorded sandbox pass | T-105, T-106 |
| C-P5 | Which seller capability confirms a payment by hand? | The store's finance capability held by the owner role; its identifier is fixed by the first task that uses it. `integrations.manage` for provider keys and bank accounts is owner-role only and cannot be granted to a manager | T-106 |
| C-P6 | Which capability manages courier, COD, province and channel filters? | The capability that manages shipping settings today for courier, COD and province filters; `integrations.manage` for payment channels | T-105, T-106 |
| C-P7 | Order money fields: `shipment_cost`, COD fee VAT, `order_financials.shipping_account_id` | **Decided by the owner 2026-11-15 (principle):** the courier's charge, the COD fee and its tax are settled between the seller and the aggregator. Bukalaris computes the shipping fee and COD fee the buyer sees in the order total (decisions 15 to 19) and stores what the provider returns as information; it books no shipping cost, margin or VAT output of its own. `shipping_account_id` is empty for an order without a physical line | T-107, T-111 |
| C-P8 | AutoLaris request shape: the existing 24-key logistics payload versus the payment-only profile | UNVERIFIED. Read from the official AutoLaris documentation and confirmed with the provider before any call; no payload is assumed | T-106 |
| C-P9 | Refund shown to the buyer | The buyer portal and order-status page show the refund the seller recorded on the order (decision 26). The platform refund flow does not apply | T-107 |
| C-P10 | Records with no named table (account snapshot on the order, test-order marker, manual confirmation, anomaly, bank accounts) | Named and placed by the owning task, each with an isolation-registry entry and a retention class | T-104 (snapshot, test marker), T-106 (confirmation, anomaly), T-113 (bank accounts) |

## Owner decisions of 2026-11-15 on the remaining open points (D-33)

Decided, not implemented.

| Point | Decision |
|---|---|
| AutoLaris IP allow-list | None. AutoLaris is used as a payment gateway only and does not restrict calls by source IP (owner statement, not checked by an agent against the provider's documentation; T-106 records and proves it at the first sandbox call). No egress-IP registration is a launch, restore or deployment step. The callback route rests on the signature and the status check (decision 22), not on a source IP |
| Proof-of-transfer retention | 90 days after the order closes; Owner-configurable (decision 39) |
| Privacy role for buyer data in the seller's provider accounts | Working position: the seller is responsible for its store's buyer data, including the copy in its own Mengantar and AutoLaris accounts, and for its relationship with each provider. Bukalaris sends buyer data only on the seller's instruction with the seller's key and answers for the copy it stores. A redaction in Bukalaris does not reach the provider's copy, and the seller privacy screen and seller terms say so. A privacy adviser confirms this before real buyer data is processed (Q-11) |
| Rate limits for the new actions | Starting values in doc 16 "Rate-limit register additions (D-33)"; Owner-configurable |

## Change history

- 2026-11-14: created from the owner decision of the same day; reference behaviour read from AdsBookCMS.
- 2026-11-14: owner accepted the recommended defaults (D-31). Open-decisions table replaced by decisions; section 10 (seller bank transfer) added.
- 2026-11-15: ten clarifications proposed after the document alignment (D-32, awaiting owner confirmation).
- 2026-11-15: owner decided C-P1 and C-P7 in principle: shipping money is between the seller and the aggregator; statement added at the end of section 8.
- 2026-11-15: owner stated Bukalaris's financial role (a written record of platform transactions, not a money holder or reconciler); statement added at the end of section 8.
- 2026-11-15: owner decided that Mengantar is mandatory and locked, that the account must be new and dedicated, and that parcel states (and Mengantar money figures where documented) are kept in sync; section 11 added, C-P3 decided, shipping-money statement adjusted.
- 2026-11-15: owner accepted the clarification table (D-32) and chose proof upload for bank transfer: the buyer uploads a proof of transfer, stored privately; the seller still confirms by hand (section 10).
- 2026-11-15: owner stated that AutoLaris needs no IP allow-list and accepted the recommendations for proof retention (90 days), the privacy working position and the starting rate limits (D-33).
