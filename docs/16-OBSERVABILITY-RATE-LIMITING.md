# Bukalaris Observability and Rate Limiting

Telemetry answers operator decisions; it does not replace audit records or
authorize a user. External sink/vendor and retention duration are still
Unknown; the limits and the diagnostic sink that exist on `main` are listed in
"Implemented" below, everything else in this document is a proposal.

## Implemented on `main` (checked 2026-10-07)

| Control | Implementation | Numbers | Proof |
|---|---|---|---|
| Correlation id | `apps/web/src/proxy.ts` mints `x-request-id` (UUID) per request, sets it on the response and in cookie `bl_rid` (5 min, readable by the client error boundary); an inbound id is kept only with `TRUST_PROXY_REQUEST_ID=1` and shape `^[A-Za-z0-9_-]{8,64}$` (`lib/request-id.ts`). Never identity or authorization | — | `e2e/ops.spec.ts` ("every response carries a request id"), `e2e/security-headers.spec.ts` (trust flag) |
| Structured logs | `apps/web/src/lib/log.ts` `log()`/`emit()`: one JSON line per event on stdout from an allowlist (`LOG_FIELD_ALLOWLIST`, `scrubText` in `packages/db/src/ops.ts`); fields `level, time, msg, request_id, module, operation, page_id, store_id, code, env (APP_ENV), release (RELEASE_REVISION/SOURCE_COMMIT)`. `instrumentation.ts` `onRequestError` reports every uncaught server error with route template and method only | sink timeout 2 s, non-fatal | `test/ops.test.ts` ("drops forbidden keys and scrubs free text", "caps text, defaults unknown levels/modules") |
| Diagnostic sink (OBS-5) | `system_log` table (`schema-ops.ts`) receives `warn`/`error`/`fatal` events via `recordLogEvent`; worker/cleanup log to stdout only | — | `test/ops.test.ts`, `e2e/ops.spec.ts` (DB-outage event visible after recovery) |
| Log System query | `listSystemLogs`/`getSystemLog` (`ops.ts`) behind `logs.read` (`operator_grant`); filters level, module, request id, store id, from/to; cursor `(time desc, id desc)`; every list/detail read writes an `audit_log` row (`logs.list`, `logs.read`); detail returns up to 50 related events by request id and the `MODULE_MAP` page mapping or null | default range 1 h, max 24 h; page 50, max 200 | `test/ops.test.ts` ("denies operators without logs.read and sellers entirely", "lists with filters, pages by cursor, and audits every read") |
| Sign-in / recovery limits | Better Auth built-in limiter (`lib/auth.ts`, in-memory per process, active in production builds) | `/sign-in*` 3 per 10 s per IP; password-reset request 3 per 60 s | 429 observed (BUILD-LOG 2026-10-06); `docs/tracks/accounts.md` |
| Checkout and cart limits | Postgres fixed-window counters in `rate_limit` (`hit`, `enforceLimits`, `LIMITS` in `packages/db/src/checkout.ts`); IP from `x-forwarded-for` last hop or `x-real-ip` (`lib/storefront.ts` `clientIp`), dimension skipped when absent; retryable Indonesian message with seconds to wait | order submit: 60 / 10 min per IP, 5 / min per cart, 10 / 10 min per phone; cart add/update: 300 / 10 min per IP, 60 / 10 min per cart; cart cap 30 distinct variants, qty ≤ 99 per line | `test/checkout2.test.ts` ("abuse controls"), `e2e/checkout2.spec.ts` ("order submission is rate limited per cart") |
| Browser funnel endpoint | `POST /api/signals` | 600 / 10 min per IP, body ≤ 8 KB | `test/signals.test.ts`, `e2e/signals.spec.ts` |
| Storefront API v1 | no limiter yet (channel token + 256-bit one-use handoff codes) | — | open item, TASKS T-16/T-19 |
| Catalog feeds (T-40) | `limitFeedFetch` (`packages/db/src/feeds.ts`) on the same `rate_limit` counter, key `feed:store:<id>`, counted only for a valid token; 429 + `Retry-After` | 60 fetches / store / hour; unknown tokens not counted | `test/feeds.test.ts` ("fetch budget is per store") |
| Shipment booking (T-39) | outbox jobs `shipment.book`/`shipment.track` (`fulfillment.ts`); one shipment per order (unique), one job per attempt; provider writes serialised per platform account with `pg_advisory_xact_lock`; only 409/429 retry a write, timeouts/5xx fail closed | tracking polls 15 min doubling to 6 h, max 60 per shipment; manual refresh max 50 | `test/fulfillment.test.ts` |
| Outbox and jobs (OBS-3) | `job` rows with `attempts`, `next_attempt_at`, `last_error` (sanitized by `sanitizeError`); worker logs one JSON `job` outcome per claim | lease 60 s, 10 attempts with exponential backoff, payload ≤ 4 KB | `test/jobs.test.ts` |
| Cleanup | `cleanup.ts`: idle open carts, counters older than a day, signal click context older than 30 days; buyer-data retention redaction only when `BUYER_DATA_RETENTION_DAYS` is set (off by default, T-43) | `CART_IDLE_HOURS` default 168; retention max 1000 orders per run | `test/checkout2.test.ts`, `test/signals.test.ts`, `test/privacy.test.ts` |
| Readiness | `GET /api/ready` one `select 1` with 2 s timeout → 503; `GET /api/health` liveness without DB | — | `e2e/ops.spec.ts`, `scripts/verify-docker.sh` |

Not implemented: metrics/traces, external sink or alerting, retention jobs for
`system_log`/`audit_log`/`job`, stale/partial source states in the viewer
(same-DB sink, no ingestion delay), `log.warn/info` calls from most business
paths (only `onRequestError` and the Log System pages emit today), per-store
framing allowances. Mengantar booking is serialised (see "Shipment booking"
above) but only exercised against the fake adapter; the provider's concurrency
rule is unverified until an approved write test.

| ID | Owner | Operator question | Required terminal signal |
|---|---|---|---|
| OBS-1 | Bukalaris operations owner | Can sellers publish and buyers browse the intended store? | Host resolution and publish outcome, safe tenant identifier |
| OBS-2 | Bukalaris operations owner | Is checkout/payment/shipping completing for buyers? | One terminal checkout/payment/shipment outcome with correlation |
| OBS-3 | Bukalaris operations owner | Is a provider failure/retry causing duplicate money or booking work? | Idempotency outcome, provider stage, retry/age metric |
| OBS-4 | Bukalaris security owner | Is tenant isolation or privileged access failing? | Security/audit outcome; no sensitive payload |

## Signal contract

Metrics use bounded operation/outcome/provider/environment labels only. Logs and
traces may contain an internal tenant/order correlation reference only under
restricted access and approved retention; they never contain credentials,
cookies, tokens, raw payment/provider payloads, address bodies, or arbitrary
user input. Inbound trace/baggage values are untrusted and are never identity.

## Initial rate-limit policy

| Operation | Key hierarchy | Policy | On `main` |
|---|---|---|---|
| Login/recovery | Trusted network + identity candidate + account | Numeric limit requires threat/capacity evidence; shared store, RL-LOGIN below | Better Auth defaults (3/10 s sign-in, 3/60 s reset) per IP, in memory |
| Seller mutation | Session identity + store + operation | Serialize/conflict-detect sensitive edits | No limiter; slug changes serialised with `pg_advisory_xact_lock(store_id)`, order transitions row-locked |
| Checkout/create payment | Cart/order idempotency + store + network | One logical attempt; bounded retries | Idempotency key + request hash per store; counters per IP/cart/phone (see "Implemented") |
| Provider webhook/job | Provider identity + event/reference | Verify then durable-deduplicate | Outbox `(kind, key)` unique; no inbound webhooks exist |
| Mengantar order booking | Store/provider queue | No unsafe parallel creation; follow verified provider rule | Outbox job per attempt + per-account advisory lock (T-39, fake adapter); writes refuse without `MENGANTAR_WRITE_ENABLED=1` |

Before a pilot, run a safe synthetic success and expected-rejection journey to
prove terminal event, trace/log correlation, metric change, redaction, and
provider/job stage behavior at the configured sink.

## Rate-limit register (proposed, 2026-10-27)

Status: Proposed; numbers are OPEN configuration values (measured before a
pilot), the columns below are the contract. Source: ADR-0009 §8, ADR-0010 §5,
12-SECURITY SEC-20/SEC-21; audit of 2026-10-27 (SPV-19, OPS-12).

**Shared limiter.** Every limit below uses one shared, DB-backed counter
(extending the existing `rate_limit` fixed-window table), so limits hold across
web replicas and the worker. The in-memory Better Auth limiter (per process,
reset on restart) is not accepted for login, recovery, OTP or sign-up: use the
auth library's database or custom storage option once verified against the
pinned version (UNVERIFIED), or the same `rate_limit` table. Keys never hold a
raw phone, email or IP: they use a keyed fingerprint (purpose key, SEC-22).
Evaluate every dimension of the key hierarchy; the request is refused when any
one is exhausted. When the client IP is unavailable the request falls into a
tight shared `unknown-ip` bucket instead of skipping the dimension. If the
limiter store is unavailable, OTP request, sign-up and login fail closed (no
SMS or email is sent) and browsing and checkout reads fail open.

**Client-IP rule per deployment topology.** The source is chosen by
configuration, never inferred from request headers: (a) direct behind the
Coolify/Traefik proxy: the last hop appended by the trusted proxy in
`X-Forwarded-For` (current behaviour); (b) behind Cloudflare (recommended in 08):
`CF-Connecting-IP`, trusted only when the origin accepts traffic from Cloudflare
ranges alone (otherwise the header is attacker-controlled and is ignored). With
Cloudflare in front, per-IP limits otherwise collapse onto edge addresses. The
deployment document records the chosen topology and the trusted-proxy list.

| ID | Operation | Key hierarchy (coarse → fine) | Behaviour on refusal | Proposed starting value (OPEN) |
|---|---|---|---|---|
| RL-LOGIN | Sign-in and recovery request, all surfaces | IP → identity candidate (fingerprint) → account | 429 with `Retry-After`; uniform response | Better Auth defaults today (3 / 10 s sign-in, 3 / 60 s reset), moved to the shared store |
| RL-OTP-REQ | Buyer OTP or magic-link request and resend | Global provider budget → IP → destination (fingerprint) → destination per day | Uniform "if this contact exists…" response, nothing sent; circuit breaker when the provider budget is spent | per destination 3 / 10 min and 10 / day; per IP 20 / 10 min |
| RL-OTP-VERIFY | OTP or magic-link verification | Challenge (attempt count) → destination → IP | The challenge is invalidated after the attempt cap; account never locked | 5 attempts per challenge |
| RL-AFF-SIGNUP | Affiliate application (AF-11 `/affiliate/apply`) | IP → email fingerprint → day | 429; no account-existence hint | 5 / hour per IP, 3 / day per email |
| RL-AFF-LOGIN | Affiliate sign-in and recovery | as RL-LOGIN on the affiliate audience | as RL-LOGIN | as RL-LOGIN |
| RL-CLICK | Referral click `GET /r/[token]` (HTTP-27) | IP → link token → affiliate → IP + link | **Redirect without capturing a click** (the buyer is never blocked) | per IP 120 / 10 min; per link 600 / 10 min |
| RL-CODE | Affiliate code resolution at checkout | IP → cart → store; invalid guesses counted separately | Same "unknown code" result and checkout continues (a code never fails checkout) | 10 invalid / 10 min per cart |
| RL-ACCT-SEARCH | Owner console account search (SA-23) | Staff → case → global | 429 "rate limited"; counted without query text | 30 / 10 min per staff |
| RL-ISSUE | "Lapor masalah" submit (SA-50) | Staff → page id | Refusal creates no record, text kept for retry | 10 / hour, burst 3 / min (UX-22) |
| RL-PUBLIC-REPORT | Public content report (SF-13, HTTP-20, Phase 2) | IP → target store/product → day, plus challenge | 429 or challenge; never an automatic takedown | OPEN until activation |
| RL-FEED-UPDATE | Public Update Log pages and `/feed.json` (UL-01, UL-02, HTTP-25) | IP | 429 + `Retry-After`; cached responses cost no DB | 120 / 10 min per IP |
| RL-FEED-CATALOG | Catalog feeds (T-40) | Store (valid token only) | 429 + `Retry-After` | 60 / store / hour (implemented) |
| RL-AUTOLARIS-CB | AutoLaris payment callback | Signature check first (before DB) → source IP → provider reference | Invalid signature: 401, no side effect, counted; replay: harmless duplicate | OPEN until provider facts are verified |
| RL-MENGANTAR-WH | Mengantar webhook (HTTP-26) | Signature check first → source IP → event key | as above | OPEN |
| RL-PARTNER-MENGANTAR | Outbound partner calls (Mengantar) | One token bucket `partner:mengantar` (DB-backed), calls from the worker only | The job waits outside its lease and retries; never holds the lease while waiting | 60 / min shared (ADR-0007, UNVERIFIED) |
| RL-PRIVACY-EXPORT | Privacy export (HTTP-18) | Subject → staff | 429 | OPEN |

Existing limits on `main` (checkout, cart, signals, feeds) are unchanged; their
keys currently embed the raw phone and IP (`rate_limit.key`, PRIV-1) and are
moved to fingerprints when the shared limiter is extended.

## OBS-5 — Owner console Log System contract

- Status: Proposed
- Owner: Bukalaris operations owner
- Source: PR-11 and PR-10.
- Statement: A restricted server-side log query service provides sanitized
  diagnostic events to the Owner console; the browser never receives sink credentials
  or unrestricted query access. This view diagnoses failures and does not
  replace the authoritative business/security audit store.
- Acceptance: A synthetic success and controlled failure appear at the actual
  configured sink and in the authorized UI, with safe correlation and page/module
  attribution. Unauthorized access is denied; synthetic sensitive canaries are
  absent. Unavailable/stale/partial results are distinguished from zero events.
- Constraints: OBS-1, OBS-2, OBS-3, OBS-4, IAM-1, NFR-4, ARCH-5.
- Evidence: Implemented on `main` 2026-10-07 (T-23): `system_log` sink,
  `/admin/logs` list and `/admin/logs/[id]` detail behind `logs.read`, redaction
  before the sink, read audit, denied access and DB-outage proof
  (`test/ops.test.ts`, `e2e/ops.spec.ts`). Not yet: external sink, retention,
  stale/partial source states, synthetic canaries at a deployed sink.
- Change history: 2026-09-18 — specified the log viewer and discovery links.
  2026-10-07 — evidence from the ops track.

Proposed event projection: event ID, timestamp, severity, environment,
service/module, stable event name, safe summary/error code, request/trace/job
correlation as available, trusted internal store context when needed, optional
Page ID, and release revision. HTTP route templates replace raw URLs/query
strings. Browser page hints are untrusted context and never authorization.
Backend jobs may have no Page ID. Correlation identifiers do not grant access.

Operator questions: Which operation failed? Which store/environment is affected?
What related events explain it? Which page/module and released code own it?
The detail view links to authorized related events and the page/module map;
source-repository links are visible only to authorized engineering users.

Queries use allowlisted filters, bounded time ranges, cursor pagination, and
server-side limits. Record privileged log access under the existing audit policy.
Retention, numeric query limits, sink, ingestion delay, and source-code link
provider remain Unknown until stack/capacity decisions. Do not expose raw
request/response bodies, customer details, credentials, form submissions, or
payment/provider payloads. A diagnostic outage must not break commerce.

The shared text scrubber (`scrubText`) is extended beyond URLs, e-mail, phone and
token shapes with NIK, NPWP and bank-account-number shapes (13-COMPLIANCE-PRIVACY
PRIV-9 "Scrubbing classes"); the Log System, case notes, audit reasons and issue
reports use the same function, and synthetic canaries of each class are tested.

## Headless and hosted-checkout signal extension

Source: PR-16, API-8 and SEC-13. Proposed events cover channel issue/revoke,
cart mutation, handoff issued/exchanged/expired/rejected, checkout submit,
provider pending and final outcome. Never log channel secrets, cart capability,
checkout cookies, handoff URL/code or raw query strings. Correlate with safe
internal request/store/channel/checkout references under restricted access;
these references are not metric labels or access credentials.

The Log System must distinguish failed handoff from payment failure. A handoff
or checkout page view is not a Purchase. Measure actual terminal order/payment
policy separately; cross-origin consent and attribution remain an explicit
integration contract before live advertising verification.

## Function attribution and diagnostic query behavior

Scope: OBS-5. Proposed operation identity uses the OpenAPI `operationId` when
an event comes from HTTP; internal jobs use a stable registered operation name.
Record `service`, `environment`, `release_revision`, `operation_id`, outcome,
and elapsed duration where they answer the operator question. Missing source
mapping remains null; never infer function names from stack text. Trace and
correlation IDs locate related events but do not authorize access.

The API currently bounds each request to 24 hours; retain its shared pagination
limit. The viewer defaults to one hour and manual refresh. Require `from < to`,
allowlisted filter values and a cursor bound to normalized filters, environment
and authorized scope. Reject changed-filter cursors. Read stable event ordering
by timestamp plus unique ID so equal timestamps do not lose or duplicate rows.

Responses identify source state as complete, partial or stale, and carry the
last-observed ingestion time when available. A wholly unavailable source returns
503, not an empty successful list. The 200 empty envelope contains `items: []`
and `next_cursor: null`. Unknown freshness is explicit. Retention and stale-age
threshold remain deployment gates; the UI cannot claim retained completeness
without sink evidence. Keep the audit of log reads separate from diagnostic
query results so opening the viewer does not recursively generate its own list.

Proof before delivery: Emit one synthetic successful operation and one bounded
failure from the actual application/worker boundary. Confirm safe operation,
release and correlation attribution at the sink, query API and Owner console viewer.
Inject synthetic sensitive canaries only in controlled fixtures and confirm
redaction before sink ingestion and again in API projection. Test denied seller
and operator access, cursor-scope changes, 24-hour overflow, partial/stale data,
and sink outage. Diagnostic backpressure must not block commerce; privileged
read-audit failure follows the separately documented audit policy.


## OBS-6 — Service-level objectives, alerts and probes

- Status: Proposed
- Owner: Bukalaris operations owner
- Source: OBS-1 to OBS-5, 14-SLA-DISASTER-RECOVERY, ADR-0006, ADR-0007, ADR-0009; audit of 2026-10-27 (OPS-14).
- Statement: Each signal below has a measured indicator, a configured alert
  threshold and a named action. Numbers are OPEN (set from measurement before a
  pilot); the list and the indicators are the contract. An alert needs an external
  sink (email or chat webhook; vendor OPEN): the in-database `system_log` is a
  diagnostic view, not an alerting channel.

| Signal | Indicator | Alert when | Action |
|---|---|---|---|
| Outbox lag | Age of the oldest runnable job per kind and priority (OBS-7) | Oldest due job older than the kind's configured bound | Check worker, replay safely |
| Scheduler liveness | Heartbeat of the periodic enqueuer (JOB-21) | Heartbeat older than two intervals | Restart scheduler; periodic jobs (billing, release, expiry) are late |
| Webhook signature failures | Rejected signatures per provider (Mengantar HTTP-26, AutoLaris callback) | Failure rate above the configured bound in a window | Suspect wrong or leaked secret; rotate (SEC-22) |
| Partner budget | Token-bucket use and 429 count of `partner:mengantar` | Use above the configured share, any sustained 429 | Reduce polling; check egress IP |
| Payout age | Oldest payout or refund in `requested` or `processing` | Older than the accepted age (SA-18, numbers OPEN) | Operator follow-up |
| Per-host TLS | Days to certificate expiry per host (apex, `owner`, `app`, `checkout`, `affiliate`, `buyer`, `logs`, `*.bukalaris.com`, `*.affiliate.bukalaris.com`, each custom domain) | Under the configured days | Renew; DNS-01 wildcard check |
| Issue-report notification | New `issue_report` rows | Any `high` or `blocking` report immediately, others in a digest | Engineer triages in SA-50; a report that cannot reach the sink is itself an alert |
| Dead-letter jobs | Count of jobs in state `dead` per kind | Above zero for money kinds, above the bound for others | Triage; audited replay (OBS-7) |
| Limiter health | Failed writes to the shared limiter store | Any sustained failure | Auth, OTP and sign-up are failing closed |
| Backup and restore rehearsal | Age of the last backup and rehearsal (DR-1) | Older than the configured bound | Run the rehearsal; it asserts grants and erasure replay (12-SECURITY SEC-23) |

**Host-aware probe.** The synthetic probe tests by host and path, not by
path-mode URLs that stop working once host dispatch lands: apex `/`, `owner`
`/login`, `app` `/login`, `affiliate` `/login`, `buyer` `/login`, `logs` `/` and a
sample storefront host `/`; it also asserts that checkout answers 404 on the
`owner` and `app` hosts (12-SECURITY SEC-3 rule) and that `/api/health` and
`/api/ready` answer per host. A probe never writes (no checkout, no order).

Proof: induce each condition in a test environment (stop the scheduler, send a
bad signature, expire a certificate in a fixture, file a `blocking` report) and
confirm the alert reaches the sink once, with no secret in the payload.

## OBS-7 — Job leases, priority, dead letters, replay and lag

- Status: Proposed
- Owner: Bukalaris operations owner
- Source: OBS-3, ADR-0009 (catalog projection), ADR-0010 (`buyer.resolve`); ARCH-5 JOB-20 to JOB-22; audit of 2026-10-27 (OPS-07).
- Statement: The single 60-second lease and one retry policy for every job kind
  (implemented) are replaced by per-kind settings: (1) **lease and heartbeat**: each kind
  declares its lease length and extends it by heartbeat while it works; a job
  never waits for a rate-limit budget while holding its lease; (2)
  **priority classes**: money (payment, shipment booking, ledger, payout) before
  identity and notification, before bulk (catalog publish, projection rebuild,
  exports, cleanup); claim order is priority then due time, with per-kind
  concurrency caps and reserved capacity so a bulk publish cannot starve money
  jobs; (3) **dead letter**: after the maximum attempts a job becomes `dead`
  (kept, with its sanitized error), never deleted, listed in the Owner console
  health view and alerted (OBS-6); (4) **audited replay**: requeueing or
  cancelling a dead job needs the capability `ops.jobs.manage` (IAM-15), writes an
  audit row, and is allowed only for kinds flagged replay-safe (idempotent);
  money kinds are reconciled by their owning service, never blindly requeued;
  (5) **rebuild**: the `affiliate_catalog` projection (JOB-20) has a full,
  resumable rebuild command under the same capability; a projection job that
  fails terminally must not leave a withdrawn offer purchasable, because the
  read path rechecks seller opt-in and offer status (stale projection data is not
  authority, IAM-13) and the dead job raises an alert; (6) **lag metrics and SLO**:
  oldest due age, attempts and dead count per kind and priority, with provisional
  completion targets that are OPEN (recommended, not decided: money jobs
  oldest-due under 2 minutes, identity and notification under 15 minutes, bulk
  under 1 hour; ADR-0010 `buyer.resolve` completion target uses the identity class).
- Acceptance: A bulk catalog publish of many items leaves money-job lag within
  its bound; a job that exceeds its lease without a heartbeat is reclaimed once; a
  poison job lands in `dead` after the cap and appears in the health view and the
  alert; replay of a replay-safe kind runs once and is audited; replay of a money
  kind is refused; a withdrawn offer whose projection job is dead is not
  purchasable.
