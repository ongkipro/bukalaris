# Bukalaris IAM, RBAC, and ABAC

## IAM-1 — Identity separation

- Owner: Bukalaris security owner

The platform distinguishes Super Admin, Seller membership, Buyer, Affiliate,
and service identities. One human may hold more than one role, but a session
must have an explicit active context; browser UI visibility is never authority.

## IAM-2 — Seller capability model

- Owner: Bukalaris product owner

| Role | Scope | Allowed job |
|---|---|---|
| Seller Owner | Assigned store | Membership, billing-visible settings, all seller operations |
| Seller Manager | Assigned store | Catalog, content, orders, fulfillment; no ownership transfer |
| Seller Staff | Assigned store | Explicitly granted catalog/order/content capabilities |
| Super Admin | Platform | Tenant lifecycle, marketplace review, platform configuration |
| Support operator | Platform, temporary target | Read/support only through approved audited impersonation |

## IAM-3 — Marketplace and affiliate policy

- Owner: Bukalaris product owner

- Seller may submit only its own active product for marketplace review.
- Marketplace approval/rejection requires a Super Admin capability and an audit
  reason. It is not editable by the seller after decision without resubmission.
- Affiliate may read only its own aggregate, policy-approved referral outcome;
  it may not view buyer PII, order addresses, or other affiliate data.

## IAM-4 — Buyer model

- Owner: Bukalaris security owner

Buyer account is optional in Phase 1. Guest checkout creates an order contact
projection, not an automatic account. Linking an existing order to a later
buyer identity requires a verified recovery/ownership mechanism decided by the
security owner.

## Required controls

| ID | Owner | Statement | Evidence |
|---|---|---|---|
| IAM-5 | Bukalaris security owner | Sensitive role, membership, suspension, and impersonation changes require a durable audit record. | Negative/positive authorization tests |
| IAM-6 | Bukalaris security owner | Session and recovery design shall be selected from the verified repository stack; no credential/token format is assumed here. | Stack review before implementation |
| IAM-7 | Bukalaris security owner | Service identities have operation and tenant scope narrower than human Super Admin access. | Integration/job authorization tests |

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
| orders.read / orders.fulfill | Own store | Own store | Separate explicit grants | Scoped support grant only |
| domains.manage | Own store | Explicit grant | Denied by default | Operational capability only |
| members.manage | Own store | Denied | Denied | Separate recovery policy |
| integrations.manage | Own store | Denied by default | Denied | Dedicated restricted capability |
| tenants.manage | Denied | Denied | Denied | Explicit platform grant |
| logs.read | Denied | Denied | Denied | Explicit platform grant |
| audit.read | Denied for platform audit | Denied | Denied | Separate audit grant |

Seller access to any future store-specific activity view is a separate scoped
projection, never access to platform logs. Platform role assignment cannot be
performed through seller membership endpoints. Integration configuration never
returns stored secret values to the browser. Deferred marketplace/affiliate
capabilities are not activated by these Phase 1 roles.

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

Future external API/MCP grants must support least privilege, expiry/revocation,
store binding, and an audit trail. They cannot inherit unrestricted Super Admin
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
Super Admin diagnostics and system-map access use separate platform grants.

## Named admin authentication boundary

Decision: Bos is the platform operator surface; Tenant Admin is the tenant admin.
Use maintained authentication tooling compatible with the selected Next.js
runtime; confirm invitation, recovery, session revocation and MFA support before
selecting the adapter. Do not implement custom password cryptography.

Proposal: Separate operator and merchant session namespaces, host-only cookies,
trusted-origin allowlists and permission checks. A Tenant Admin login cannot grant
Bos access. Store switching revalidates membership and discards prior store
client caches. Platform access requires MFA and reauthentication for sensitive
changes. Do not grant a public operator signup path. Auth remains an explicit
implementation gate; a chosen framework does not prove these controls exist.

