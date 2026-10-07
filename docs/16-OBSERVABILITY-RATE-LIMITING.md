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
| Login/recovery | Trusted network + identity candidate + account | Numeric limit requires threat/capacity evidence | Better Auth defaults (3/10 s sign-in, 3/60 s reset) per IP, in memory |
| Seller mutation | Session identity + store + operation | Serialize/conflict-detect sensitive edits | No limiter; slug changes serialised with `pg_advisory_xact_lock(store_id)`, order transitions row-locked |
| Checkout/create payment | Cart/order idempotency + store + network | One logical attempt; bounded retries | Idempotency key + request hash per store; counters per IP/cart/phone (see "Implemented") |
| Provider webhook/job | Provider identity + event/reference | Verify then durable-deduplicate | Outbox `(kind, key)` unique; no inbound webhooks exist |
| Mengantar order booking | Store/provider queue | No unsafe parallel creation; follow verified provider rule | Outbox job per attempt + per-account advisory lock (T-39, fake adapter); writes refuse without `MENGANTAR_WRITE_ENABLED=1` |

Before a pilot, run a safe synthetic success and expected-rejection journey to
prove terminal event, trace/log correlation, metric change, redaction, and
provider/job stage behavior at the configured sink.

## OBS-5 — Super Admin Log System contract

- Status: Proposed
- Owner: Bukalaris operations owner
- Source: PR-11 and PR-10.
- Statement: A restricted server-side log query service provides sanitized
  diagnostic events to Super Admin; the browser never receives sink credentials
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
release and correlation attribution at the sink, query API and Bos viewer.
Inject synthetic sensitive canaries only in controlled fixtures and confirm
redaction before sink ingestion and again in API projection. Test denied seller
and operator access, cursor-scope changes, 24-hour overflow, partial/stale data,
and sink outage. Diagnostic backpressure must not block commerce; privileged
read-audit failure follows the separately documented audit policy.

