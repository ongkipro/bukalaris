# Bukalaris Security Architecture

| ID | Owner | Control | Status |
|---|---|---|---|
| SEC-1 | Bukalaris security owner | Tenant, object, and function authorization fail closed on server and database boundaries. | Proposed |
| SEC-2 | Bukalaris security owner | All writes validate untrusted input and derive money/stock/tenant decisions server-side. | Proposed |
| SEC-3 | Bukalaris security owner | Host resolution is normalized, reserved-label aware, and cannot be chosen by a browser path/body field. | Proposed |
| SEC-4 | Bukalaris security owner | Checkout/payment/shipment provider actions are idempotent and safe under replay/timeout. | Proposed |
| SEC-5 | Bukalaris security owner | Provider keys are server-only, least-privilege, redacted, and rotated through the selected secret system. | Proposed |
| SEC-6 | Bukalaris security owner | Webhook authenticity is verified before parsing or side effects; accepted events are durable-deduplicated. | Proposed |
| SEC-7 | Bukalaris security owner | Owner console, role and capability-grant, suspension, financial, and marketplace-review changes produce protected audit records; impersonation stays disabled (IAM-10). | Proposed |

> **Direction change (D-27 to D-31, 2026-11-14, ADR-0013 to ADR-0016):** four owner decisions change controls in this document: seller-owned Mengantar and AutoLaris accounts and seller bank transfer (D-27, D-31), two registrable domains with checkout on the store host (D-28), the seller-run affiliate programme (D-29) and digital products delivered by access links (D-30). Each affected section below carries its own note; the new controls are SEC-26 to SEC-28 and THR-15 to THR-19. SEC-5 now also covers seller provider keys (SEC-26). Accepted as decisions, not implemented (T-102 to T-113).

## Threat priorities

1. Cross-tenant data/action access through IDs, caches, background jobs,
   exports, media, or root tenant records.
2. Money/inventory manipulation through client totals, repeated checkout,
   provider timeouts, or replayed callbacks.
3. Account takeover and privilege escalation through weak session/recovery,
   invitation, or support-recovery flow.
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

## SEC-3 and SEC-9 — Surface isolation rules (normative)

> **Direction change (D-28, 2026-11-14, ADR-0014):** native storefronts move to `<store-slug>.bukalaris.id` and custom domains point at `cname.bukalaris.id`, so every storefront is cross-site to every platform surface on `bukalaris.com`; rule 7 is decided, no longer OPEN. Cart, checkout, confirmation and the signed order-status page are served on the store host (ADR-0014 decision 5), which replaces rule 1 for native stores and custom domains; `checkout.bukalaris.com` remains only for the one-use hand-off of independent storefronts (PR-16, SEC-13). Rules 2 to 6 stand, read with two roots (SEC-28). The text below describes the earlier one-root model, which is what the code runs today. Not implemented (T-102, T-103).

- Status: Proposed
- Owner: Bukalaris security owner
- Source: IAM-9, IAM-15, ADR-0008; audit of 2026-10-27 (SPV-03, SPV-16).
- Statement: After host activation (T-62), each surface is reachable only on its
  own host and no seller-chosen third-party script shares an origin with a
  privileged session:
  1. `/checkout*` (handoff, checkout, confirmation) is served only on the
     `checkout` host. Every other host (`owner`, `app`, `affiliate`, `buyer`,
     `logs`, the apex, storefront subdomains and custom domains) answers 404.
  2. `/api/*` follows a per-host allowlist: a host serves only the API prefixes
     of its own surface (operator, seller, affiliate, buyer auth and handlers on
     their hosts; storefront and custom-domain hosts only the public storefront
     endpoints; `logs` none); any other prefix answers 404. ADR-0008 and 08 hold
     the host × path matrix.
  3. A surface's path prefix (`/admin`, `/seller`, `/affiliate`, `/buyer`,
     `/updates`) answers 404 on every other host, **the apex included**. The
     legacy apex path mode (`/admin`, `/seller`, `/s/<slug>`) is retired when hosts
     go live and survives only for localhost development and tests, off in
     production.
  4. Seller-chosen pixels and scripts run only on storefront origins (and the
     checkout origin under SEC-13 rules), never on an origin that carries the
     session cookie of `owner`, `app`, `affiliate` or `buyer`.
  5. Every session and CSRF cookie uses the `__Host-` prefix (Secure, `Path=/`,
     no `Domain`) with a per-surface name: `__Host-bl_owner`, `__Host-bl_seller`,
     `__Host-bl_aff`, `__Host-bl_buyer`, `__Host-bl_order_cart`, `__Host-bl_click`.
     A script on a storefront subdomain can therefore not toss a parent-domain
     cookie onto another surface.
  6. CSRF defence is never cookie-only: mutating requests check `Origin` and
     `Sec-Fetch-Site` and carry a token bound server-side to the session.
  7. A separate registrable domain for storefronts is OPEN (recommended, not
     decided; ADR-0008 owner).
- Acceptance: T-62 slice 3 tests every cell of the host × path matrix, including
  checkout on `owner`/`app`/apex (404), an `/api` prefix outside a host's
  allowlist (404), `/admin` on the apex (404), and a cookie set with
  `Domain=.bukalaris.com` by a storefront page that neither authenticates nor
  alters any surface.

## Phase 1 trust-boundary register

All following controls are proposed requirements, not findings of deployed
vulnerabilities. Sources are the accepted product requirements and the linked
internal contracts; runtime/provider-specific implementation awaits T-1/T-5.

> **Direction change (D-27, D-29, D-30, D-31, 2026-11-14, ADR-0013, ADR-0015, ADR-0016):** for a store on seller-owned accounts Bukalaris holds no order money, so the payout parts of the "Affiliate clicks and payouts" and "Restore and backups" rows (hold on bank changes, four-eyes before transfer, payout re-opened) apply only to money Bukalaris does hold; there is no platform affiliate payout (ADR-0015 decision 9). In the "Order/payment" row, "reconciliation" for such a store means the status check on the store's own key or the seller's manual confirmation, not a platform ledger. The last three rows are added for the new assets. The other rows describe the earlier model and still apply where unchanged. Not implemented (T-104 to T-113).

| Asset / boundary | Adversarial or failed input | Authoritative control | Minimum proof |
|---|---|---|---|
| Seller records | Foreign numeric ID, role field, stale membership | Tenant + object + writable-field policy; app-role store UPDATE only on the four profile columns (T-81, TEN-3) | Authorized settings success; foreign write has no effect; direct app-role SQL cannot update store identity/lifecycle columns |
| Public content | Draft ID, hostile HTML/link, shared cache entry | Published projection + safe rendering + store cache partition | Draft absent; injected content inert; no cross-store response |
| Order/payment | Changed total, repeated request, unknown provider result | Server calculation + durable operation identity + reconciliation | Repeated logical action has one commercial effect |
| Domain binding | Spoofed forwarded host, duplicate/reassigned domain | Trusted proxy chain + verified binding + atomic ownership | Unknown/reassigned host cannot serve prior store |
| Operator/log viewer | Seller login, broad query, raw sensitive event | Platform capability + safe bounded query projection | Denied access and redaction at sink and UI |
| Jobs/webhooks | Replay, mismatched provider account, stale intent | Verified account/event + stored linkage + policy | Invalid input has no effect; duplicate is harmless |
| Restricted tables and auth tables | SQL injection or compromise of the app or platform role | No-login owner roles, `SECURITY DEFINER` functions, resolvers on the app pool (ADR-0005 amendment) | No table privilege for `bukalaris_platform` on restricted tables; every access path is a registered function |
| Owner console governance | Self-approval, grant escalation, staff impersonating customers, lost-staff lock-out | Capability re-read per request, four-eyes matrix, MFA, bootstrap runbook (IAM-15) | Matrix and denial tests; bootstrap refuses with two holders |
| Buyer identity | Email/phone squatting, enumeration, OTP toll fraud, recycled numbers | One live phone per buyer, possession and binding gates, uniform responses, shared limiter (ADR-0010, 16) | Victim-phone/attacker-email and email-phone-mismatch tests; uniform responses |
| Affiliate clicks and payouts | Cookie stuffing, click flood, self-referral, account takeover then payout | SEC-20, step-up and hold on bank changes, four-eyes before transfer (IAM-9, IAM-15) | Sec-Fetch cases; payout cannot move without a second approver |
| Public intake and Update Log | Stored XSS, malicious link, spoofed origin, malicious takedown, reporter data | SEC-21 | Sanitiser, canonical-origin and no-auto-takedown tests |
| Restore and backups | Grants dropped, erasure resurrected, payout re-opened | SEC-23, PRIV-4 | Rehearsal asserts grants per role and erasure replay |
| Seller provider credentials (D-27; planned, T-104 to T-106) | Key read back through a page, DTO, log, error text or export; use by a foreign store; replacement after account takeover; seller-supplied provider URL | SEC-26: sealed per store, opened only in the server-side provider client, `integrations.manage` plus fresh step-up, redaction, fixed origin per `environment` | Canary-key scan finds nothing; cross-store read, use and replace refused; change without step-up refused; no provider URL built from stored or submitted text |
| Seller bank accounts and manual payment confirmation (D-31; planned, T-113) | Destination list changed after takeover; order marked paid without a record; foreign-store read | ADR-0013 section 10 and decision 24: `integrations.manage` plus fresh step-up and audit for the account list; one append-only confirmation record under the finance capability; store-scoped RLS | Change without step-up refused; no path other than the confirmation sets paid; store A cannot read or change store B's accounts |
| Digital access links and grants (D-30; planned, T-112) | Link shown before payment or on a public surface; hostile link target; signed order token leaked through `Referer`; markup in the access note | SEC-27 | Links and note absent from storefront HTML, Storefront API, feeds, e-mails and logs; no outbound request to a link; no referrer; note rendered as text |

## SEC-8 — Safe publishing and uploads

> **Direction change (D-32, 2026-11-15, ADR-0013 section 10):** one buyer upload exists: the proof of transfer for a `bank_transfer` order. It is accepted only on the signed order-status page of that order, limited to three images with the type checked by content and a size cap, rate limited, stored outside the public media directory, never served by the public media route, readable only by that buyer and the store's finance role, served as an attachment with a sandboxing content-security policy, and deleted after its retention period. An upload never changes an order. Not implemented (T-113).

> **Direction change (D-30, 2026-11-14, ADR-0016):** digital products add no upload path. Delivery content is a list of seller-hosted access links plus an optional text note; the platform stores, copies, proxies, previews and scans no file, and the server never requests a link, so the bounded remote-fetch path at the end of this section is not used for them (SEC-27). The text below still applies to product media and rich text. Not implemented (T-111, T-112).

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

> **Direction change (D-28, 2026-11-14, ADR-0014):** storefronts are on their own registrable domain, so "subdomain" in the acceptance below means `<store-slug>.bukalaris.id`, checkout writes of a native store or custom domain are same-origin on the store host, and a storefront page can no longer set a parent-domain cookie that a platform host receives. The cookie, CSRF and CORS rules below stand unchanged (SEC-28). Not implemented (T-102, T-103).

- Status: Proposed
- Owner: Bukalaris security owner
- Source: IAM-9, API-1, DOM-3.
- Statement: Cookie-authenticated writes use the selected framework's CSRF
  protection and a server-bound token (never a cookie-only check); session
  cookies are Secure, HttpOnly, host-only `__Host-` cookies with per-surface
  names (rule above), and have deliberate SameSite/lifetime settings. CORS allows
  only required exact origins and is never authorization. Public API credentials
  are not browser secrets.
- Acceptance: Cross-origin hostile writes fail; valid intended storefront
  operations succeed on subdomain and custom-domain paths. Test CSP, framing,
  content-type, and referrer policy on the deployed serving layers in a browser.
  Admin cookies never reach seller-controlled unrelated domains, and a
  parent-domain cookie tossed from a storefront host is ignored.

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

> **Direction change (D-28, 2026-11-14, ADR-0014):** this hand-off serves independent storefronts only (PR-16). A native store or a verified custom domain runs cart, checkout, confirmation and order status on its own host with no hand-off token (ADR-0014 decision 5). The controls below stand for the hand-off on `checkout.bukalaris.com`. Not implemented (T-103).

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

## Platform-surface controls (2026-10-27)

Controls added by the 2026-10-27 documentation audit for the Owner console,
buyer identity, affiliate programme, public intake and key management. All are
Proposed requirements; nothing here is built.

### SEC-20 — Referral click endpoint

> **Direction change (D-29, D-31, 2026-11-14, ADR-0015):** the attribution window is decided at 7 days, Owner-configurable (former OPEN-A2), so the click-cookie lifetime below is no longer OPEN. Only an affiliate with an `active` membership of the store at order time can be attributed. Bukalaris pays no commission, so the "payout hold" action below does not exist for the seller-run programme; the Owner console actions are suspending an affiliate account platform-wide and freezing a store's programme (ADR-0015 decisions 1 and 7). The capture rules below stand. Not implemented (T-108 to T-110).

- Status: Proposed
- Owner: Bukalaris security owner
- Source: ADR-0009 §4 and §8, PRIV-7; ARCH-5 HTTP-27 `GET /r/[token]` (apex host, T-52).
- Statement: Click capture records a click only for a top-level navigation:
  method `GET`; `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`; not a
  prefetch or prerender (`Sec-Purpose`, `Purpose`). `HEAD`, subresource loads
  (image, script, iframe, style), and requests without Sec-Fetch headers
  redirect but capture nothing (attribution fails closed, the buyer's redirect
  never does). The click cookie is `__Host-bl_click`: Secure, HttpOnly,
  `Path=/`, no `Domain`, SameSite=Lax, opaque click id only, lifetime equal to the
  attribution window (OPEN). The redirect target comes only from the stored link
  and a validated seller destination (no `next` parameter, no open redirect). An
  unknown, inactive or suspended link redirects to a neutral landing with no
  capture and no existence hint. Over-limit requests (16 RL-CLICK rows) redirect
  without capture. A click id or code is a selector, never authentication.
- Phase 1 fraud source: no browser fingerprint is added. The risk queue's
  "affiliate fraud flag" (UX-22 SA-18) is derived at read time from counters:
  self-referral suppressions, click refusals by rate limit, clicks-to-orders
  ratio, and returned or voided commission ratio per affiliate; threshold values
  are OPEN. Phase 1 actions are suspension (`affiliate.accounts.review`) and a
  payout hold; dispute decisions are Phase 2.
- Acceptance: Embedding the link as `<img>`, in a hidden iframe or via prefetch
  captures no click; a top-level navigation captures exactly one click and sets
  the cookie; replay and flood stay within the limits; a suspended affiliate's link
  captures nothing.

### SEC-21 — Public intake and public feeds

- Status: Proposed (applies when SF-13/HTTP-20 public reports and the Update Log are activated, T-64, T-69)
- Owner: Bukalaris security owner
- Source: UX-22 Update Log; ADR-0011 §3; audit of 2026-10-27 (SPV-25, SPV-26).
- Statement: **Public reports:** bot friction before accepting a report (challenge
  provider OPEN) plus per-IP and per-target limits (16); the reporter's contact is
  optional, minimal, kept for a finite period (OPEN, PRIV-4) and never shown to the
  reported seller by default; reporter-supplied URLs are never fetched
  server-side and are rendered as text; a report never triggers an automatic
  takedown, suspension or ranking change (staff decide, so a malicious report
  cannot remove a store); `report` is a reserved route root (ADR-0008).
  **Update Log:** permalinks, the feed `id`/`url` and canonical links are built
  from a configured canonical origin (`logs.bukalaris.com`), never from the
  `Host` header; `/updates` is not served on the apex (rule 3 above). Publishing
  four-eyes stays off by default; turning it on for category `security` is
  recommended, not decided.
- Acceptance: A forged `Host` header changes no feed URL; a report with a URL
  causes no outbound request; a burst of reports against one store changes no
  store state.

### SEC-22 — Key purposes, rotation and fail-closed secrets

> **Direction change (D-27, D-31, 2026-11-14, ADR-0013):** sellers now enter their own Mengantar and AutoLaris keys, so "sellers never paste external keys" no longer applies. The `shipping_credentials` keyring seals the store's own Mengantar key and a new `payment_credentials` keyring seals its AutoLaris key (SEC-26). The Mengantar Partner Secret pasted in chat on 2026-10-27 is not rotated: the owner accepted the exposure on 2026-11-14 (D-31, owner answer 1); no `seller_owned` store uses it, and the T-48 entry gate in the code still refuses every Partner call without rotation evidence. The rule that an exposed secret is rotated before first use stands for every other secret. The text below describes the earlier model. Not implemented (T-104 to T-106).

- Status: Proposed
- Owner: Bukalaris security owner
- Source: SEC-5, SEC-11, ADR-0007, ADR-0012; audit of 2026-10-27 (SPV-21).
- Statement: One key per purpose: Meta and TikTok integration tokens, per-store
  Mengantar partner credentials (provisioned by Bukalaris via the Partner API; sellers never paste external keys), order-link signing, the identity fingerprint HMAC (keyed
  fingerprints for search and duplicate detection), tax-identity sealing, and one
  session secret per surface. Sealed values carry a key version; the keyring
  decrypts with every listed version, encrypts with the newest, and a re-seal job
  rotates stored values, so rotation never makes a stored token unreadable.
  A required secret that is missing, too short, or equal to another purpose's
  secret stops the process in production (fail closed); no secret silently falls
  back to another (`ORDER_LINK_SECRET` never falls back to `BETTER_AUTH_SECRET`).
  Rotation of an exposed secret is an entry gate before first use (for example
  the Mengantar Partner Secret that was pasted into a chat, T-48).
- Acceptance: Boot with a missing or duplicated secret fails in production mode;
  a value sealed under version 1 decrypts after version 2 is added; the re-seal
  job leaves no version-1 value; the keyed fingerprint changes only under its own key.

### SEC-23 — Restore reapplies grants and erasure records

> **Direction change (D-27, D-29, 2026-11-14, ADR-0013, ADR-0015):** the payout freeze and bank reconciliation below apply only to money Bukalaris holds (subscription billing, and the unused platform-managed ledger). A store on seller-owned accounts has no platform payout to freeze, and affiliate commission is paid by the seller outside Bukalaris. The grant and erasure rules stand, and a restore must also keep the sealed seller credentials readable under their `key_id` (SEC-26). Not implemented (T-107, T-109).

- Status: Proposed
- Owner: Bukalaris security owner with the operations owner
- Source: ADR-0005 amendment, PRIV-4, PRIV-7, PRIV-10; audit of 2026-10-27 (SPV-23).
- Statement: A restore is not complete until it reapplies the grant registry
  (table owners, role grants, effective column privileges, function `EXECUTE`
  grants, default privileges) and
  every erasure and restriction record (order redactions, buyer erasure, click
  purges, tax crypto-erasure), then verifies both. Backups must keep owners and
  ACLs (no `--no-acl`/`--no-owner`). Payout and billing jobs stay frozen until
  reconciled against bank and provider evidence (14-SLA-DISASTER-RECOVERY).
- Acceptance: The restore rehearsal asserts the grants of every role against the
  registry and replays erasure records, failing when either differs.

### SEC-25 — Runtime database identity proof at boot

- Status: Proposed (portfolio scan 2026-11, G1; task T-76)
- Owner: Bukalaris security owner
- Source: ADR-0005, SEC-1; TokoΦ incident: a pool labelled "restricted" ran as superuser with
  BYPASSRLS for months because the restricted URL silently fell back to the owner URL.
- Statement: The web process and the worker each prove, once per process and before the first
  query, that the connected role is the expected one (`bukalaris_app` for `DATABASE_URL`,
  `bukalaris_platform` for `PLATFORM_DATABASE_URL`) and that it is neither superuser nor
  `BYPASSRLS` (`pg_roles` of `current_user`). A failed proof stops the process; the message names
  the variable, never the connection string. `/api/ready` reports not ready until the proof passed.
  Today `createDb` only refuses a missing URL (no fallback exists), and role attributes are checked
  offline by `scripts/_registry.sh` and `verify:docker`, not at runtime.
- Acceptance: a test starts the pool with the owner URL and with a `BYPASSRLS` role and both refuse
  to serve; the correct roles pass; `/api/ready` is 503 before the proof.

### SEC-24 — Credential-bearing mail

- Status: Proposed
- Owner: Bukalaris security owner
- Source: `CRSEC-04`; ADR-0010, ADR-0011; audit of 2026-10-27 (SPV-17).
- Statement: Recovery links, invitations and buyer magic links must not be
  stored in clear text or readable by the app role. Prerequisite for support
  recovery links (T-63) and buyer magic links (T-58), delivered by T-73: a real
  mailer, message bodies purged after delivery, no app-role `SELECT` on
  `mail_outbox` bodies. Until then those two features stay disabled.
- Acceptance: After delivery no row holds a usable link; the app role cannot
  read bodies; a recovery link action returns not-implemented before the fix.

## Controls added by the direction change of 2026-11-14 (D-27 to D-31)

Proposed requirements taken from ADR-0013, ADR-0014 and ADR-0016; nothing here is
built. Where an ADR and this section differ, the ADR is the source.

### SEC-26 — Seller provider credentials (new secret class)

- Status: Proposed (D-27, D-31; not implemented, T-104 to T-106, T-113)
- Owner: Bukalaris security owner
- Source: ADR-0013 sections 2, 3, 6, 9 and 10; SEC-5, SEC-11, SEC-22; D-21.
- Statement:
  1. **Class.** Each store's own Mengantar API key and AutoLaris H2H API key are
     seller secrets that Bukalaris holds for that store only. The payment key
     decides where buyer money goes, so it is treated like a payout destination.
  2. **Sealing.** A key is sealed with AES-256-GCM under a purpose-separated
     keyring with `key_id` versioning: the existing `shipping_credentials` keyring
     for Mengantar and a new `payment_credentials` keyring for AutoLaris. The
     keyring rules of SEC-22 apply (distinct per purpose, fail closed, re-seal on
     rotation). A sealed key is opened only inside the server-side provider
     client and is never loaded into a page, a DTO, a log line or an export.
  3. **Change control.** Entering, replacing or removing a key needs the store
     capability `integrations.manage` (owner role) and a fresh step-up, writes an
     audit entry (who, when, which provider, key fingerprint, never the key) and
     notifies every store owner. There is no waiting period after a change
     (D-31, former OPEN-P3).
  4. **No read-back.** An empty field keeps the stored key; removal is an
     explicit action. The screen shows only "connected", a masked hint and the
     last successful check. A key shorter than 24 characters is fully masked; a
     longer one shows its first and last four characters.
  5. **Connection check.** A check runs on save and on demand; a failed check
     stores nothing new and keeps the previous key.
  6. **Redaction.** The Mengantar key travels in the URL path of every call, so
     the client strips the raw and the URL-encoded key from every error, log
     entry and trace before it leaves the function.
  7. **Fixed provider origins.** There is no free-form base URL. Each account has
     an `environment` of `sandbox` or `production`, mapped to a fixed provider
     origin from server configuration; no code path builds a provider URL from
     stored or submitted text, so a seller cannot point server-side requests at
     another host. The sandbox origins are UNVERIFIED until read from each
     provider's official documentation (former OPEN-P7, T-105, T-106).
  8. **Isolation.** Accounts are store-scoped under row-level security: store A
     cannot read, use or replace store B's key, and a status check for a store
     runs on that store's key only.
  9. **Callback is evidence only.** A provider callback never changes payment
     state; an order becomes paid only by a status check on the store's key
     (paid code and an allow-listed status word) or by the seller's manual
     confirmation, one append-only record per attempt (D-21, ADR-0013 section 6).
  10. **Live-call boundary.** Local development and CI keep fake adapters. A
      sandbox run is opt-in with a test key supplied through `secrets-env`, never
      a key in a file. Production calls on seller keys are switched on per
      provider by an Owner console setting after a recorded sandbox pass.
  11. **Seller bank accounts (D-31).** A store's own bank-transfer destinations
      (up to five: bank, account number, holder name) are changed with
      `integrations.manage` and a fresh step-up, audited. They are shown to the
      buyer by design; Bukalaris checks no bank statement and takes no proof
      upload from the buyer (ADR-0013 section 10).
  12. **Platform credentials.** The only platform-owned provider credential in
      use is the platform's own AutoLaris account for subscription invoices. The
      Partner credentials stay in the code, unused for `seller_owned` stores.
- Acceptance: a canary key never appears in any response body, RSC payload, log,
  audit row or export; an empty field keeps the key; removal needs the explicit
  action; a failed check keeps the previous key; a change without step-up is
  refused; cross-store read, use and replace are refused under the application
  role; an environment test proves no provider URL is built from stored or
  submitted text; each invariant is broken once on purpose and its named test
  fails (ADR-0013 "Confirmation").

### SEC-27 — Digital access links

- Status: Proposed (D-30, D-31; not implemented, T-111, T-112)
- Owner: Bukalaris security owner
- Source: ADR-0016 sections 4 and 7; SEC-8, SEC-9, SEC-21.
- Statement:
  1. **No file on the platform.** Delivery content is a list of access links to
     content the seller hosts elsewhere plus an optional access note. Bukalaris
     does not upload, copy, proxy, preview or scan what a link points to.
  2. **No server-side request.** The server never requests an access link (no
     reachability check, no preview fetch), so access links add no SSRF surface.
  3. **Link rules.** `https` only, no credentials in the URL, at most 10 links
     per product and 2,000 characters per link (Owner-configurable, D-31). A link
     is shown with its label and destination host.
  4. **No referrer.** A link opens in a new tab and is sent with no referrer,
     because the order-status address contains the buyer's signed token.
  5. **Never public.** Access links and the access note never appear in
     storefront HTML, the Storefront API, feeds, e-mails or logs. They are read
     only through a valid grant, by one function. The payment-confirmed e-mail
     carries the order-status link, never a content link.
  6. **Text only.** An access note is rendered as text, never as seller-supplied
     HTML.
  7. **Grants.** Access is granted in the transaction that settles the order
     (status check or the seller's manual confirmation), once per digital order
     line; a callback alone grants nothing. Grants are store-scoped under
     row-level security; extending or revoking one is audited.
  8. **Reserved types.** Only the access-item type `link` is accepted.
     `video_embed` and `live_session` are refused, and no frame allow-list is
     added to the content-security policy now. The later member area uses a
     fixed platform allow-list, never a seller-supplied frame address (D-31).
  9. **Limit of control.** Bukalaris controls only whether its own pages show a
     link. It cannot count downloads, close a link the buyer already copied, or
     tell what a link serves; a harmful or dead link is handled by the public
     report intake and an Owner console takedown, not by scanning.
- Acceptance: links and note are absent from storefront HTML, the Storefront API,
  feeds, e-mails and logs; an expired or revoked grant shows no link; a
  non-`https` link or one with credentials is refused on save; the rendered link
  carries no referrer; the server makes no outbound request to a link; a note
  containing markup is rendered as text; a reserved type is refused; store A
  cannot read, attach or revoke store B's access items and grants (ADR-0016
  "Confirmation").

### SEC-28 — Two registrable domains: storefronts cross-site to platform sessions

- Status: Proposed (D-28, D-31; not implemented, T-102, T-103; HSTS rollout T-94)
- Owner: Bukalaris security owner
- Source: ADR-0014; SEC-3, SEC-9; DOM-5, DOM-6; D-25.
- Statement:
  1. **Separation.** Platform surfaces (`owner`, `app`, `checkout`, `buyer`,
     `affiliate`, `logs` and the apex) stay on `bukalaris.com`
     (`PLATFORM_ROOT_DOMAIN`); native storefronts are `<store-slug>.bukalaris.id`
     (`STORE_ROOT_DOMAIN`). Seller-controlled content is therefore cross-site to
     every platform session, and storefront abuse cannot take the platform
     domain's reputation or HSTS policy with it.
  2. **Dispatch.** Exact platform hosts on the platform root are matched first,
     then `<label>.<STORE_ROOT_DOMAIN>`, then a verified custom domain; anything
     else fails closed (`421`, D-25). A platform label on the store root and a
     store slug on the platform root both fail closed.
  3. **Reserved labels on the store root.** `cname`, `www`, `api`, `mail`,
     `status`, `docs`, `assets`, `cdn` and every platform label stay unclaimable
     as store slugs on `bukalaris.id`.
  4. **CNAME target.** `cname.bukalaris.id` is the only target a seller is told
     to use; a request for that host itself is not a store and fails closed.
     Custom domains are subdomains only until T-15 verifies apex support (D-31).
  5. **No session surface on the store domain.** The apex and `www` of
     `bukalaris.id` redirect to `https://bukalaris.com` for `GET`/`HEAD`.
  6. **Cookies and HSTS.** No cookie is set on `.bukalaris.id` or
     `.bukalaris.com`; session and CSRF cookies stay host-only with the `__Host-`
     prefix. `includeSubDomains` on `bukalaris.id` covers storefronts only; a
     custom domain receives HSTS on its own host without `includeSubDomains`.
  7. **Checkout on the store host.** Cart, checkout, confirmation and the signed
     order-status page are served on the storefront's own host; the cart cookie
     is host-only and never crosses to `checkout.bukalaris.com`. The store host
     still refuses seller, operator, auth and Storefront API paths.
  8. **Link origins.** Storefront, landing-page, feed, order-status and recovery
     links use the store's primary host; Seller Admin, Owner console, buyer
     portal, affiliate portal and password or invite links use the platform host.
     A feed or e-mail link is never built from the request host.
- Acceptance: a two-root host table proves the fail-closed cases and that
  `cname.<store root>` is never a store; cart, checkout and confirmation complete
  on the store host with two different roots at 320 px and desktop; a link-origin
  test covers a store with and without a primary custom domain (ADR-0014
  "Confirmation").

## Threat register — Owner console, buyer identity, affiliate, payouts, intake (STRIDE)

Proposed requirements, not findings of deployed vulnerabilities. Each row names
the control that closes it.

> **Direction change (D-27 to D-30, 2026-11-14, ADR-0013 to ADR-0016):** THR-6 applies only to money Bukalaris holds; a store on seller-owned accounts has no platform payout, and affiliate commission is paid by the seller (ADR-0015 decision 9). THR-9 concerns the affiliate storefront, which is deferred (D-29, T-55 not scheduled). THR-15 to THR-19 are added for the new surfaces. The other rows describe the earlier model and still apply where unchanged. Not implemented (T-102 to T-113).

| ID | Surface | Threat (STRIDE) | Control |
|---|---|---|---|
| THR-1 | Owner console session | Spoofing: stolen cookie, dead-but-valid session | MFA, host-only `__Host-bl_owner`, per-request capability re-read, sign-out on removal (IAM-15) |
| THR-2 | Staff grants | Elevation: self-grant, first-holder bypass | Matrix `grant.sensitive`, bootstrap runbook with two named people, `system_bootstrap` event |
| THR-3 | Support actions | Elevation: support agent resets or restores a staff identity | Staff identities excluded from `accounts.*`; `staff.manage` four-eyes |
| THR-4 | Audit trail | Repudiation: action without record | Same-transaction audit row, append-only tables, fail closed (SEC-11) |
| THR-5 | Personal-data reveal | Information disclosure: bulk or purposeless reveal, per-store buyer breakdown | Purpose and case per reveal, masking in the data layer, break-glass allowlist and expiry (PRIV-9) |
| THR-6 | Payouts | Tampering: bank change after takeover, single approver, replayed rejection | Step-up and hold on bank change, four-eyes before transfer, unique ledger indexes (IAM-9, IAM-15) |
| THR-7 | Buyer identity | Spoofing/information disclosure: victim phone with attacker email, enumeration, OTP toll fraud | ADR-0010 resolution rule, binding gate, uniform responses, delivery caps (16) |
| THR-8 | Referral clicks | Tampering: cookie stuffing, click flood | SEC-20, rate limits, no capture on subresource loads |
| THR-9 | Affiliate storefront | Tampering/repudiation: malicious storefront content | Suspension unpublishes and deactivates links; moderation Phase 2 |
| THR-10 | Update Log | Tampering/spoofing: injected markup, wrong origin | Sanitised restricted markdown, canonical origin, GET-only, no cookies (SEC-21) |
| THR-11 | Issue reports | Information disclosure/denial of service: personal data in descriptions, flood | Extended `scrubText`, text nodes only, per-staff limit, no attachments in Phase 1 (UX-22) |
| THR-12 | Public reports | Denial of service/tampering: malicious takedown, bot flood | SEC-21: friction, limits, no automatic action |
| THR-13 | Database roles | Elevation: SQL injection reaches payouts through the public lookup path or directly changes store lifecycle | ADR-0005 amendment: lookups off the BYPASSRLS pool, restricted tables behind functions; T-81 app store-column UPDATE allowlist, verified independently of GUC context. Shared auth/platform-pool residual risks remain. |
| THR-14 | Backups | Information disclosure/repudiation: unencrypted dump, grants and erasures lost on restore | SEC-23, PRIV-4; client-side encryption of offsite dumps is OPEN (14) |
| THR-15 | Seller provider keys (D-27) | Information disclosure/elevation: key echoed to a page, logged with the request URL, used for another store, or replaced after an account takeover to redirect buyer money | SEC-26: sealing, no read-back, redaction, store-scoped RLS, `integrations.manage` plus step-up, audit and owner notification |
| THR-16 | Provider origin (D-27) | Tampering (server-side request forgery): a seller-supplied provider URL points server requests at another host | SEC-26 item 7: fixed origin per `environment`, no URL from stored or submitted text |
| THR-17 | Seller bank transfer and manual confirmation (D-31) | Tampering/repudiation: destination list changed after a takeover; an order marked paid with no record | SEC-26 items 9 and 11: step-up and audit on the account list, one append-only confirmation record per attempt |
| THR-18 | Digital access links (D-30) | Information disclosure/tampering: link on a public surface or before payment, signed order token leaked by `Referer`, request forgery through a link check, markup in the access note | SEC-27 |
| THR-19 | Storefront domain (D-28) | Spoofing/tampering: a store slug that imitates a platform label, a cookie tossed toward a platform host, a claimed CNAME target | SEC-28: two roots, reserved labels on the store root, host-only `__Host-` cookies, `cname` never a store |
