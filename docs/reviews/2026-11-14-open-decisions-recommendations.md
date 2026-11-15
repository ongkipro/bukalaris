# Open owner decisions after the 2026-11-14 direction change — recommendations

- **Date:** 2026-11-14
- **Status:** Accepted in full by the owner on 2026-11-14 and recorded as [D-31](../DECISIONS.md). The decisions live in each ADR's "Owner decisions on the former open items" table; this file is the dated record of what was proposed and is not maintained further. The owner actions in section 4 are accepted and not done.
- **Scope:** [ADR-0013](../adr/ADR-0013-seller-owned-shipping-and-payment-accounts.md), [ADR-0014](../adr/ADR-0014-two-registrable-domains-and-custom-domain-target.md), [ADR-0015](../adr/ADR-0015-seller-run-store-affiliate-programme.md), [ADR-0016](../adr/ADR-0016-digital-products.md) (D-27 to D-30).

## How to answer

Answered: all accepted. Bank transfer (OPEN-P2) became ADR-0013 section 10 and task T-113.

## 1. Decide first (they block the next tasks)

| ID | Question | Recommendation | Why | Needed before |
|---|---|---|---|---|
| OPEN-P2 | Add manual bank transfer to the seller's own bank account as a payment method? | Yes. | It needs no provider, so a store has a prepaid method on day one, before its AutoLaris account is approved. A digital-only store can open with it. It needs its own method value: the existing `manual_transfer` value means a provider channel (QRIS/VA). | T-104, T-106, T-111 |
| OPEN-P1 | Is the seller-owned account the only mode? | Yes, for the first release. Leave the platform-managed code unused; decide its removal after the pilot. | Two money models at once double the tests and the support cases. | T-104 |
| OPEN-D3 | Register `bukalaris.id` and create its DNS zone. | Register now; create no records yet. | The name is the base of every storefront address and of `cname.bukalaris.id`. Losing it changes ADR-0014. | Any deployment; not needed for local work |
| OPEN-D2 | May a seller use an apex custom domain (`tokosaya.com`)? | Subdomain only (`www.`, `shop.`) until T-15 proves apex support at the provider. | A CNAME on an apex is not valid DNS; it works only with provider-specific flattening. | T-15 |
| OPEN-A1 | Commission rate bounds a seller may set | 100 to 5000 bps (1% to 50%), Owner-configurable. | Digital products carry high margins; a 20% ceiling is too low for them. | T-108 |

## 2. Accept as defaults (low cost to change later)

| ID | Question | Recommendation |
|---|---|---|
| OPEN-P3 | Waiting period after a payment key change | None. Step-up sign-in, audit record and owner notification only. |
| OPEN-P4 | Default list of COD-blocked provinces | Offer the reference list as a suggestion the seller confirms. Block nothing silently. |
| OPEN-P5 | Per-courier excluded provinces | Do not build. |
| OPEN-P6 | Per-order platform charge | None. Subscription is the only platform revenue. |
| OPEN-A2 | Affiliate attribution window | 7 days, Owner-configurable. |
| OPEN-A3 | Platform fee on commission | None in the first release. |
| OPEN-A4 | Affiliate bank details | Stored on the platform, shown only to the paying store's finance role. |
| OPEN-A5 | Auto-approve affiliate applicants | Off by default; the seller can switch it on per store. |
| OPEN-G1 | Caps on access links | 10 links per product, 2,000 characters per link. |
| OPEN-G3 | Digital products in Meta and Google feeds | Excluded. |
| OPEN-G4 | Default expiry of a digital access grant | None; the seller may set days per store. |
| OPEN-G6 | Licence-key pools | Not in the first release. |

## 3. Decide later (no task depends on them yet)

| ID | Question | Recommendation |
|---|---|---|
| OPEN-G7 | Where the member area lives and who signs in | The existing buyer portal (`buyer.bukalaris.com`) with a per-store view and the platform buyer identity (ADR-0010). One login covers every store the buyer bought from, and no buyer session sits on a host that runs a seller's advertising scripts. A member area on the store's own host or custom domain is possible later and needs its own ADR. |
| OPEN-G8 | Video and webinar providers that may be embedded | A fixed allow-list chosen when the member area is scheduled. Never a frame address typed by a seller. |
| OPEN-D1 | Host of the later cross-store affiliate storefront | Decide with T-54/T-55. Reserve no third domain now. |
| OPEN-P7 | Sandbox origins for Mengantar and AutoLaris | Not an owner choice: taken from each provider's official documentation inside T-105 and T-106. |

Closed on 2026-11-14 by the link-only delivery decision: OPEN-G2 (file storage) and OPEN-G5 (upload scanning).

## 4. Owner actions (answered 2026-11-14, recorded in D-31)

| Action | Recommendation | Owner answer |
|---|---|---|
| Rotate the Mengantar Partner Secret pasted in chat on 2026-10-27 | Rotate and revoke | Not rotated; the owner accepts the exposure. The Partner model is superseded |
| GitHub repository visibility | Make it private | Stays public for now |
| Register `bukalaris.id` | Register now, no DNS records | Done: `bukalaris.com` and `bukalaris.id` are registered (owner statement) |
| AutoLaris payment-only profile | Ask AutoLaris how a seller account gets it | Requested by hand from AutoLaris per seller; the seller enters the received API key in Seller Admin |
| Evidence screenshots shown as modified | Restore from Git | Done: 240 files restored |

## 5. Recommended work order

1. T-100: CI green again.
2. T-101: finish the document alignment for the sections each next task touches.
3. T-102, T-103: two root domains, checkout on the store host. Host mode has no working buyer checkout today.
4. T-104 to T-107: seller provider accounts, Mengantar and AutoLaris on the seller's key, money boundary.
5. T-113: bank transfer to the seller's account. T-111, T-112: digital products with link delivery.
6. T-108 to T-110: seller-run affiliate programme.
7. Member area, video and webinars: not scheduled; start with OPEN-G7.
