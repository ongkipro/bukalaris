# Bukalaris Security Architecture

| ID | Owner | Control | Status |
|---|---|---|---|
| SEC-1 | Bukalaris security owner | Tenant, object, and function authorization fail closed on server and database boundaries. | Proposed |
| SEC-2 | Bukalaris security owner | All writes validate untrusted input and derive money/stock/tenant decisions server-side. | Proposed |
| SEC-3 | Bukalaris security owner | Host resolution is normalized, reserved-label aware, and cannot be chosen by a browser path/body field. | Proposed |
| SEC-4 | Bukalaris security owner | Checkout/payment/shipment provider actions are idempotent and safe under replay/timeout. | Proposed |
| SEC-5 | Bukalaris security owner | Provider keys are server-only, least-privilege, redacted, and rotated through the selected secret system. | Proposed |
| SEC-6 | Bukalaris security owner | Webhook authenticity is verified before parsing or side effects; accepted events are durable-deduplicated. | Proposed |
| SEC-7 | Bukalaris security owner | Super Admin, impersonation, role, suspension, financial, and marketplace-review changes produce protected audit records. | Proposed |

## Threat priorities

1. Cross-tenant data/action access through IDs, caches, background jobs,
   exports, media, or root tenant records.
2. Money/inventory manipulation through client totals, repeated checkout,
   provider timeouts, or replayed callbacks.
3. Account takeover and privilege escalation through weak session/recovery,
   invitation, or impersonation flow.
4. Provider-secret exposure through browser code, logs, diagnostics, or error
   payloads.
5. Host-header/domain takeover and published seller content abuse.

## Required engineering rules

- Object authorization is checked after authentication and before mutation.
- Rate limits cover identity, tenant, operation, trustworthy network signal,
  payload size, and provider concurrency constraints; values await measurement.
- CORS is exact-origin; credentialed wildcard origins are forbidden. Headers,
  CSP, upload/content handling, and cookies are verified in the eventual
  runtime rather than assumed from source.
- Audit records are authoritative business/security evidence, not sampled logs.
- Raw payment/auth payloads, cookies, tokens, keys, and unnecessary PII never
  enter ordinary logs/traces. Failures return stable safe messages.

## Phase 1 trust-boundary register

All following controls are proposed requirements, not findings of deployed
vulnerabilities. Sources are the accepted product requirements and the linked
internal contracts; runtime/provider-specific implementation awaits T-1/T-5.

| Asset / boundary | Adversarial or failed input | Authoritative control | Minimum proof |
|---|---|---|---|
| Seller records | Foreign numeric ID, role field, stale membership | Tenant + object + writable-field policy | Authorized success; foreign write has no effect |
| Public content | Draft ID, hostile HTML/link, shared cache entry | Published projection + safe rendering + store cache partition | Draft absent; injected content inert; no cross-store response |
| Order/payment | Changed total, repeated request, unknown provider result | Server calculation + durable operation identity + reconciliation | Repeated logical action has one commercial effect |
| Domain binding | Spoofed forwarded host, duplicate/reassigned domain | Trusted proxy chain + verified binding + atomic ownership | Unknown/reassigned host cannot serve prior store |
| Operator/log viewer | Seller login, broad query, raw sensitive event | Platform capability + safe bounded query projection | Denied access and redaction at sink and UI |
| Jobs/webhooks | Replay, mismatched provider account, stale intent | Verified account/event + stored linkage + policy | Invalid input has no effect; duplicate is harmless |

## SEC-8 — Safe publishing and uploads

- Status: Proposed
- Owner: Bukalaris security owner
- Source: PR-2, PR-3, PR-9; SEC-2.
- Statement: Validate content structure and asset references, escape output by
  context, and sanitize supported rich text. Seller data is never evaluated as
  server code. Phase 1 exposes no arbitrary script/HTML theme editor. Future LP
  freedom applies to composition and presentation, not unrestricted execution.
- Acceptance: Malicious rich text, links, filenames, MIME mismatches, oversized
  files, and foreign private assets fail safely. Uploaded active formats require
  explicit sanitization/isolation policy; otherwise reject them. Bound bytes,
  dimensions, processing time, and count before expensive processing.

Remote image/document import is disabled unless needed. If enabled, a dedicated
bounded fetch path checks destinations, redirects, resolved addresses, and
response size to prevent private-network or metadata access.

## SEC-9 — Browser and public API boundary

- Status: Proposed
- Owner: Bukalaris security owner
- Source: IAM-9, API-1, DOM-3.
- Statement: Cookie-authenticated writes use the selected framework's CSRF
  protection; session cookies are Secure, HttpOnly, narrowly scoped, and have
  deliberate SameSite/lifetime settings. CORS allows only required exact origins
  and is never authorization. Public API credentials are not browser secrets.
- Acceptance: Cross-origin hostile writes fail; valid intended storefront
  operations succeed on subdomain and custom-domain paths. Test CSP, framing,
  content-type, and referrer policy on the deployed serving layers in a browser.
  Admin cookies never reach seller-controlled unrelated domains.

## SEC-10 — Operation safety and secure errors

- Status: Proposed
- Owner: Bukalaris security owner
- Source: PR-4, PR-5, PR-11; OBS-3, NFR-4.
- Statement: Enforce bounded request bodies, pagination, export size, concurrent
  jobs, and retries at authoritative boundaries. Return stable safe error codes
  and a correlation ID without stack traces, SQL, secrets, or customer data.
- Acceptance: Rate-limit responses distinguish retryable throttling from
  authorization denial. An invalid signature or scope causes no side effect.
  A provider timeout produces pending reconciliation, never a guessed success
  or automatic second financial instruction.

## SEC-11 — Credentials and audit integrity

- Status: Proposed
- Owner: Bukalaris security owner
- Source: SEC-5, SEC-7, IAM-5, OBS-5.
- Statement: Separate environments and least-privilege service credentials;
  select storage/rotation before integration. Application actors cannot rewrite
  audit history. Sensitive mutations and their audit intent are committed
  atomically, with reliable delivery if the audit sink is separate.
- Acceptance: Browser responses, bundles, error messages, diagnostics, and
  exports contain no credential material. Audit delivery failure cannot silently
  lose the actor/action/target/outcome of a privileged change. Secret rotation
  and revocation have named owners and a bounded recovery procedure.

## SEC-12 — Security release evidence

- Status: Proposed
- Owner: Bukalaris verification owner
- Source: NFR-1, NFR-2, NFR-4; TEN-6.
- Statement: Before a pilot, execute allowed/denied tenancy and capability
  tests, dependency/secret review, publishing safety, webhook/retry checks,
  domain reassignment checks, and synthetic log-redaction checks relevant to
  enabled functionality. Select tools only after inspecting the real stack.
- Acceptance: Evidence records code revision, environment, scenario, outcome,
  and unresolved risks. A document checklist or successful build does not count
  as runtime security proof. No product security tests have run in this pass.

## SEC-13 — Hosted checkout handoff
- Status: Proposed
- Owner: Bukalaris security owner
- Source: PR-16, IAM-11.
- Statement: Issue an opaque, short-lived, one-use handoff bound to the store,
  cart, channel, revision and registered return target. Do not place cart/API
  credentials or buyer data in that URL. Exchange atomically for a checkout
  session; immediately clean the URL. No third-party scripts/assets load before
  exchange; use no-store and no-referrer and redact query strings at every hop.
- Acceptance: Expired/replayed/foreign-store handoffs are denied, return paths
  cannot redirect to arbitrary origins, and checkout never imports storefront
  scripts/styles. Refresh after exchange resumes the session. Lost/expired
  handoff recovers through the originating cart without duplicate orders.
- Constraints: TEN-1, IAM-11, API-8, NFR-2, NFR-4.

URL-based handoff is a deliberately narrow exception to the no-secret-in-URL
rule, requiring the controls above; long-lived credentials remain prohibited.
Code issuance is not a payment/stock reservation. Final submission revalidates
prices, stock and cart revision; external mutations cannot alter a committed
checkout snapshot. Provider return URLs do not prove payment success.

## M2 security review findings — 2026-10-06

Scope: `main` after the T-21 merge plus the M1 code; reviewer: implementing
orchestrator. Observed facts only; each finding has a remediation task.

| ID | Owner | Finding (observed) | Risk | Task |
|---|---|---|---|---|
| SEC-14 | Bukalaris security owner | `apps/web/next.config.ts` sets no response security headers (no CSP, `frame-ancestors`/X-Frame-Options, HSTS, `X-Content-Type-Options`, Referrer-Policy, Permissions-Policy); `X-Powered-By` is on by default | Clickjacking of hosted checkout and admin; weaker XSS containment | T-29. **Resolved by** `m2/hardening` (2026-10-07): nonce CSP (`script-src`/`style-src` nonce + `'strict-dynamic'`, `frame-ancestors 'none'`, `form-action 'self'`, `object-src 'none'`) in `apps/web/src/proxy.ts`, static headers (nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options DENY) in `next.config.ts`, `poweredByHeader: false`, HSTS behind `ENABLE_HSTS=1` + HTTPS; asserted by `apps/web/e2e/security-headers.spec.ts`; values in `docs/tracks/hardening.md` |
| SEC-15 | Bukalaris security owner | `pnpm audit --prod` (2026-10-06): 1 high (`braces` ≤3.0.3 via the `shadcn` CLI, which is listed as a runtime dependency of `apps/web`) and 1 moderate (`esbuild` ≤0.24.2 via `better-auth` → `drizzle-kit` → `@esbuild-kit/*`, dev-server only). Build-time tooling sits in the production dependency tree | Supply-chain surface in production installs; audit noise hides real issues | T-29. **Resolved by** `m2/hardening` (2026-10-07): `shadcn` is a devDependency (high advisory gone); `pnpm audit --prod` = 1 moderate (esbuild dev-server flaw via `better-auth` → optional peer `drizzle-kit`, resolved only through pnpm workspace peer dedupe; absent from the standalone output and image — recorded with reachability in `docs/tracks/hardening.md`); CI gains `pnpm audit --prod --audit-level high` (blocking) + full report (non-blocking) |
| SEC-16 | Bukalaris security owner | Hosted checkout and cart mutations have no rate limit or bot friction; a cart may hold unlimited lines; abandoned carts are never deleted | Order-spam/COD fraud that locks stock (stock is decremented at submit, D-5), database growth | T-30 |
| SEC-17 | Bukalaris security owner | Catalog and price changes (`updateProduct`, `updateVariant`, `addVariant`) write no audit record; only membership, store status and order/stock changes are audited | No accountability for price manipulation by a compromised staff account | T-31 |
| SEC-18 | Bukalaris architecture owner | Post-commit side effects (payment instruction, future notifications/signals) run inline after the transaction with no retry or outbox | Lost side effects on crash; duplicate effects if naively retried | T-32 |
| SEC-19 | Bukalaris privacy owner | Buyer name, phone and address are stored indefinitely with no retention, export or deletion path | PRIV-4 / UU PDP obligations unmet before pilot | T-33 |
