# Bukalaris Tenant Isolation Contract

## TEN-1 — Server-derived tenant scope
- Status: Proposed
- Owner: Security owner
- Statement: Every seller-facing read/write derives tenant and store scope from
  the authenticated membership and server route context, never from a browser
  supplied tenant identifier.
- Acceptance: Replacing IDs in URLs, bodies, jobs, exports, media references,
  cache keys, or pagination cursors cannot reveal/change another tenant's data.

## TEN-2 — Host-derived storefront scope
- Status: Proposed
- Owner: Platform owner
- Statement: Each storefront request maps a normalized allowed host to one
  active store before catalog/content access. The host mapping is not inferred
  from a path or client-selected store ID.

## TEN-3 — Database enforcement and defense in depth
- Status: Proposed
- Owner: Data owner
- Statement: Application authorization and database-level tenant policy both
  enforce applicable tenant boundaries. Cross-tenant platform jobs use a narrow
  privileged identity and record their reason/actor.

## Scope matrix

| Operation | Tenant source | Database enforcement | Audit |
|---|---|---|---|
| Seller CMS CRUD | Authenticated membership | Tenant policy + ownership predicate | Sensitive change |
| Storefront catalog | Validated host mapping | Scoped read path | Host resolution failure |
| Checkout/order | Cart/store context + product records | Store-bound constraints | State transitions |
| Super Admin | Platform role plus explicit target | Restricted service path | Every mutation/impersonation |
| Provider job | Stored order/store linkage | Worker scoped record access | Request/result/outcome |
| Export/media | Server-issued scoped resource | Tenant-aware object/database key | Export/download event |

## Prohibited patterns

- A generic `tenant_id` sent by the browser selects database scope.
- Cache keys omit store/host/locale/currency context.
- A background worker or export bypasses membership policy without a service
  identity, target scope, and audit event.
- A test only proves tables conventionally named with `store_id`; the tenant
  root and indirect ownership tables require explicit coverage too.

## Required proof

Before release, test the same operation with authorized and foreign tenant
identities, with a foreign object ID, and through every non-HTTP pathway that
can access the object (job, export, media, provider callback). Coverage must
include the tenant root and indirect ownership relationships in the eventual
Bukalaris schema.

## TEN-4 — Scope propagation across entry points

- Status: Proposed
- Owner: Bukalaris security owner
- Source: PR-2, PR-3, PR-4, PR-9, PR-12, PR-13; TEN-1 through TEN-3.
- Statement: Seller UI, headless API, future MCP, jobs, exports, and callbacks
  use the same authoritative tenant/object policies. A public numeric product
  ID is a locator, never a credential. A requested store selector is checked
  against trusted membership before becoming execution context.
- Acceptance: Same-role actors in two stores cannot read unpublished content,
  edit products, retrieve orders, download exports, or publish another store's
  revisions. Public catalog reads reveal only the host-bound published view.

| Boundary | Required scope and invalidation |
|---|---|
| Seller request | Active account, active membership, capability, target store, object ownership |
| Public storefront | Normalized trusted host binding, active serving policy, published projection |
| Cache/search | Store and publication revision; no private responses in shared public cache |
| Media/export | Scoped object metadata and authorization; public published media distinguished from private exports |
| Queue/retry | Stored tenant + operation + object reference; worker validates linkage and current operation eligibility |
| Provider event | Verified provider/account binding maps to stored local operation; body metadata alone is insufficient |
| Future MCP | Credential scopes intersect active membership and operation capability |

Membership removal and suspension invalidate cached authorization and block new
prohibited work. Essential reconciliation of existing payment/shipment work may
continue under a narrow service policy; suspension must not erase financial
history or suppress needed provider evidence.

## TEN-5 — Relationships and uniqueness

- Status: Proposed
- Owner: Bukalaris data owner
- Source: DATA-1, DATA-2, DATA-5; TEN-3.
- Statement: Product/variant, cart/line, order/line, page/revision, media reference,
  and domain/store relationships cannot cross stores. Enforce constraints where
  the selected database supports them and document the authoritative remaining
  check. Store-local uniqueness is explicitly scoped; global public identity
  uniqueness follows DATA-5. Numeric IDs do not imply an isolation boundary.
- Acceptance: A write with valid individual IDs but mismatched store ownership
  fails without partial rows or external work. Duplicate/parallel writes preserve
  the declared uniqueness and idempotency contract.

## TEN-6 — Isolation evidence matrix

- Status: Proposed
- Owner: Bukalaris verification owner
- Source: NFR-1, SEC-1; TEN-1 through TEN-5.
- Statement: Release evidence covers each active entry point with authorized,
  foreign-tenant, revoked-membership, and suspended-store cases as applicable.
- Acceptance: Use at least two stores with same-role actors and real isolated
  database constraints. Verify no protected rows, response fields, cache results,
  files, or provider side effects escape the boundary. Future-only entry points
  are recorded as not implemented, not counted as passing evidence.

No runtime tenant test has been executed for this proposed pack.
