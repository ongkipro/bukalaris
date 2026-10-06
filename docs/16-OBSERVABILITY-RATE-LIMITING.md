# Bukalaris Observability and Rate Limiting

Telemetry answers operator decisions; it does not replace audit records or
authorize a user. Sink/vendor, retention duration, and numeric limits are
Unknown until architecture and capacity evidence exist.

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

| Operation | Key hierarchy | Policy |
|---|---|---|
| Login/recovery | Trusted network + identity candidate + account | Numeric limit requires threat/capacity evidence |
| Seller mutation | Session identity + store + operation | Serialize/conflict-detect sensitive edits |
| Checkout/create payment | Cart/order idempotency + store + network | One logical attempt; bounded retries |
| Provider webhook/job | Provider identity + event/reference | Verify then durable-deduplicate |
| Mengantar order booking | Store/provider queue | No unsafe parallel creation; follow verified provider rule |

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
- Evidence: Planned checks only; no sink or viewer exists yet.
- Change history: 2026-09-18 — specified the log viewer and discovery links.

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

