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

## Threat register — Owner console, buyer identity, affiliate, payouts, intake (STRIDE)

Proposed requirements, not findings of deployed vulnerabilities. Each row names
the control that closes it.

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
