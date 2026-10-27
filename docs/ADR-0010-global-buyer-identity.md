## ADR-0010: Global buyer identity, automatic checkout association and verified buyer portal

- **Status:** Accepted (owner, 2026-10-28, DECISIONS D-20; accepted as a decision, not implementation evidence)
- **Date:** 2026-10-27
- **Author:** Architecture + identity/privacy planning
- **Deciders:** Paduka Ongki (product owner), with security and privacy owners
- **Owner:** Bukalaris security owner with product and privacy owners
- **Related:** PR-7, DATA-4, DATA-12, IAM-4, IAM-14, PRIV-2, PRIV-4, PRIV-8, UX-21; ADR-0005, ADR-0008, ADR-0009; ARCH-5 proposed BA-01 through BA-06 and JOB-10; T-8 (superseded), T-36, T-43, T-51, T-52, T-57, T-58

## Context

Owner decision (2026-10-27): introduce `buyer.bukalaris.com`, a global buyer
account usable across every Bukalaris seller. Checkout silently associates an
order with the buyer found by phone/WhatsApp number, otherwise email, otherwise
creates the buyer record. If phone and email identify different existing buyers,
**the phone account wins**. There is no registration form or password and no
additional buyer-visible checkout step. Guest checkout remains available.

This revises the earlier IAM-4 rule that guest checkout must not automatically
create an account. A silently created identity is a correlation record, **not**
a verified login or proof that the checkout submitter owns its identifiers.
Typing another person's number/email must never expose their existing profile,
address or orders. A buyer portal requires possession proof and safe account
binding before any private data is shown. One account per person is the product
intent; unique contact keys alone cannot establish that shared/recycled numbers
represent one human, or find the same person using unrelated contacts.

Observed M2 reference points: `order` stores `buyer_name`, `buyer_phone`, optional
`buyer_email` and `shipping_address` snapshots; checkout lowercases/validates
email and requires a phone for existing delivery flows. The existing
`normalizePhone` in `packages/db/src/orders.ts` maps `62`/`+62` to local `0`
form for risk lookup, while the proposed global canonical form below is `62…`.
T-57 must reconcile these semantics rather than create inconsistent identity,
privacy-lookup and affiliate comparisons. T-36 provides signed single-order
status links, not a global account login. T-43 supplies per-store buyer export/
redaction, not global buyer-account deletion. No production buyer-data migration
is assumed: owner context says no production data exists yet; imported/M2/test
snapshot backfill remains an explicit migration decision.

**Decision drivers:** seamless cross-seller purchasing; deterministic phone-first
resolution; no automatic merge; seller isolation; no enumeration/prefill leak;
verified account access; and a clear platform privacy responsibility.

**Non-goals:** making buyers seller members, buyer access to other buyers,
affiliate buyer reports, a multi-seller cart, implementing an unverified OTP
provider, or silently rewriting/redacting seller financial records.

## Decision

### 1. Separate association, verification and account access

- The platform owns the global buyer identity/profile, identifiers, address book
  and buyer-order associations. There is no owning seller `store_id` on identity
  tables. Seller-owned orders retain immutable checkout contact/delivery
  snapshots, subject only to their existing explicit privacy-redaction process.
- Automatic checkout resolution creates/links records without a signup form,
  password, OTP challenge or login redirect. It never creates a buyer session,
  sets `verified_at`, enables an alias for login, or returns an existing profile.
- The portal requires proof of possession through the selected phone/WA OTP or
  email magic-link mechanism. Channel/provider, availability and cost are OPEN;
  no provider endpoint or deliverability is claimed verified. "No registration"
  means no signup/password, not no verification.
- Proof of a newly supplied contact is not proof of ownership of an existing
  account to which checkout attached it. Identifier possession and trusted
  account binding are separate fields/gates. In particular, an attacker cannot
  submit a victim's phone with the attacker's email, verify that email and gain
  the victim's cross-seller history. Secondary alias login is enabled only after
  possession proof **and** authorized account binding; for a phone-keyed account
  this requires primary-phone proof or accepted recovery proof, not checkout
  observation. Email-only identities may bootstrap from proof of their resolving
  email; no unverified phone becomes an authentication/recovery authority.
- A portal session sees only confirmed own-account links. Automatically resolved
  links begin unverified; confirmation requires trusted binding to the resolving
  identifier, and any shared/recycled-number restriction must be satisfied.
  Association is still automatic; restricted history is not silently released
  merely because a later OTP reached a number's new holder. Exact recovery/
  recycling policy is a production access gate, not an invented assumption.

### 2. Canonical identity keys

- `kind='phone'` is the primary checkout key. Normalize valid Indonesian mobile/
  WA input to digits beginning `62`, without `+`: `08…`, `628…` and `+628…`
  resolve to the same `628…` canonical value. Strip only approved formatting
  separators before validation; reject ambiguous/invalid values under existing
  checkout validation rather than inventing a second person or guessing a
  country. Normalization does not prove that a number is live, personal or owned.
  Non-Indonesian-number support remains an explicit future policy, not an
  automatic conversion. Examples use patterns, not real personal numbers.
- `kind='email'` is secondary: trim and lowercase consistently with the existing
  checkout contract, validate syntax/length, and do not strip dots or plus tags
  or infer provider-specific aliases. Changing canonicalization later requires
  a collision-reviewed migration, not silent identifier reassignment.
- Enforce `UNIQUE(kind, canonical_value)` across buyer identifiers, including
  unverified observations. The canonical value is sensitive restricted data,
  not a public lookup key. A verified owner claim that conflicts with an earlier
  unverified observation follows controlled claim/recovery review, never a
  public existence response or automatic merge. Reuse/release of revoked
  identifiers is OPEN under the number-recycling/global-deletion policy.

### 3. Proposed column contract (DATA-4/DATA-12 must match)

These are proposed logical columns, not existing migrations. IDs follow existing
repository identity/transport conventions; timestamps are timezone-aware.
Auth adapter-owned challenge/session storage is selected separately; do not
invent a parallel password, OTP or session-token table here.

| Record | Exact proposed columns | Constraints and ownership |
|---|---|---|
| `buyer` | `id`, `status`, `display_name`, `primary_phone_identifier_id`, `created_at`, `updated_at`, `closed_at` | Platform-owned, no `store_id`; status `provisional`, `active`, `restricted`, `closed`. Profile name is buyer-managed, never overwritten by unverified checkout contact data. `primary_phone_identifier_id` is a nullable same-buyer FK to a `buyer_identifier` of kind `phone`: the phone that anchors the account (set when the buyer is created from a phone, or when a possession-proven phone is first bound to an email-created buyer). An observed phone attached to an email-only buyer never becomes primary without possession proof. "Primary-phone proof" in section 1 means proof of this identifier |
| `buyer_identifier` | `id`, `buyer_id`, `kind`, `canonical_value`, `verified_at`, `binding_state`, `account_bound_at`, `created_at`, `revoked_at` | FK buyer; `kind` phone/email; `UNIQUE(kind, canonical_value)`; **partial unique `(buyer_id) WHERE kind='phone' AND binding_state<>'revoked'`: one live phone per buyer**; binding state `observed`, `bound`, `disputed`, `revoked`. Checkout insertion is observed with NULL verification/binding times. A bound login identifier needs possession proof and account-binding authorization |
| `buyer_order_link` | `buyer_id`, `store_id`, `order_id`, `resolved_identifier_id`, `resolution_method`, `access_state`, `linked_at`, `confirmed_at` | `UNIQUE(store_id, order_id)`; compound FK `(store_id, order_id)` to the seller order, same-buyer FK for resolving identifier. Resolution `phone`, `email`, `created`; access `unverified`, `confirmed`, `restricted`. No order contact/amount copy in this link |
| `buyer_identity_event` | `id`, `buyer_id`, `store_id`, `order_id`, `event_type`, `related_buyer_id`, `actor_type`, `actor_id`, `request_id`, `created_at` | Append-only restricted identity audit/conflict evidence; optional store/order context with same-store FK when present. Event types include `buyer_created`, `order_linked`, `identifier_observed`, `phone_email_conflict` (phone and email identify different buyers), `email_phone_mismatch` (the email-matched buyer already has a different live phone, so a new buyer was created), `identifier_bound`, `link_confirmed`, `identity_restricted`, `merge_requested`, `merge_completed`. No raw contact values, OTPs, magic links or delivery address in audit payloads |
| `buyer_address` | `id`, `buyer_id`, `label`, `recipient_name`, `phone_canonical`, `address_text`, `destination_area_id`, `is_default`, `created_at`, `updated_at` | Platform-owned address book; buyer-only authenticated writes, own-buyer predicate and at most one default per buyer. Checkout addresses remain order snapshots and are not silently copied into the profile/address book |

`buyer_order_link` is one association per seller order, not a second order owner.
Phone/email conflict evidence references both buyer IDs internally; it does not
reveal the second account to a seller, buyer checkout response or affiliate.
Account merges, if accepted later, require proof of both existing accounts,
explicit conflict resolution and an audited transactional reassignment plan.
Keep identity-event evidence and financial-order history intact; no cascading
buyer deletion of paid seller orders. The merge UX/authorization contract is
OPEN; no automatic merge endpoint is implied.

### 4. Checkout resolution algorithm and transaction boundary

1. Validate submitted checkout contact/delivery fields as today, derive the
   seller/order from trusted cart/handoff authority and normalize the submitted
   phone and optional email. No client `buyer_id` or claimed verification flag
   is accepted. Existing order validation remains; this ADR does not make phone
   optional for a delivery flow that requires it.
2. The existing tenant-scoped order transaction writes its immutable order
   snapshot and an ID-only `buyer.resolve` outbox intent `(store_id, order_id)`.
   This preserves ADR-0005's app-pool order/RLS boundary without switching
   connection roles halfway through a transaction or holding DB locks across
   provider calls. Guest checkout returns the same safe order confirmation;
   identity synchronization is automatic **after commit**, not a login condition.
3. An operation-scoped platform resolver consumes that intent, reads only the
   committed order snapshot for its explicit seller/order target, and in one
   transaction locks normalized identifier keys in deterministic order. Replayed
   events use the same order-link uniqueness key. It must complete automatic
   association without a buyer registration/verification step; outbox failure
   remains a visible operational retry, not a duplicate account or lost order.
4. Resolve the buyer in this order:
   - Look up canonical phone first. If it maps to a buyer, choose that buyer.
   - Else look up canonical email. If it maps to buyer E **and E has no live phone identifier** (one not `revoked`), choose E.
   - Else, if the email maps to a buyer E that **already has a different live phone**, do **not** choose E and do **not** attach the submitted phone to E (that would let a checkout typed with someone else's email pin a new phone to the account, and the victim's own later checkout would then resolve into it). Create one new provisional `buyer` Y for this order, attach the submitted phone to Y, leave the email with E (it is not attached to Y), and append `email_phone_mismatch` with both internal references. The checkout response is unchanged.
   - Else create one provisional `buyer`.
   "Existing" includes observed identifier records for deterministic correlation; it does not establish login authority. There is one canonical phone per buyer at all times (the partial unique index of section 3).
5. If phone and email resolve to different existing buyers, choose the **phone**
   buyer for this order. Do not merge, move either identifier, replace the phone
   winner with the email owner, or attach the already-owned email as an alias.
   Append `phone_email_conflict` with both internal account references. The
   submitted email remains in this store's order snapshot as supplied, subject
   to existing notification/privacy rules; it receives no global account access.
6. Attach supplied phone/email identifiers to the chosen buyer only if their
   canonical values are not already owned by another buyer and, for a phone,
   the chosen buyer has no other live phone. New attachments are `observed`,
   never verified/bound. A phone attached to the buyer created from it becomes
   `primary_phone_identifier_id`; a phone attached to an email-created buyer
   (step 4, second bullet) stays observed and non-primary until possession proof.
   An email becomes an alias only when unowned; a conflicting email stays with
   its existing account. If a concurrent insert wins a unique identifier, re-read
   both keys and reapply steps 4 to 6 in the transaction; do not create a second
   account for the same phone or partially attach keys. The protection against a
   victim phone typed with an attacker email stays: the attacker's email never
   becomes login authority for the victim's phone account (section 1).
   OPEN (recommended, not decided): an email match accepts a first phone only
   when the matched email identifier is `bound`; for an `observed` email, create
   a new buyer as in step 4, third bullet, closing the remaining capture of a
   victim phone typed with the attacker's email-only buyer. Cost: one extra
   account when an email-only buyer later gives a phone; no merge is implied.
7. Insert the unique `buyer_order_link` with the winning resolving identifier and
   `access_state='unverified'`; append safe linkage/conflict events atomically.
   Order replay cannot change an existing association. Verified confirmation,
   restriction or later proof-based correction uses a separate audited service;
   it never rewrites the store's order snapshot.
8. Verification occurs only when the buyer chooses portal access or an explicitly
   accepted authenticated profile operation. Set `verified_at` only after a valid
   proof for that identifier; set bound/confirmed access only after the account
   binding and history-access checks in section 1. No account state, profile,
   default address, other-store order count or existence bit appears in an
   unverified checkout response or prefill request.

This post-commit outbox design means synchronization can lag order creation;
T-57 must define the operational completion/recovery contract and prove replay
safety. It does not permit manual sign-up or OTP to become checkout prerequisites.
Association does not globally change contact preference, add a trusted recovery
method, mark consent, activate an account or replace buyer-managed profile data.

### 5. Portal, sessions and database roles

- Add the exact host `buyer.bukalaris.com` under ADR-0008's one-app host routing,
  before seller-wildcard resolution. Reserve `buyer` as a platform label. DNS,
  TLS, delivery provider and production session isolation are UNVERIFIED.
- A buyer session lives only on that host, with its own host-only cookie
  `__Host-bl_buyer` (Secure, HttpOnly, Path=/, no Domain attribute, SameSite as
  chosen in T-51) and separate session audience/trusted-origin checks. No
  parent-domain cookie or seller/custom-domain session sharing. CSRF protection
  is not cookie-only (12-SECURITY SEC-9): Origin/Sec-Fetch-Site checks plus a
  server-bound token apply to profile/address/identifier/export/delete
  mutations. Buyer sessions grant no seller, Owner console or affiliate
  capability; shared email/phone does not cross role boundaries. A redirect or
  signed order link is not a session.
- Passwordless proof challenges are short-lived, single-use, attempt-bounded and
  purpose/destination-bound; store tokens through the verified auth adapter,
  never in logs or ordinary URLs beyond the controlled magic-link transport.
  Validate callback/return destinations. Rate-limit request, resend, verify and
  recovery by canonical identifier, operation and trusted network signal using
  the shared DB-backed limiter of 16-OBSERVABILITY (rows RL-OTP-REQ, RL-OTP-VERIFY;
  the in-memory Better Auth limiter is not enough), and cap deliveries per
  destination and per day to bound SMS/WhatsApp toll fraud. Existing/unknown/
  conflicting accounts receive uniform request responses and equivalent outward
  behavior; no account enumeration. **Prerequisite:** magic links must not be
  sent until the `mail_outbox` defect (`CRSEC-04`: URLs stored in clear text and
  readable by the app role, no real mailer) is fixed: a real mailer, bodies purged
  after delivery and no app-role `SELECT`. T-58 depends on that fix (T-73).
- Preserve ADR-0005's **three login database roles**, not a new buyer BYPASSRLS login
  (its amendment adds only no-login owner roles).
  `bukalaris_owner` remains migrations-only. `bukalaris_app` buyer requests use
  verified server `BuyerScope` and transaction-local `app.buyer_id`; identity,
  identifier, address and link tables enable FORCE RLS with own-buyer policies
  (`buyer.id`, otherwise `buyer_id`). Missing buyer context gives no rows.
  Seller scope alone never authorizes these tables. A request may not set a
  caller-selected buyer context or mix buyer/admin contexts to expand access.
- `buyer_order_link.store_id` is provenance and compound-FK enforcement, not a
  seller grant to global identity. Its policy is buyer-owned access, not the
  generic store-only policy that would break cross-seller buyer history.
  Store-order/product/shipment tables keep existing tenant RLS unchanged.
  Role grants and the schema/RLS inventory must explicitly record this exception
  and prove it; an automatic "all store_id tables have the same policy" check
  must not silently grant seller access to buyer profiles.
- `bukalaris_platform` remains BYPASSRLS as in ADR-0005, so RLS is **not** claimed
  to protect it; under the ADR-0005 amendment it holds no table privilege on the
  buyer identity tables and reaches them only through registered
  `SECURITY DEFINER` functions. Add only narrowly allowlisted automatic identity
  resolution, audit/recovery and buyer-history projection services with explicit
  target buyer/store/order predicates and server authorization. Portal code cannot
  run arbitrary cross-store platform queries. Identity-event reads are restricted
  service/privacy functions, not ordinary seller or buyer table grants.
- The buyer-history service selects only confirmed own links, then reads each
  linked order/shipment through explicit stored store/order targets and a safe
  buyer DTO. Recheck buyer session, link access and redaction/restriction on
  every page/detail/export, with buyer-scoped cache keys and no shared cache.
  Seller A sees only A's snapshots and cannot learn that this buyer shops at B.
  Affiliates never gain buyer identity/history (PRIV-2).

### 6. Existing order links, self-referral and privacy lifecycle

- T-36 signed links keep their existing **single-order** scope/expiry and tracking
  behavior. A valid link is not proof of a global account, merge consent or a
  reusable passwordless login. T-58 may render that same safe tracking DTO after
  buyer/link authorization; it cannot mint global access from a status token.
- Affiliate self-referral uses the same canonical-phone contract through the
  resolved buyer identity/identifier service, compared to the affiliate's
  canonical phone server-side. During asynchronous buyer resolution, use the
  canonical submitted order phone in the synchronous attribution transaction;
  the completed link must agree. No delay, missing portal verification, email
  conflict or later merge may bypass self-referral or reassign a frozen
  commission. Affiliates receive no buyer ID, phone or profile in the result.
- Bukalaris takes controller responsibility for the platform cross-seller buyer
  profile. Seller order-data responsibilities remain store-specific; actual
  UU PDP lawful basis, notice, consent requirements and joint/processor roles
  require qualified review and remain UNVERIFIED. Silent account creation does
  not imply marketing consent. Provide a reviewed checkout notice describing
  global association, controller/contact, purpose, access, retention and rights;
  collect any legally required consent without treating an unchecked optional
  marketing choice as permission for profile disclosure.
- T-43 per-store export/redaction does not become a global lookup. A seller
  cannot export another store or the global profile. Portal export requires
  verified own-account access and includes own profile/identifiers/addresses and
  authorized linked records only, with fresh authorization and no-store delivery.
  T-43 redaction is reflected in buyer DTOs; the portal never resurrects the
  original order contact from a stale profile/cache/export.
- Global deletion/closure is OPEN: decide what profile, identifier mappings,
  links, audit evidence and address data are erased/restricted, how re-checkout
  behaves, and how lawful financial retention/holds preserve seller records.
  No cascading deletion or rewriting of order/commission/payout history. Define
  finite provisional-account, identifier, conflict, address, session/challenge,
  link and profile retention, restore reapplication and processor cleanup before
  production processing; do not invent a statutory period or retain forever.

## Alternatives considered

- **Keep explicit optional registration only:** safer to implement around the
  current IAM-4, but rejected by the owner's automatic association/no-signup
  requirement. Possession proof stays mandatory for private portal access.
- **Email-first matching or automatic merge:** convenient when contacts overlap,
  but rejected because the owner requires phone priority and proof of both
  accounts before merging; shared/mistyped/recycled contacts are not consent.
- **Treat checkout match or any alias OTP as account login:** rejected because
  an attacker can type a victim's contact or attach their own email at checkout.
  Separate observed association, possession proof and account-binding authority.
- **Read all orders by phone/email from buyer routes:** rejected because it leaks
  history through unverified or recycled identifiers, bypasses link ownership,
  and risks breaking seller RLS. Use protected link resolution and bounded
  platform history projection; keep immutable seller order snapshots.

## Consequences

- **Positive:** one phone-first platform identity can automatically collect
  seller-order associations without interrupting checkout, while portal access,
  seller visibility and affiliate reporting remain separate trust boundaries.
- **Negative:** platform controller obligations expand; alias pre-hijacking,
  contact recycling, conflict recovery and post-commit synchronization require
  deliberate policies and real isolation/concurrency tests.
- **Neutral:** account creation is not a logged-in session. No production backfill
  is presumed; T-8 is superseded by T-57/T-58 for buyer identity/portal scope,
  while affiliate attribution/privacy work remains T-52–T-55/ADR-0009. PR-7,
  DATA-4/DATA-12 and host/UX contracts must match these proposed names and gates.

## Confirmation

T-57: Vitest normalization/precedence tables and real-PostgreSQL uniqueness,
concurrent-resolution, transaction/outbox replay and role/RLS tests. Prove phone
wins cross-account email conflict, no automatic merge, no stolen alias becomes
login authority, and checkout returns no stored profile/existence signal.
T-58: Playwright passwordless own-history/tracking/profile/address flows across
two stores, invalid/expired/reused proof denial, uniform unauthenticated
responses, no prefill leak, cross-buyer/store denial, host-cookie isolation and
T-43 redaction propagation. Use synthetic contacts and a bounded delivery
adapter in deterministic tests; live channel delivery/DNS/TLS require separately
approved evidence. No checks/provider calls were performed for this ADR.

## Open decisions and entry gates

| OPEN item | Owner / gate |
|---|---|
| OTP channel/provider (WhatsApp Business API, SMS, email magic link), cost, coverage, availability, delivery/verification/recovery limits and lifetimes | Product/security owners before live T-58; no provider selected or asserted available |
| Whether authenticated checkout prefill is allowed after verification; exact profile/address release and cross-origin handoff | Product/privacy/security owners; no prefill before accepted proof, binding and origin policy |
| Self-service merge UX, conflict correction and contested observed-identifier claims. *Plain terms (decided, D6):* a merge joins two buyer accounts so one person sees the other account's order history; if a staff member could do this on request, someone could be socially engineered into exposing a stranger's purchases. **Staff-executed merge is decided disabled in Phase 1 (the route returns not-found); buyers merge only through self-service possession proof of both identifiers (phone and email).** If a future phase ever enables a staff-executed path, it must first record an evidence standard with notice to the verified contact of both accounts, a cooling-off period, and a freeze on identifier changes for the merged account afterwards | Product/security/privacy owners; no automatic merge or client-selected reassignment |
| Recycled/shared phone and shared-email policy, historical access, revocation/recovery and identity uniqueness limitations | Security/privacy owners before production history release; current possession alone is not proof of previous holder's orders |
| Global deletion/re-registration behavior and per-class retention/legal holds/processor/backup treatment | Privacy/legal owners before production profile processing; keep T-43 store redaction separate |
| Minors and any age/guardian/consent requirements | Qualified legal/privacy owners before production rollout; applicability UNVERIFIED |
| Snapshot backfill and notification/contact consequences for existing records | Data/privacy owners before T-57 migration; no production data assumed, no automatic retrospective merge |
| Post-commit identity synchronization completion/recovery target | Product/operations owners before T-57 release; order remains valid if automatic association is pending |

## More information

- [ADR-0005 — Three-role database isolation](ADR-0005-database-tenant-isolation-rls.md)
- [ADR-0008 — One-app host architecture](ADR-0008-platform-architecture-and-routing.md)
- [ADR-0009 — Affiliate boundaries](ADR-0009-platform-owned-affiliate-programme.md)
- [IAM-4 — Buyer model](07-IAM-RBAC-ABAC.md#iam-4--buyer-model)
- [PRIV-8 — Global buyer profile](13-COMPLIANCE-PRIVACY.md#priv-8--global-buyer-profile-and-rights)

## Change history

- 2026-10-27 — Documentation audit pass: one canonical live phone per buyer with `primary_phone_identifier_id`, an email match to a buyer that already has a different phone creates a new buyer and logs `email_phone_mismatch` (audit SPV-09); magic links wait for the `mail_outbox` fix (audit SPV-17); merge execution disabled until the standard is recorded (audit SPV-08).
