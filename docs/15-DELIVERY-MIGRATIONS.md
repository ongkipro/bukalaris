# Bukalaris Delivery, Migration, and Verification

Status: Proposal. Owner: Bukalaris delivery owner. Source: PR-14, PR-16.
This is an implementation handoff, not a deployed system or a completed test run.

## DEL-1 — Environments and promotion
- Owner: Bukalaris delivery owner
- Statement: Separate local/test/staging/production data, origins, credentials,
  provider modes and callback destinations. Promote a reviewed immutable artifact
  through focused checks and staging evidence before live rollout.
- Acceptance: Record code/schema revision, test commands, environment and outputs;
  deployed readiness includes real critical-path and observability proof.

Prefer the repository's native package scripts. CI must run formatting/types/build
as applicable, OpenAPI validation, behavioral contract and tenant-negative tests,
fresh/upgrade migrations on isolated data, and critical browser journeys. Pin CI
actions/dependencies by the eventual repository policy; no workflow is claimed
implemented here. Secrets enter trusted runtime configuration only.

## DEL-2 — Migration and rollback
- Owner: Bukalaris data owner
- Statement: One migration authority owns versioned database changes. Review
  generated SQL, apply on clean and representative upgrade fixtures, and use
  expand/backfill/contract when old and new application versions overlap.
- Acceptance: Constraints, indexes and ownership are checked in the actual DB;
  duplicate/idempotent/concurrent cases exercise real transactions. Destructive
  changes have recovery proof and explicit deployment approval.

Do not place provider calls inside migrations or long-running DB transactions.
Separate application rollback from data rollback; reverting code cannot safely
undo payments or historical orders. Prefer forward corrections for financial
records with an audit trail. Rehearse restoration under DR-1 before a pilot.

## DEL-3 — Vertical delivery order
- Owner: Bukalaris delivery owner
- Statement: Implement an accepted vertical slice through data, permission,
  service, API, UI, telemetry and tests before expanding surface breadth.
- Acceptance: Each slice has one primary requirement, real file/page locators,
  executable checks and a recorded result; TASKS.md remains the only queue.

1. Repository/stack, operator auth, store context and tenant constraints.
2. Product creation/IDs/variants/stock → published catalog in both themes.
3. Cart → standalone hosted checkout → authorized outcome, with provider gates.
4. Seller order handling/content/settings/domains and Super Admin lifecycle/logs.
5. Private storefront channel → independent client → hosted checkout handoff.
6. Initial release evidence and recovery rehearsal. LP/MCP follows later.

Steps are dependency order, not separate rival tasks. Hosted checkout independence
and headless tokens are initial requirements; future LP must reuse their boundary.

## Behavioral verification plan

These are planned scenarios. Bind them to actual repository commands in T-18;
no placeholder command is claimed runnable against a nonexistent application.

| Layer | Minimum discriminating proof |
|---|---|
| Domain | Money totals, allowed state transitions, stable IDs/slug redirects |
| Database | Cross-store foreign keys/policies, last-unit race, unique replay result |
| API | Request/response conformance, malformed input, expired/revoked credentials, stale revisions |
| Checkout | Same cart cannot create duplicate order; provider timeout remains pending; late settlement policy |
| Headless | Separate origins; token store binding; one-use handoff; checkout refresh; registered return |
| Browser | Three initial surfaces plus checkout, both themes, keyboard, mobile/wide, recovery |
| Domains | Pending TLS, primary race, removal/reassignment, cache isolation |
| Signals | Feed/Pixel/CAPI identity fixture parity and actual provider receipt before match claims |
| Operations | Log sink-to-UI correlation, synthetic redaction, isolated restore |

## Release evidence and documentation maintenance

Record observed checks in the repository delivery contract when initialized.
While staged, README.md records only documentation validation. Do not create
runtime EVID from prose, mockups, schema lint, generated types or a green build.
Update ARCH-5 page → code → API/data → test locators in each page-changing task.
Complete smoke checks for rollback as well as rollout. T-18 owns release gates;
no staged document authorizes commit, push, provisioning or production writes.
