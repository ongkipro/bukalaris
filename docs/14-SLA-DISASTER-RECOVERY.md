# Bukalaris Reliability and Recovery

Status: Proposal — initial three surfaces plus hosted checkout. Owner: Bukalaris
operations owner. Source: PR-14, PR-16, NFR-2, NFR-5. No SLA or availability
percentage is promised by this document.

## DR-1 — Recovery objectives and proof
- Owner: Bukalaris operations owner
- Statement: Define RPO/RTO, backup retention, restoration authority, and payment
  reconciliation window before pilot. Targets remain Unknown under Q-11.
- Acceptance: Restore a backup to an isolated environment, prove tenant and order
  consistency, and reconcile pending provider outcomes without resubmitting money.
  A backup file or provider badge alone is not restore evidence.

| Incident | First containment | Recovery proof |
|---|---|---|
| Database unavailable | Stop mutations; show truthful unavailable/pending state | Restore connection and invariants; reconcile pending work |
| Incorrect release | Stop rollout; revert compatible application artifact | Critical buyer/operator journeys on known revision |
| Data corruption | Freeze affected writes; preserve evidence and recovery point | Isolated restore and business consistency checks before cutover |
| Payment provider outage | Keep pending instruction/outcome; bounded retry | Account-approved settlement reconciliation without duplicates |
| Domain/TLS failure | Keep valid routing; expose status and platform-origin fallback links | Ownership/TLS/readiness and cross-tenant routing checks |
| Log sink unavailable | Preserve commerce; bounded diagnostic failure | Sink resumes and synthetic correlation appears |
| Credential exposure | Revoke/replace scoped grant; contain affected capability | Old credential rejected; authorized path restored |

## DR-2 — User-journey reliability
- Owner: Bukalaris operations owner
- Statement: Measure seller publication, catalog availability, cart/checkout
  completion, provider pending age, and privileged operator access separately.
- Acceptance: Each released journey has a defined good event, eligible population,
  latency/freshness window, source, owner, and actionable failure procedure.
  Numeric targets and alert thresholds require traffic/capacity evidence.

Operators must distinguish expected buyer validation from outages and provider
pending from failure. Alerts route to a named role with safe triage steps,
rollback/mitigation boundary, escalation and recovery checks. Do not page for
unactionable metrics. Customer notification policy and incident severity ownership
must be selected before live operation; no legal notification deadline is assumed.

Recovery rehearsal records environment, code/schema revision, backup timestamp,
steps, observed duration/loss, integrity queries, provider reconciliation results,
and limitations. Production restore and destructive rollback need explicit action
authorization. Never restore production personal data into an unsecured test env.
