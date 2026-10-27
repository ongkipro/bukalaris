# Bukalaris IAM, RBAC, and ABAC

## IAM-1 — Identity separation

- Owner: Bukalaris security owner

The platform distinguishes Owner console staff, Seller membership, Buyer, Affiliate,
and service identities. One human may hold more than one role, but a session
must have an explicit active context; browser UI visibility is never authority.

## IAM-2 — Seller capability model

- Owner: Bukalaris product owner

| Role | Scope | Allowed job |
|---|---|---|
| Seller Owner | Assigned store | Membership, billing-visible settings, all seller operations |
| Seller Manager | Assigned store | Catalog, content, orders, fulfillment; no ownership transfer |
| Seller Staff | Assigned store | Explicitly granted catalog/order/content capabilities |
| Owner console staff (formerly Super Admin) | Platform | Store lifecycle, account management, money queues, platform configuration (capabilities and presets in IAM-15); optional marketplace review is a later scope (IAM-3) |
| Support operator (an Owner console staff preset, IAM-15) | Platform, case-bound target | Masked read-only diagnostic view tied to a case and purpose; no impersonation, password or session takeover; a consented, time-boxed seller support grant is OPEN (ADR-0011 §4) |
| Affiliate (Proposed, IAM-13) | Own platform affiliate identity | Approved cross-store offers, own storefront, aggregate outcomes and wallet; no seller membership |
| Buyer (Proposed, IAM-4/IAM-14) | Own platform buyer identity and confirmed links | Cross-seller own order history/tracking, own profile/address book; no seller/admin/affiliate power |

## IAM-3 — Marketplace and affiliate policy

- Status: Proposed (affiliate extension, owner decision 2026-10-27)
- Owner: Bukalaris product owner
- Source: PR-6, PR-7, PR-28, PR-29; ADR-0009.
- Statement: Marketplace review and affiliate product opt-in are distinct
  policies. Seller may submit only its own active product for marketplace review.
  Marketplace approval/rejection requires an Owner console capability and an audit
  reason; sellers cannot change that decision without resubmission.
- Affiliate accounts, attribution, wallet and payouts belong to the platform,
  never to a seller. Owner console staff approve the affiliate account once; an approved
  affiliate may promote opted-in products from multiple stores without separate
  seller approval. Seller may block that affiliate for its own store only.
- Products are not automatically eligible: seller opt-in and an in-bounds
  commission policy are required. Affiliate discovery reads `affiliate_catalog`,
  the platform outbox projection, not unscoped seller tables. Marketplace
  approval alone neither opts a product in nor authorizes affiliate access.
- Acceptance: Affiliate may read only its own aggregate referral outcomes and
  own wallet/payout records, never buyer PII, individual buyer orders or another
  affiliate's private records. Store A cannot see store B's seller-private
  affiliate settings, blocks, funding or financial records; the effective rate
  and status of an approved public offer is public by design (`affiliate_catalog`) and stays discoverable
  across stores. A seller block prevents new attribution for that store without
  deleting another store's offers or rewriting earned commissions.
- Constraints: IAM-1, IAM-5, IAM-7, IAM-13, TEN-1, PRIV-2, DATA-11, BILL-8.

## IAM-4 — Buyer model

- Status: Proposed (revised owner decision 2026-10-27)
- Owner: Bukalaris security owner
- Source: PR-7, DATA-4, DATA-12, ADR-0010; supersedes the earlier no-automatic-account proposal.
- Statement: One global buyer identity serves all Bukalaris sellers. Checkout
  automatically associates the order by canonical phone/WA first, otherwise
  email, otherwise silently creates a provisional account. If phone and email
  identify different existing buyers, phone wins; record the conflict without
  merging accounts or attaching an email already owned by another buyer. A buyer
  has one live canonical phone: an email match never attaches a different phone;
  when the email-matched buyer already has another live phone, a new buyer is
  created and the conflict logged (ADR-0010 §4).
  Guest checkout stays available with no signup/password or possession-proof
  step added to checkout. Automatic association is not authentication.
- Acceptance: A submitted phone/email never returns stored profile/address,
  account existence or another order before authorized possession proof.
  Normalized `08…`, `62…` and `+62…` phone formats resolve consistently.
  Unowned aliases remain observed/unverified until separately proven and
  account-bound; an attacker-controlled email attached alongside a victim phone
  cannot authenticate as that victim. Merging existing accounts requires proof
  of both; neither checkout nor shared contact text grants cross-account access.
- Constraints: IAM-1, IAM-14, PRIV-2, PRIV-4, PRIV-8, ADR-0005, ADR-0008.

The identity resolver processes the order transaction's ID-only `buyer.resolve`
outbox intent after commit (ADR-0010), automatically and idempotently; a pending
association never invalidates the guest order. Seller order contact snapshots
remain store-owned. Only the buyer may read its authenticated global profile;
seller membership cannot query whether the buyer also shops at another store.

## Required controls

| ID | Owner | Statement | Evidence |
|---|---|---|---|
| IAM-5 | Bukalaris security owner | Sensitive role, membership, suspension, and capability-grant changes require a durable audit record (impersonation stays disabled, IAM-10). | Negative/positive authorization tests |
| IAM-6 | Bukalaris security owner | Session and recovery design shall be selected from the verified repository stack; no credential/token format is assumed here. | Stack review before implementation |
| IAM-7 | Bukalaris security owner | Service identities have operation and tenant scope narrower than human Owner console access. | Integration/job authorization tests |

## IAM-8 — Phase 1 capability assignments

- Status: Proposed
- Owner: Bukalaris security owner
- Source: PR-1, PR-2, PR-11, PR-13; IAM-1, IAM-2, IAM-5.
- Statement: Named capabilities are enforced server-side. The following names
  are proposed internal policy identifiers, not claims of implemented API scopes.
- Acceptance: Each action has allowed and denied cases, including a valid login
  with no active membership and a store member with insufficient capability.

| Capability | Seller Owner | Seller Manager | Seller Staff | Platform operator |
|---|---|---|---|---|
| catalog.read / catalog.write | Own store | Own store | Explicit grant | No automatic seller access |
| content.write / content.publish | Own store | Own store | Separate explicit grants | No automatic seller access |
| orders.read / orders.fulfill | Own store | Own store | Separate explicit grants | No seller order access in Phase 1; masked, case-bound diagnostic view only (IAM-15); a consented support grant is OPEN (ADR-0011 §4) |
| domains.manage | Own store | Explicit grant | Denied by default | `tenants.manage` (domain management, Phase 2, UX-22 SA-19) |
| members.manage | Own store | Denied | Denied | `members.recover` ◆ (store ownership recovery; decided disabled in Phase 1 — self-service recovery only, IAM-15) |
| integrations.manage | Own store | Denied by default | Denied | None on seller integrations; platform providers only via `providers.read` / `providers.manage` (IAM-15) |
| tenants.manage | Denied | Denied | Denied | Explicit platform grant |
| logs.read | Denied | Denied | Denied | Explicit platform grant |
| audit.read | Denied for platform audit | Denied | Denied | Separate audit grant |

Seller access to any future store-specific activity view is a separate scoped
projection, never access to platform logs. Platform role assignment cannot be
performed through seller membership endpoints. Integration configuration never
returns stored secret values to the browser. Marketplace powers and the separate
proposed affiliate capabilities in IAM-13 are not activated by Phase 1 roles.
The full Owner console capability catalogue, role presets and four-eyes rules
extend this table in IAM-15; "platform operator" in this table means Owner
console staff.

## IAM-9 — Session and access lifecycle

- Status: Proposed
- Owner: Bukalaris security owner
- Source: IAM-6, NFR-1, DOM-3.
- Statement: Choose one verified authentication implementation after stack
  discovery. Specify invitation acceptance/expiry, recovery, membership removal,
  session expiry/revocation, and privilege-change reauthentication before launch.
  Privileged platform access requires MFA through the selected auth system.
- Acceptance: Revoked membership or session cannot mutate through a stale tab,
  API credential, or queued user-authorized action. Invites cannot assign a role
  outside the inviter's authority or be accepted repeatedly. Recovery does not
  reveal account existence or silently increase privileges.

Admin sessions remain on the chosen admin origin. Unrelated seller custom
origins do not share admin cookies. Browser CORS, buyer/cart continuity, and any
future identity handoff are separate explicit contracts; no token is passed in
an ordinary URL. Select concrete lifetimes and recovery methods during T-1/T-3.

**Session cookies (normative, all surfaces).** Every session and CSRF cookie
uses the `__Host-` prefix (Secure, `Path=/`, no `Domain` attribute) with a name
per surface: `__Host-bl_owner`, `__Host-bl_seller`, `__Host-bl_aff`,
`__Host-bl_buyer`, `__Host-bl_order_cart` (checkout), `__Host-bl_click`
(referral, SameSite=Lax). The prefix prevents a script on a seller storefront
subdomain from tossing a `Domain=.bukalaris.com` cookie onto another surface.
CSRF protection is never cookie-only: mutations check `Origin` and
`Sec-Fetch-Site` and carry a token bound server-side to the session (12-SECURITY
SEC-9). A separate registrable domain for storefronts is OPEN (recommended, not
decided; ADR-0008).

**Step-up and bank-destination payout controls (plain terms; decided, D5).**
*Why:* Bukalaris manages 100% of order payments and shipping under one unified
system (prepaid payments through our AutoLaris gateway and COD through
Bukalaris-generated Mengantar Partner seller accounts with platform master
account fallback; there is no seller-pasted external Mengantar key and no
two-system split). Because Bukalaris holds all seller balances and affiliate
wallets before payout, the scenario to prevent is an account takeover: a thief
takes over a seller or affiliate login (stolen password, SIM swap), swaps the
bank account to their own and requests a payout before the real owner notices.

*Rules (decided, apply to all seller and affiliate payouts):*
1. **Step-up authentication:** changing a bank destination, requesting a payout,
   or changing the verified contact (email or phone) of a seller owner or
   affiliate requires fresh proof inside the fresh-authentication window
   (re-authentication with the second factor when enrolled, otherwise a one-time
   proof sent to the verified contact on file).
2. **Old-contact notification:** whenever a bank destination or verified contact
   changes, the previous contact is notified immediately.
3. **72-hour hold on a new or changed bank destination:** a newly added or
   changed destination (`payout_destination`, `affiliate_payout_destination`) is
   held for **72 hours** by default (configurable in the Owner console) and
   cannot receive a payout until the hold expires. Any credential recovery or
   MFA reset starts the same hold on bank-destination changes and payout
   requests for that identity.
4. **Account-holder-name check:** the bank account's registered holder name must
   match the payee's name; a mismatch holds the payout for staff review.

These are anti-fraud controls, not tax, licence or identity-document checks, and
do not use the optional verification record. Affiliate recovery uses the
verified-contact link only; an affiliate MFA reset is a four-eyes action (IAM-15
matrix). Making MFA mandatory for every seller owner and affiliate before the
first payout request or bank change remains OPEN (recommended, not decided:
required, because these identities can move money).

## IAM-10 — Support and delegated access

- Status: Proposed
- Owner: Bukalaris security owner
- Source: PR-1, PR-9; IAM-5, IAM-7.
- Statement: Support uses an explicit target, bounded time, reason, and recorded
  granting authority. Read access is the default; write access requires a
  separately authorized action. Preserve the original operator identity in
  audit events and show support context visibly.
- Acceptance: Expiry, revocation, and target switching terminate the prior scope.
  A support session cannot grant itself a broader role or silently become the
  seller owner. If these controls are not implemented, impersonation remains
  disabled and support uses only explicitly permitted platform views.

Phase 1 alignment: console staff reach seller data only through the masked,
case-bound diagnostic view and the named `accounts.*` support actions of IAM-15;
no console capability edits a seller's catalog, orders or settings (IAM-15 "Never
available"). A write-capable support grant on seller data does not exist until
ADR-0011 §4 (b) is approved.

Future external API/MCP grants must support least privilege, expiry/revocation,
store binding, and an audit trail. They cannot inherit unrestricted Owner console
access or bypass draft/publication/form protection.

## IAM-11 — Headless channel tokens and checkout authority
- Status: Proposed
- Owner: Bukalaris security owner
- Source: PR-16.
- Statement: A private storefront token grants one store/channel access to
  published catalog/content, cart operations and checkout handoff. It grants
  no Seller/Admin, arbitrary order, payment, or diagnostic access. Keep it in
  the developer's backend secret store, never browser code. Existing carts
  additionally require their separate scoped capability.
- Acceptance: Create, revoke, expire and replace a token through authorized
  seller-owner operations. Store only a hash; display the secret once; list
  metadata thereafter. Revocation rejects new API calls and unused handoffs.
  CORS and a caller-provided host/tenant identifier are never authorization.
- Constraints: TEN-1, SEC-13, API-8.

Native host-bound calls may use the first-party public route without a channel
credential. Central API calls require the private channel token. Browser-public
keys are deferred until their limited permissions and abuse controls are defined.
Seller API service tokens are a different credential class and cannot substitute
for storefront tokens. Proposed rotation flow is create replacement → deploy
secret update → revoke old grant. No automatic plaintext recovery is allowed.

Checkout uses a distinct HttpOnly Secure host-only session, created by handoff,
with CSRF/Origin protection. A checkout ID alone grants no access. Channel
revocation need not invalidate paid orders; handling already-open checkout
sessions must be selected explicitly before release (proposal: deny new submits
on revoked channels while keeping safe order-status recovery available).

## IAM-12 — MCP grants and content capabilities
- Status: Proposed
- Owner: Bukalaris security owner
- Source: PR-17 and TD-6.
- Statement: MCP access uses a revocable grant bound to actor, store, client,
  expiry, and explicit capabilities. Resource discovery returns only objects the
  grant may read. Tool availability is filtered by capability before invocation;
  the application service repeats authorization on every call.
- Acceptance: A read-only grant cannot call draft or publish tools; a draft
  grant cannot publish; a content grant cannot change inventory, price, order,
  payment, domains, credentials, logs, or membership. Revocation and membership
  loss terminate access. Every mutation records actor, client, store, tool,
  target, revision, result, and safe correlation metadata.
- Constraints: TEN-1, IAM-2, IAM-7, SEC-9, OBS-5.
- Evidence: Permission proposal only; token/auth transport remains unresolved.
- Change history: 2026-09-18 — defined MCP catalog/content permission groups.

Proposed capabilities: `catalog.read`, `catalog.draft.write`,
`catalog.publish`, `content.read`, `content.draft.write`, `content.publish`,
`landing_pages.read`, `landing_pages.draft.write`, and
`landing_pages.publish`. Publication capabilities are never implied by draft
access. Bulk operations inherit the narrowest per-object capability and limits.
Owner console diagnostics and system-map access use separate platform grants.

## IAM-13 — Platform affiliate identity and capabilities

- Status: Proposed
- Owner: Bukalaris security owner
- Source: PR-28, PR-29; IAM-1, IAM-3; ADR-0008, ADR-0009.
- Statement: Affiliate is a separate account type and role with a separate
  portal login surface, not a buyer account or a seller membership. One human
  may also be a seller/operator, but each request uses one explicit active
  context; sharing an email or phone never grants another role.
- Acceptance: Affiliate A cannot read or mutate affiliate B's profile,
  storefront draft, links, wallet, bank/tax identity or payouts. Seller
  membership cannot approve an affiliate, write its wallet, or obtain buyer
  data through affiliate endpoints. Denied object access returns not-found
  without disclosing existence; allowed own-context access still succeeds.
- Constraints: IAM-5, IAM-7, IAM-9, TEN-1, PRIV-2, PRIV-6, PRIV-7, DATA-11.

The proposed portal origin is `affiliate.bukalaris.com`; public storefronts use
`<handle>.affiliate.bukalaris.com` under ADR-0008/TD-7. DNS/TLS and deployed
isolation are UNVERIFIED. Portal sessions use their own host-only cookie
`__Host-bl_aff` and trusted-origin boundary, not a parent-domain cookie shared
with seller or affiliate storefronts. A referral link/code/click id is a public
attribution selector, never a login, session, checkout capability or grant.

**Suspension effect.** Suspending an affiliate account (`affiliate.accounts.review`
with a reason) unpublishes its public storefront (the host returns not-found),
deactivates its links and codes (a deactivated link redirects the buyer without
capturing a click, a deactivated code resolves as unknown without failing
checkout), stops new attribution, and never deletes earned money or rewrites
earned commissions. Reactivation restores the last published storefront revision
and the links that were active at suspension.

**Affiliate authentication and hold period.** An affiliate signs in on its own
surface with its own auth audience. Because every Bukalaris order (prepaid and
COD) runs in the unified Bukalaris-managed system, all delivered and released
orders are eligible for affiliate commission; the affiliate hold period is
**decided at 3 days** (`affiliate_hold_days = 3` default, Owner-configurable
under `affiliate.policy.manage`, four-eyes `affiliate.rate_bounds`) after the
parcel is delivered and the seller sale is released. Payout requests and bank
changes enforce the decided D5 controls of IAM-9 (step-up, old-contact notice,
72-hour hold on a new or changed bank destination, and account-holder-name
check). MFA (TOTP) is offered at sign-up; making it mandatory before the first
payout request is OPEN (recommended, not decided: required). Recovery goes to
the verified contact; a support-requested MFA reset is four-eyes and starts the
payout/bank hold of IAM-9.

| Proposed capability | Affiliate | Seller | Owner console / service |
|---|---|---|---|
| `affiliate.profile.manage` | Own profile/contact | Denied | No write path; masked read through `affiliate.accounts.read` only |
| `affiliate.catalog.read` | Approved public offers across stores | Public offers only | Projection worker writes with bounded authority |
| `affiliate.storefront.manage` / `affiliate.links.manage` | Own storefront/items and links, active account only | Denied | No direct write path in Phase 1: effect only through suspension (`affiliate.accounts.review`) or, Phase 2, takedown (`moderation.manage`); no impersonation |
| `affiliate.outcomes.read` / `affiliate.wallet.read` | Own aggregate outcomes and own financial history | Own store's funding projection only | Explicit affiliate finance/reporting grant |
| `affiliate.payout.request` | Own wallet, bank destination and available-funds gate; tax identity gate only when `tax_identity_required_for_payout` is ON (default OFF, ADR-0012) | Denied | No implicit request on behalf of affiliate |
| `affiliate.identity.manage` | Submit own bank identity and a voluntary tax identity (required only when the payout policy flag is ON); masked subsequent reads | Denied | Dedicated restricted tax/finance review grant (`tax.identity.review`, Phase 2) |
| `affiliate.offers.manage` / `affiliate.blocks.manage` | Denied | Owner for own store; Manager/Staff only explicit grant | None: the console never edits seller offers or blocks (IAM-15 "Never available"); programme-wide limits via `affiliate.policy.manage` |
| `affiliate.accounts.review` / `affiliate.policy.manage` | Denied | Denied | Explicit platform grant for account approval/suspension and rate bounds |
| `affiliate.payout.process` / `tax.*` family (`tax.manage`, `tax.approve`, …) | Denied | Denied | Separate finance and tax grants (IAM-15, ADR-0012); `affiliate.payout.process` never implies any `tax.*`; tax-policy activation (Phase 2) needs advisor confirmation |

Capabilities above are proposed policy names, not implemented API scopes.
Server services recheck account status, ownership, seller opt-in/block and
effective policy at mutation/checkout time; stale catalog data or UI visibility
is not authority. Seller Owner receives no platform affiliate finance power.
Bank and phone masking happens in the data-access layer before serialization,
including RSC, API and export paths. Tax identity never enters ordinary
affiliate, seller, support or public catalog projections.

Seller policy/offer/block tables retain store RLS. Platform-owned affiliate
tables enforce authenticated affiliate-id predicates/RLS, not a fictional
seller `store_id`. Aggregate/catalog projection readers receive no direct
seller-table grant. Outbox consumers enter explicit store scope per event;
commission and payout workers have operation-scoped platform authority and
audited targets, not the unrestricted Owner console or database owner role.

## IAM-14 — Verified buyer portal and session boundary

- Status: Proposed
- Owner: Bukalaris security owner
- Source: PR-7, DATA-12, ADR-0010; IAM-4, PRIV-8.
- Statement: `buyer.bukalaris.com` is a separate buyer account/session surface.
  Passwordless phone/WA OTP or email magic-link proof is required before showing
  profile, addresses, history or tracking through the global account. A newly
  observed alias is not a login method: possession and account binding are
  separate checks. Closed/restricted identities and disputed/revoked identifiers
  cannot bypass recovery/history restrictions.
- Acceptance: Unknown/existing/conflicting contacts receive uniform public
  challenge/checkout responses. Missing, expired, reused or tampered proof and
  another buyer's identifier/order ID yield no private data. A confirmed buyer
  reads only its own authorized links across stores; seller A sees only A's
  snapshots; affiliate receives no buyer identity. Verification of an untrusted
  email alias alone never unlocks a phone owner's history.
- Constraints: IAM-5, IAM-7, IAM-9, TEN-1, PRIV-2, PRIV-8, ADR-0005, ADR-0010.

| Proposed capability | Buyer | Seller / Affiliate | Platform service |
|---|---|---|---|
| `buyer.profile.read` / `buyer.profile.write` | Own verified/bound context | Denied | No ordinary global-profile browsing |
| `buyer.addresses.manage` | Own address book after authentication | Denied | Purpose-scoped lifecycle processing only |
| `buyer.orders.read` / `buyer.tracking.read` | Confirmed own order links only | No new access beyond seller's existing own-order capability; affiliate denied | Bounded buyer-history projection, explicit buyer/store/order targets |
| `buyer.identifiers.manage` | Fresh proof plus account-binding authorization; no automatic merge | Denied | Restricted audited conflict/recovery service |
| `buyer.privacy.request` | Verified own export/closure request, subject to accepted PRIV-8 policy | Seller T-43 stays store-only; affiliate denied | Restricted purpose-scoped privacy processing |
| `buyer.identity.resolve` | Not a browser capability | Denied | Only target-bound checkout outbox resolver |

Buyer sessions use a distinct Secure HttpOnly host-only `__Host-bl_buyer` cookie
on the buyer host (no `Domain`), not a parent-domain cookie. They grant no Owner console, Seller Admin or affiliate access;
the same human/contact may hold those roles only through explicit separate
contexts. Keep CSRF/origin/callback allowlists narrow and require recent proof
for identifier binding, merge/recovery and privacy-sensitive changes.
Passwordless request/resend/verify/recovery limits are shared/atomic (RL-OTP-REQ,
RL-OTP-VERIFY in 16-OBSERVABILITY) and
identifier/operation/network scoped; challenges are short-lived and single-use.
OTP channel/provider, costs/availability, lifetimes, authenticated prefill,
merge UX and shared/recycled-number policy remain OPEN; no provider or numeric
default is selected by this proposal. T-36 status links remain single-order
capabilities and never create a global buyer session.

Retain ADR-0005's three DB roles: `bukalaris_owner` is migrations-only,
`bukalaris_app` buyer access uses verified transaction-local `app.buyer_id`
with FORCE RLS on buyer-owned records, and `bukalaris_platform` handles only
allowlisted target-bound identity/history/lifecycle operations. Seller
`app.store_id` alone grants no buyer profile access. `buyer_order_link.store_id`
is order provenance, not global-profile ownership. The platform role bypasses
RLS and therefore requires explicit service authorization/predicates; do not
claim buyer RLS protects an arbitrary platform-pool query.

## IAM-15 — Owner console staff, capabilities and account-management powers

- Status: Proposed (owner decisions 2026-10-27; startup-phase relaxation applies)
- Owner: Bukalaris security owner
- Source: PR-30, PR-15; IAM-1, IAM-5, IAM-8, IAM-10, IAM-13, IAM-14; code review `CRSEC-02`, `CRSEC-06`; [ADR-0011](ADR-0011-owner-console-scope-and-account-governance.md); T-60, T-62, T-63.
- Statement: The platform operator surface is the **Owner console** (formerly
  Super Admin / Bos; the interim host label `berkah` was never deployed), host `owner.bukalaris.com`. Its staff are `platform_operator`
  identities with explicit capabilities in `operator_grant` (T-60). Roles below
  are **presets** of capabilities for the grant screen; the server authorizes by
  capability only, re-read from the database on every request. The store-level
  role `owner` ("Pemilik toko", `membership.role`) is unrelated: platform side
  says "Owner console" or "platform owner", store side says "store owner"; a store
  owner never holds an Owner console capability and vice versa (ADR-0011 §1).
- Acceptance: For every capability below, Vitest proves allowed and denied
  server calls (no grant, wrong capability, revoked grant, expired grant, seller
  or affiliate or buyer session, store owner session) with no side effect and a
  denial audit row; Playwright proves the menu hides what the grant lacks and
  that a direct URL still returns the denied state. A role preset change does not
  change an existing grant. Granting or revoking a capability takes effect on the
  next request of the affected staff member, and revocation terminates queued
  approvals they requested. A route test derived from the `admin` directory fails
  when a page has no declared capability (unlisted routes fail closed).
  The matrix tests also prove: an identity with a `platform_operator` row is
  not-found for every `accounts.*` action; break-glass never satisfies a ◆
  approval; a payout cannot move to processing without a second approver and a
  bank-snapshot view by that approver; the bootstrap script refuses when two
  active `staff.manage` holders exist and writes `system_bootstrap` events.
- Constraints: IAM-5, IAM-7, IAM-9, IAM-10, SEC-11, PRIV-9, DATA-14, TEN-3.

### Capability catalogue (proposed names, not implemented scopes)

Existing names `logs.read`, `tenants.manage`, `audit.read` (IAM-8) and the
affiliate names of IAM-13 are kept. ◆ = four-eyes (a different staff member who
also holds the capability must approve; DATA-14 `approval_request`). P1 = startup
core (T-62/T-63 or the owning task), P2 = dormant until the Compliance center or
tax workflows are activated (ADR-0011 §3, ADR-0012).

| Family | Capabilities | Allows | Phase | ◆ |
|---|---|---|---|---|
| Overview | `dashboard.read` | Aggregate KPIs only, no personal data | P1 | |
| Stores | `tenants.read`; `tenants.manage` | Masked store list/detail; create, approve, suspend, reactivate with reason | P1 | |
| | `tenants.verify` | Record or review an optional store verification record; never gates activation | P1 (queue P2) | |
| Shipping, billing | `shipping.manage`; `billing.read`; `billing.manage` | Shipping setup, Bukalaris-generated Partner seller account sync, platform margin and shipping discount/cashback rules (SA-07); invoices; comp, bookkeeping mark-paid and plan price (the PPN switch is a `tax.manage` action, Tax row) | P1 | shipping margin, discount or cashback rule change, comp, mark-paid, plan price |
| Money | `finance.read` | Float, ledgers, reconciliation, masked banks | P1 | |
| | `payouts.process`; `refunds.process` | Seller payout and buyer refund decisions: **approve for transfer** (requested → processing; the approver sees the immutable bank snapshot), then record the transfer evidence (mark-paid, no second person); manual completion of a COD order | P1 | approve for transfer; manual COD completion |
| | `payouts.reconcile` | Prepare and approve a **COD reconciliation batch** (SA-53): release delivered COD sales to the seller's available balance after matching the carrier invoice lines and evidence references | P1 | batch approval (a second holder approves; the approver sees the carrier invoice lines) |
| | `ledger.adjust` | Manual adjustment entry | P1 | always |
| Affiliates | `affiliate.accounts.read`; `affiliate.accounts.review`; `affiliate.policy.manage`; `affiliate.payout.process`; `affiliate.disputes.manage` | Masked affiliate list; approve/reject/suspend/reactivate (suspension unpublishes the storefront and deactivates links, IAM-13); rate bounds, `affiliate_hold_days` (default 3 days) and programme policy; payout approve for transfer and evidence; dispute and fraud decisions | P1 (disputes P2) | payout approve for transfer; rate bounds and hold days |
| Accounts | `accounts.read` | Masked search and detail of any account kind | P1 | |
| | `accounts.support` | Send recovery link to the verified contact (disabled until the `mail_outbox` fix, ADR-0011 §4), revoke sessions, request MFA reset, resend verification; never on an identity that has a `platform_operator` row | P1 | MFA reset for store-owner and affiliate accounts |
| | `accounts.suspend` | Suspend or restore an auth identity (never one that has a `platform_operator` row); restrict a buyer account | P1 | account closure |
| | `accounts.identifiers.review` | Review buyer identifier conflicts (ADR-0010 recovery service); staff-executed buyer merge is **decided disabled in Phase 1** (not-found; buyers merge only via self-service proof of both identifiers, D6) | P1 (staff merge disabled) | merge execution (if enabled later) |
| | `accounts.reveal` | Field-level reveal under PRIV-9 (purpose and case required); includes the per-store breakdown of a buyer's linked orders | P1 | |
| | `members.recover` | Staff-executed store ownership recovery; **decided disabled in Phase 1** (the route returns not-found; locked-out sellers use self-service recovery only, D6) | P1 (route disabled) | always |
| Cases | `cases.read`; `cases.write` | Cases, notes, assignment, due dates | P1 | |
| Content and compliance | `moderation.manage`; `complaints.manage`; `privacy.requests.manage`; `incidents.manage`; `compliance.read` | Takedown notices, complaints, privacy requests, incident register, registrations/retention | P2 | |
| | `privacy.export.approve` | Release a per-subject export | P2 | always |
| Tax | `tax.read`, `tax.manage`, `tax.approve`, `tax.remit`, `tax.documents.issue`, `tax.identity.review`, `tax.period.close` | As defined by ADR-0012/UX-23; `payouts.process` and `affiliate.payout.process` never imply any `tax.*`. Startup subset: `tax.manage` also holds the **subscription PPN switch**, an Owner console toggle (OFF by default) with a confirmation dialog that states the effect on new invoices and that legal and tax documents and PKP status are the Owner's responsibility; required reason, audited; applies to new invoices only and never rewrites issued ones; the rate is a policy value entered with an effective date, never a constant; there is no hard PKP gate (owner decision D4); it is deliberately **not four-eyes** (reversible for future invoices, no money moves; revisit if the security owner judges otherwise) | startup subset per UX-23, rest P2 | `tax.approve`, `tax.remit`, `tax.period.close` reopen |
| Platform | `settings.manage`; `providers.read`; `providers.manage` | Reserved labels, host config, rate limits; provider health without secrets; credential rotation | P1 | credential rotation |
| Operations | `logs.read`; `ops.read`; `audit.read`; `audit.export` | Log System; job, outbox, webhook and backup status; audit viewer; audit export | P1 (export P2) | export |
| | `ops.issues.report`; `ops.issues.manage` | File an issue report from any console page (default for every active staff member, revocable, no read access to the queue); triage, assign, read and export the issue queue (reads and exports audited) | P1 | |
| | `ops.issues.attachments` | **Phase 2 option, dormant**: open an issue-report attachment under PRIV-9 purpose rules (purpose, case, access event). No attachment exists in Phase 1 (decided, UX-22) | P2 | |
| | `ops.jobs.manage` | Requeue or cancel a dead job of a replay-safe kind and run a projection rebuild (audited with a reason; money kinds are reconciled by their owning service, never blindly requeued, 16-OBSERVABILITY OBS-7) | P1 | |
| Platform updates | `updates.write`; `updates.publish` | Create and edit Update Log drafts and revisions; schedule, publish, publish an update to a live entry, unpublish (separate from write; optional four-eyes by platform setting, default off) | P1.5 optional | optional |
| Staff | `staff.read`; `staff.manage`; `access.review`; `break_glass.approve` | Staff list; invite, deactivate, grant, revoke; the only path to reset a staff member's MFA; periodic review; approve break-glass | P1 | sensitive grants, break-glass, staff MFA reset |

**Sensitive grants** (every ◆ capability, `accounts.reveal`, `staff.manage`,
`break_glass.approve`, `audit.export`) are granted only through an approved
request (`grant.sensitive`); the approver holds `staff.manage` and is neither the
requester nor the grantee. **Break-glass** (PRIV-9) is limited to an allowlist of
read and reveal capabilities (`accounts.read`, `accounts.reveal`, `finance.read`,
`tax.read`); it never confers `staff.*`, `break_glass.*`, `audit.*`,
`ledger.adjust` or any write capability, and an active break-glass elevation
never counts as holding a capability when approving a ◆ action.

### Role presets

| Preset | Typical capabilities | Not included |
|---|---|---|
| Platform owner | Every P1 capability; may approve ◆ actions as a second person | No bypass of four-eyes, no self-approval, no password or session powers |
| Operations manager | `dashboard.read`, `tenants.*`, `shipping.manage`, `billing.read`, `cases.*`, `accounts.read/support`, `settings.manage`, `ops.read`, `logs.read`, `ops.issues.manage` | Money processing, reveal, staff management |
| Support agent | `dashboard.read`, `tenants.read`, `accounts.read/support`, `cases.*`, `billing.read` | Suspend, reveal, money |
| Finance operator | `finance.read`, `payouts.process`, `payouts.reconcile`, `refunds.process`, `billing.read/manage`, `affiliate.payout.process` | Tenant lifecycle, account support, tax |
| Affiliate manager | `affiliate.accounts.*`, `affiliate.policy.manage`, `affiliate.disputes.manage`, `cases.*` | Payout processing |
| Engineer | `logs.read`, `ops.read`, `providers.read`, `ops.issues.manage`, `ops.jobs.manage` | Any tenant, account or money capability |
| Auditor | `audit.read`, read-only `*.read` | Every write |
| Tax and compliance officer (P2) | `tax.*`, `compliance.read`, `moderation.manage`, `complaints.manage`, `privacy.requests.manage`, `incidents.manage` | Money processing |

A one-person startup team may hold several presets but **must not** approve its
own ◆ requests: such actions wait for a second staff member. The small-team
fallback (for example a delayed, post-hoc reviewed single approver) is OPEN and
not adopted. A numeric amount threshold below which one approver suffices for
money actions is likewise OPEN; until set, every listed ◆ action needs a second
person.

### Four-eyes matrix (single source)

This table is the only definition of which actions need a second person. The
DATA-14 `four_eyes_rule` table is seeded from it and the CHECK on
`support_action`/`approval_request` is derived from it (a migration changes the
matrix, reviewed by the security owner). The approver is a different active staff
member who **holds the capability in the second column** through a standing grant
(break-glass never counts); the approval binds the exact payload hash, expires, and
the action re-checks the capability at execution.

| Action key | Capability both people hold | Action | Phase |
|---|---|---|---|
| `grant.sensitive` | `staff.manage` | Grant a sensitive capability | P1 |
| `breakglass.approve` | `break_glass.approve` | Approve a break-glass elevation | P1 |
| `payout.approve_transfer` | `payouts.process` | Seller payout requested → processing (bank snapshot shown to the approver); mark-paid then records evidence only | P1 (T-37) |
| `refund.approve_transfer` | `refunds.process` | Buyer refund approved for transfer | P1 (T-37) |
| `affiliate_payout.approve_transfer` | `affiliate.payout.process` | Affiliate payout approved for transfer | P1 (T-53) |
| `cod.manual_complete` | `payouts.process` | Manual completion of a COD order without the provider's DELIVERED status; evidence required; the seller can never complete for credit | P1 (T-37) |
| `cod.reconcile_release` | `payouts.reconcile` | Approve a COD reconciliation batch that releases delivered, reconciled COD sales; evidence references and carrier invoice lines are shown to the approver; nothing auto-releases | P1 (T-37) |
| `ledger.adjust` | `ledger.adjust` | Any manual ledger adjustment, with a case | P1 |
| `billing.comp`, `billing.mark_paid`, `billing.plan_price` | `billing.manage` | Comp a store, bookkeeping mark-paid of an invoice, change plan price | P1 |
| `shipping.margin` | `shipping.manage` | Change the platform shipping margin, shipping discount or cashback split rules (SA-07) | P1 |
| `affiliate.rate_bounds` | `affiliate.policy.manage` | Change programme rate bounds or the affiliate hold period (`affiliate_hold_days`, default 3 days) | P1 |
| `providers.rotate` | `providers.manage` | Record a provider credential rotation | P1 |
| `mfa.reset` | `accounts.support` (store-owner and affiliate targets) or `staff.manage` (staff targets) | Reset a second factor. A non-owner seller team member's reset is a single-approver action with case, reason and notice to the previous contact | P1 |
| `account.close` | `accounts.suspend` | Close an account through a privacy case | P1 |
| `merge.execute` | `accounts.identifiers.review` | Staff-executed buyer merge; **decided disabled in Phase 1** (D6; buyers merge only via self-service proof of both identifiers) | P1 (disabled) |
| `ownership.recover` | `members.recover` | Staff-executed store ownership recovery (`support_action` kind `recover_ownership`); **decided disabled in Phase 1** (D6; self-service recovery only) | P1 (disabled) |
| `privacy.export` | `privacy.export.approve` | Release a per-subject export | P2 |
| `audit.export` | `audit.export` | Export audit rows | P2 |
| `tax.approve`, `tax.remit`, `tax.period_reopen` | the matching `tax.*` capability | As ADR-0012/UX-23 | P2 |
| `updates.publish` | `updates.publish` | Publish an Update Log entry; off by default, a platform setting turns it on (consider turning it on for category `security`) | P1.5 optional |

Staff identities (any identity with a `platform_operator` row) are **excluded
from every `accounts.*` and `affiliate.accounts.*` capability**: the server
answers not-found, so a support agent cannot weaken a console MFA or restore a
suspended staff member. They are handled only through `staff.manage` (grant,
deactivate, session revoke, MFA reset ◆). Staff using separate operator
identities is the rule; with the separate operator auth instance of the ADR-0005
amendment it is structural, not a convention.

### Console bootstrap and recovery

Sensitive grants need an approver who already holds `staff.manage`, so the first
holders cannot be created in the product. Bootstrap and recovery are out-of-band:

- **Two named people** (recorded in the RUNBOOK, not in the repository secrets) run
  a documented script under the owner/DBA role. It creates the first
  `platform_operator` identities and grants `staff.manage` and
  `break_glass.approve`, writing one `operator_grant_event` per grant with source
  `system_bootstrap` (recovery: `system_recovery`) and no approval request. The
  script refuses to run while two or more active `staff.manage` holders exist.
- After bootstrap the product enforces the matrix; the last active holder of
  `staff.manage` cannot be removed (UX-22). Recommended, not decided: keep at
  least two active holders so a lost TOTP device does not need recovery.
- A staff member's MFA is reset only through `staff.manage` with four-eyes
  (`mfa.reset`). If no holder can sign in, the same out-of-band script is the only
  path, again by two named people, again recorded as `system_recovery`.
- Bootstrap and recovery events appear in the audit viewer and notify every
  `audit.read` holder; they are reviewed at the next access review.

### Account-management powers by account kind

| Action | Seller team member | Affiliate account | Buyer account |
|---|---|---|---|
| View masked detail | `accounts.read` | `affiliate.accounts.read` | `accounts.read` |
| Suspend, restrict | `accounts.suspend` (identity; membership removal stays a store-owner action) | `affiliate.accounts.review` with reason; unpublishes the storefront, deactivates links, stops new attribution, never deletes earned money | `accounts.suspend` sets restricted state (ADR-0010); never merges or deletes |
| Recovery | `accounts.support` recovery link to the verified contact; operator never sees the link | same | Through the restricted ADR-0010 recovery service, `accounts.identifiers.review`; no OTP or link shown |
| Revoke sessions | `accounts.support` | `accounts.support` | `accounts.support` |
| MFA reset | Request via `accounts.support`; ◆ for a store owner (non-owner member: single approver with case, reason, notice) | ◆ (`mfa.reset`), then the payout and bank hold of IAM-9 | Not applicable (passwordless proof) |
| Identifier change or merge | Contact change only through the user's own verified flow with step-up (IAM-9) | Same | Buyer merges only through **self-service proof of both identifiers** (phone and email); staff-executed merge is **decided disabled in Phase 1** (D6) |
| Reveal masked field | `accounts.reveal` under PRIV-9 | same | same |
| Closure and erasure | Only through a privacy case (PRIV-4, PRIV-8); no delete button | Same | Same |
| Store ownership recovery (staff-executed) | `members.recover` ◆; **decided disabled in Phase 1** (D6; see "Ownership recovery and merge in plain terms" below) | n/a | n/a |
| Staff identity (has a `platform_operator` row) | Not a target of any `accounts.*` action; `staff.manage` only | n/a | n/a |

**Ownership recovery and merge in plain terms (decided, D6: disabled in Phase 1).**
*Store-ownership recovery* means a staff member changes **who owns a store**
(for example when the only owner lost the email and phone). *Buyer merge* means
a staff member joins two buyer accounts into one, so one person sees the other
account's order history. Both are powerful: the abuse scenario is a staff
member being socially engineered (or colluding) into handing a store, its
payouts, or a buyer's whole order history to the wrong person. **Decided for
Phase 1:** both staff-executed actions stay **disabled** (the routes return
not-found):
- **Locked-out sellers use self-service recovery only**, which never needs staff
  to change ownership: reset through the registered email or a phone OTP, and
  MFA recovery codes issued at enrolment. Staff can only send the recovery link
  to the verified contact on file (`accounts.support`) and revoke sessions.
- **Buyer accounts merge only via self-service proof of both identifiers**
  (possession proof of the phone and of the email), executed by the buyer's own
  verified flow, never as a staff edit.
If a future phase ever enables a staff-executed path, it must first record an
evidence standard (what proof is required, who checks it, notice to the
verified contact, a cooling-off period, and a freeze on bank changes and payouts
after recovery).

**Never available, to any capability:** view, set, reset-and-display or reuse
a password or recovery code; read session tokens or OTP/magic-link material;
sign in as, impersonate or mint a session on another host (IAM-10 stays "no
impersonation"); edit a seller's catalog, orders or settings; change an
affiliate's wallet or a seller's ledger except through the named money
capabilities; create an Owner console account through a public path.

### Session and authentication

- Owner console sessions require MFA (TOTP enrolled before any console data is
  shown), use a Secure HttpOnly **host-only** `__Host-bl_owner` cookie on
  `owner.bukalaris.com` (no `Domain`) with a distinct audience, and are never
  accepted by seller, affiliate, buyer or checkout hosts, nor are theirs accepted
  here (`CRSEC-02`, IAM-9). Decided (owner, 2026-10-28, D-20): the Owner console uses a
  separate operator auth instance with its own tables (ADR-0005 amendment,
  decision 6).
- A dead-but-valid cookie (operator removed, grant revoked) routes to sign-out,
  not to a redirect loop; the layout re-reads the operator row on every request.
- Sensitive actions (◆ requests and approvals, grants, break-glass, reveals)
  require re-authentication within a fresh-authentication window. Window length,
  idle timeout and absolute session lifetime are OPEN and chosen under IAM-9;
  tests use the configured value, never a literal.
- Every write passes one capability gate and writes its audit row (actor,
  capability, target kind and id, case, reason code, outcome) in the same
  transaction; if the audit row cannot be written the action is refused (SEC-11).
  Reasons are required, length-bounded and scrubbed; empty reasons are rejected.
- Staff off-boarding revokes grants, pending requests and sessions in one
  transaction. Periodic access review (`access.review`) lists every grant with
  last use; the review interval is OPEN.

## Named admin authentication boundary

Decision: the Owner console is the platform operator surface (formerly Super
Admin / Bos; host `owner.bukalaris.com`); Seller Admin is the store administration surface (`/seller`).
Use maintained authentication tooling compatible with the selected Next.js
runtime; confirm invitation, recovery, session revocation and MFA support before
selecting the adapter. Do not implement custom password cryptography.

Proposal: Separate operator and merchant session namespaces, host-only cookies,
trusted-origin allowlists and permission checks. A Seller Admin login cannot grant
Owner console access. Store switching revalidates membership and discards prior store
client caches. Platform access requires MFA and reauthentication for sensitive
changes. Do not grant a public operator signup path. Auth remains an explicit
implementation gate; a chosen framework does not prove these controls exist.
Capabilities, roles and four-eyes rules for the Owner console are specified in
IAM-15.

Change history (IAM-15 and related, 2026-10-27 documentation audit pass): one
four-eyes matrix, four-eyes on the money decision instead of mark-paid (audit
SPV-05, SPV-10); staff identities excluded from `accounts.*` (SPV-07);
bootstrap and recovery (SPV-06); break-glass allowlist (SPV-11); recovery and
merge disabled until a standard is recorded (SPV-08); step-up and affiliate
authentication (SPV-04); Owner-console write paths aligned with IAM-15
(SPV-15); `__Host-` cookies (SPV-16); "Tenant Admin" renamed Seller Admin.

