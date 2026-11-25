## ADR-0016: Digital products beside physical products — prepaid only, no shipment, access links granted on payment

- **Status:** Accepted (owner, 2026-11-14, DECISIONS D-30; accepted as a decision, not implementation evidence). Nothing is implemented: every product is physical today (`variant.weight_grams` is mandatory, every order has a shipping address and courier).
- **Date:** 2026-11-14
- **Author:** Architecture + product planning
- **Deciders:** Paduka Ongki (product owner)
- **Supersedes:** None. Extends [ADR-0002](ADR-0002-single-store-checkout-first.md) (one store per checkout stays) and [ADR-0013](ADR-0013-seller-owned-shipping-and-payment-accounts.md).
- **Related:** PR-2, PR-4, PR-5, PR-12, PR-21, PR-24, PR-28, BILL-1, BILL-2, DATA-3, T-40, T-61, T-88, T-93, [ADR-0015](ADR-0015-seller-run-store-affiliate-programme.md)

## Context

Owner decision (2026-11-14): a store can sell physical products, digital products, or both. A digital product has no shipment and is paid through the store's AutoLaris account.

The checkout was built for parcels: a variant must have a weight, an order must have a destination area, a courier and a shipping fee, COD is a first-class method, and "delivered" comes from the courier. A digital sale has none of that, and it adds two things the platform does not have yet: content that only a paying buyer may see, and delivery that happens the moment payment is proven.

Owner refinement (same day): Bukalaris does **not** host the content. The seller keeps the files where they already are (Google Drive or any other host) and gives Bukalaris the link; uploading and storing sellers' files on the platform is more than the product needs. A member area (a signed-in buyer dashboard per store, with embedded video and webinars) is a later stage: the data model is prepared for it now, nothing of it is built.

**Decision drivers:** one catalog and one checkout for both kinds; no access before payment is proven; no content link on any public page; no file storage on the platform; the smallest delivery model that sellers of e-books, templates, presets and access links can use.

**Non-goals:** file upload, hosting, proxying or scanning of sellers' content; download counting; licence-key pools, subscriptions or recurring billing, streaming or DRM, a course player, per-buyer watermarking, digital goods delivered by a third-party API.

## Decision

### 1. Catalog

1. A product has a `kind`: `physical` (default) or `digital`. The kind applies to every variant of the product. It can be changed only while no order line refers to the product.
2. A digital variant has **no weight** and never enters a shipping quote. Its stock is **unlimited by default**; the seller may switch on a stock count for limited editions, and then the existing stock rules apply unchanged.
3. A digital product carries its **delivery content**: one or more **access links** (a label and a link to content the seller hosts elsewhere, such as Google Drive), an access note (text shown only after payment), or both. A digital product cannot be activated without delivery content.
4. The storefront labels a digital product as digital and states how it is delivered. Physical-only fields (weight, courier estimate) are not shown for it.

### 2. Checkout

5. A cart may hold both kinds. The checkout stays one store per order (ADR-0002).
6. **Shipping is computed from the physical lines only.** An order with no physical line has no destination area, no courier, no shipping fee and no pickup; the address fields are not asked.
7. **A digital line makes the order prepaid.** COD is not offered when the cart contains a digital line, and the server refuses it at submit through the same eligibility function as every other filter (ADR-0013 section 4).
8. A digital line requires the buyer's **e-mail** in addition to name and phone, because the access link is sent there. Buyer identity matching is unchanged (phone first, then e-mail, ADR-0010).
9. Promotions apply to digital lines like any other line, except free-shipping rules, which never count a digital line toward a threshold.

### 3. Payment

10. Digital orders are paid by QRIS or VA on the **store's own AutoLaris account** (ADR-0013), or by bank transfer to the seller's own account (ADR-0013 section 10). The payment rules of ADR-0013 section 6 apply without change: a callback is evidence, a status check on the allow-list settles.
11. Bukalaris uses AutoLaris only as a payment gateway for every order, physical or digital, because shipping runs on Mengantar. The provider's order endpoint is used in its **payment-only profile**. The provider documentation describes that profile as an agreement on the individual account, so each store's AutoLaris account must have it confirmed before QRIS/VA is "ready" for that store (readiness, ADR-0013 decision 13). UNVERIFIED per account; never assumed.

### 4. Delivery

12. **Access is granted when the order becomes paid, in the same transaction that settles it** — by status check or by the seller's manual confirmation. One grant per digital order line, created once; a replayed settlement creates no second grant. A grant belongs to one store, one order line and the order's platform buyer identity (ADR-0010).
13. The buyer reaches the content from the **signed order-status page**. The payment-confirmed e-mail carries the order-status link, never a content link. There is no buyer login requirement.
14. **Bukalaris stores no file.** Delivery content is a list of access links plus an optional access note. The platform does not upload, copy, proxy, preview or scan what the link points to, and the server never requests the link (no reachability check, no preview fetch).
15. **Link rules:** `https` only, no credentials in the URL, a length cap, a count cap per product. A link is shown with its label and its destination host, opens in a new tab, and is sent with no referrer, because the order-status address contains the buyer's signed token. Access links and the access note never appear in storefront HTML, the Storefront API, feeds, e-mails or logs; they are read only through a valid grant.
16. An **access note** is rendered as text, never as HTML supplied by the seller.
17. A grant is `active` or `revoked` and may carry an expiry (none by default; a store setting). The seller can extend or revoke a grant; each action is audited. Bukalaris controls only whether its own pages show the link: it cannot count downloads, and it cannot withdraw a link the buyer already copied. Who can open the link is set by the seller on their own host. The product screen states this to the seller in plain words.

### 5. Order lifecycle

| Order contains | When paid | Completion |
|---|---|---|
| Digital lines only | Access granted, order becomes `completed` | Immediately |
| Digital and physical lines | Access granted for the digital lines; the parcel follows the normal booking flow | When the parcel is delivered |
| Physical lines only | Unchanged | Unchanged |

18. Cancelling or refunding a digital line revokes its grant. A refund is made by the seller and recorded on the order (ADR-0013 decision 26).
19. Unpaid digital orders expire with the payment instruction. A digital line with unlimited stock reserves nothing, so T-88 concerns only counted stock.

### 6. Other rules

20. **Affiliate commission** on a digital line becomes `payable` after the grant plus `affiliate_hold_days`; a revoked grant inside the hold voids it (ADR-0015 decision 4). *Superseded in part on 2026-11-25 by D-38 A (T-108): a commission is voided only when the order is cancelled or returned before delivery; a grant revoked after the order completed no longer voids it, and a post-delivery mistake is a manual correction (T-109).*
21. **Store readiness:** a store needs one ready payment method to open. A physical product can be activated only when shipping is ready; a digital product only when a prepaid method is ready. This refines ADR-0013 decision 14.
22. **Catalog feeds** (T-40) exclude digital products.
23. **Content rules:** the seller accepts terms that they hold the right to sell the content. The existing public report intake covers digital listings. In the first release abuse is handled by that intake and by suspending the store; while a store is suspended its access links are not shown. Per-product takedown and a `suspended` grant state belong to the Phase 2 moderation work (C-G1, D-32).
24. Sandbox test orders (ADR-0013 decision 11) grant access marked as a test.

### 7. Prepared for a later member area (not built)

Owner direction (2026-11-14, restated 2026-11-15): digital products are built in the first release, and their delivery there is a download through the seller's link (for example Google Drive) on the order-status page. There is **no digital-product dashboard yet, for the buyer or for the seller**. Later, a buyer gets a signed-in member dashboard per store that lists the digital products they own, with embedded video and webinars, and the seller gets a dashboard of their own to manage digital-product membership (members, their access, content). Neither is scheduled. In the first release the seller manages digital products inside the existing product and order screens. The first release only keeps the model open for the later stage:

25. **Access items are typed.** The first release has one type, `link`. `video_embed` and `live_session` are reserved names for the later stage and are not accepted by any screen or service yet.
26. **Grants are the single source of access.** The order-status page reads content through one function, from grant to access items. A member area is a second reader of the same grants, selected by store and buyer identity, so no data migration is needed when it arrives.
27. **The structure is prepared and kept non-public (owner, 2026-11-15).** T-112 creates the places the later stage will fill: the member-area module in the database package and the reserved route folders for the buyer member dashboard and the seller's membership management, plus the reserved access-item types of item 25. They hold no page and no handler. Their paths are reserved in the host dispatch and answer `404` on every host; nothing links to them and they appear in no navigation, sitemap, feed or API description. Making any of it reachable is a separate task with its own decision.
28. **Nothing else is built now:** no member login on a store, no buyer member dashboard, no seller membership-management dashboard, no embedded player, no frame allow-list in the content-security policy, no webinar scheduling. The direction is set (buyer portal on the platform host, fixed embed allow-list; D-31); the design and its tasks are written when the member area is scheduled.

## Alternatives considered

- *A separate digital store type or a separate checkout* — simpler rules per flow, but two catalogs and two checkouts to keep correct, and the owner asked for one system that does both.
- *Forbid mixed carts* — removes the mixed lifecycle row, but makes a buyer of a book and its e-book check out twice.
- *Allow COD for mixed carts and release the digital part on parcel delivery* — keeps COD conversion, but ties access to a courier status and to a parcel that can be refused.
- *Upload to private platform storage with signed, counted download URLs* (the first draft of this ADR) — the platform can limit and revoke downloads, but it must store, quota, scan and take down sellers' files and choose a production store. Rejected by the owner as more than needed; sellers already keep their content on a file host.
- *Show the link in the payment e-mail* — one click less, but an e-mail is forwarded and kept forever, and a revoked grant could not hide it.

## Consequences

- **Positive:** sellers of digital goods can open a store with only a payment account and no courier account; one catalog, cart and checkout; access cannot precede proven payment; no file storage, quota, scanning or storage provider to operate.
- **Negative:** `variant.weight_grams` becomes conditional and every shipping, weight and address assumption in checkout, order, e-mail, dashboard and feed code needs a physical-lines-only path. Protection of the content is only as strong as the seller's sharing settings: a buyer can pass the link on, and revoking a grant hides the link without closing it. Bukalaris cannot tell whether a link is dead or what it serves, so a broken or harmful link is found by report, not by the platform. Mixed orders add a lifecycle branch.
- **Neutral:** integer IDR, one store per order, server-derived totals and the payment state machine are unchanged.

## Confirmation

- Checkout tests: a digital-only order has no shipping fee, area or courier and needs e-mail; a mixed order quotes from physical weight only; COD with a digital line is refused at submit, including a direct request; a free-shipping threshold ignores digital lines.
- Grant tests: no grant before paid; exactly one grant per line under concurrent or replayed settlement; a callback alone grants nothing; revoke on cancel or refund.
- Access tests: access links and the access note are absent from storefront HTML, the Storefront API, feeds, e-mails and logs; an expired or revoked grant shows no link; a non-`https` link or one with credentials is refused on save; the rendered link carries no referrer; the server makes no outbound request to a link; an access note containing markup is rendered as text; an access item of a reserved type is refused.
- Lifecycle tests: the three rows of section 5.
- Isolation tests: store A cannot read, attach or revoke store B's access items and grants under the application role.
- Each access and money invariant above is broken once on purpose and its named test fails (repository mutation rule).
- Browser evidence at 320 px and desktop: digital-only purchase to the access link, mixed purchase, and the seller's grant actions.

## Owner decisions on the former open items (2026-11-14, D-31)

The owner accepted the recommended defaults on 2026-11-14 (DECISIONS D-31). The IDs are kept so earlier references still resolve. Decided, not implemented.

| ID | Item | Decision |
|---|---|---|
| OPEN-G1 | Caps on access links | 10 links per product, 2,000 characters per link, Owner-configurable |
| OPEN-G2 | Production storage for private files | Closed: the platform stores no file |
| OPEN-G3 | Digital products in Meta and Google catalog feeds | Excluded |
| OPEN-G4 | Default grant expiry | None; the seller may set a number of days per store |
| OPEN-G5 | Malware scanning of uploads | Closed: no upload. Harmful links are handled by report and takedown |
| OPEN-G6 | Licence-key pools | Not in the first release |
| OPEN-G7 | Where the later member area lives and which identity signs in | Direction accepted: the existing buyer portal on the platform host, with a per-store view and the platform buyer identity (ADR-0010). A member area on a store's own host needs its own ADR. Not scheduled |
| OPEN-G8 | Embeddable video and webinar providers | A fixed platform allow-list, never a seller-supplied frame address; the list itself is chosen when the member area is scheduled |

## Clarifications (2026-11-15, D-32; accepted by the owner)

The document alignment of 2026-11-15 found questions this ADR did not answer. Each row is the smallest answer consistent with the accepted decisions. The owner accepted every row on 2026-11-15 (D-32), with the changes marked in the rows. Decided, not implemented.

| ID | Question | Answer | Owning task |
|---|---|---|---|
| C-G1 | Decision 23 lets the Owner console take one product down and "suspend" its grants, but grants have only `active` and `revoked`, and per-item takedown is Phase 2 moderation in the Owner-console scope (ADR-0011) | First release: abuse is handled by the public report intake and by suspending the store; while a store is suspended, its access links are not shown. Per-product takedown and a `suspended` grant state move to the Phase 2 moderation work. Decision 23 and the takedown part of T-112 are narrowed accordingly | T-112 |
| C-G2 | A grant "belongs to the buyer identity", but the buyer is resolved after the order commits | The grant is bound to the order line; the buyer identity is reached through the order, not copied. A later member area selects grants by store and by the orders of that buyer | T-112 |
| C-G3 | Order redaction | Redacting an order revokes its grants | T-112 |
| C-G4 | Restore to an older backup | Grants, manual payment confirmations and affiliate payment records made after the backup are lost and are re-entered by the seller; the runbook says so (doc 14) | T-18 |

## Change history

- 2026-11-14: created from the owner decision of the same day.
- 2026-11-14 (same day, before any implementation): owner refinement. Delivery is by seller-hosted link, not by upload; private storage, signed file URLs and download limits removed (section 4, OPEN-G1/G2/G4/G5). Section 7 added: model prepared for a later per-store member area with video and webinars, not built.
- 2026-11-14: owner accepted the recommended defaults (D-31): link caps, no default expiry, feeds excluded, member-area direction.
- 2026-11-15: four clarifications proposed (D-32, awaiting owner confirmation).
- 2026-11-15: owner restated the scope: digital products are built with link download only; the buyer member dashboard and the seller's membership-management dashboard are a later stage (section 7).
- 2026-11-15: owner accepted the clarification table (D-32) and asked for the member-area structure to be prepared but not public (section 7, item 27).
