# T-68 — Issue reports queue, export and function health (track `t68`)

Local, uncommitted work in an isolated copy (Goal Mode; D-18, D-20, D-21, D-22). Nothing deployed, no provider called, no secret read. Base: waves 1 to 3 overlay (migrations 0011 to 0014). This track adds migration `0015_t68_issues.sql` (generated structure first, then one section marked `===== T-68`).

## Result per slice

| Slice | Status |
|---|---|
| 1 Queue and detail (SA-50) | DONE |
| 2 Transitions and assignment | DONE |
| 3 Export (HTTP-23) and JOB-13 sweep | DONE (the sweep is registered and OFF: no period is set) |
| 3 Screenshot attachments, HTTP-24 | DORMANT BY DESIGN (D-18), not built |
| 4 Function health (SA-36 table, SA-14 card) | DONE |
| OBS-6 alert sink | Durable in-product record + `IssueAlertSink` interface + `FakeIssueAlertSink`; real delivery DEFERRED |

## What changed

### Database package

| File | Change |
|---|---|
| `drizzle/0015_t68_issues.sql` (+ snapshot, journal) | Generated: `issue_notification`. Hand-written `===== T-68`: platform grants (`UPDATE` on `issue_report`, `SELECT, INSERT` on `issue_notification`, append-only trigger on the latter); `issue_report_guard()` BEFORE UPDATE trigger (definer, pinned `search_path`, schema-qualified): the exact transition matrix, resolution note on resolved/wont_fix/duplicate, duplicate target exists / not self / not a duplicate / has no inbound duplicates (serialised by an advisory lock), assignee holds an unexpired `ops.issues.manage` grant and the operator is not deactivated; retention class `issue_report` (`row_filter 'false'`, no period), platform job kind `retention.issue_report`, owner-only `retention_anonymize_issues(integer, timestamptz)` (`execute: []`, injected clock) and the `retention_purge_issue_report(integer)` wrapper the platform role may call. |
| `src/ops/schema-console.ts` | `issueNotification` table. |
| `src/ops/console-issues.ts` | Extended (not duplicated): `issueFilters` (status, category, severity, page id, assignee incl. `unassigned`, date range, has log link, bounded `ilike` search with `%` `_` `\` escaped and bound as a parameter, sort), `consoleIssues` (list, counts per status, detail with event history and possible duplicates by `dedupe_key`, resolved ARCH-5 title and task), `transitionIssue`, `assignIssue`, `exportIssues`, `issueCsvCell`, `issuePageIdentity`; every new report writes an `issue_notification` (immediate for high and blocking, digest otherwise). |
| `src/ops/console-issue-health.ts` | New: `consoleFunctionHealth` (SA-36 rows per ARCH-5 id incl. `unmapped`: open by severity, oldest open age, 7-day count, 24-hour `system_log` errors of the mapped module), `IssueAlertSink`, `FakeIssueAlertSink`. |
| `src/ops/jobs/retention.ts`, `jobs.ts` | Class `issue_report`, daily sweep `retention.issue_report`, replay-safe kind policy. |
| `src/platform/isolation-registry.ts` | `issue_report` gains `UPDATE`; `issue_notification`; definer entries `retention_purge_issue_report(integer)`, `retention_anonymize_issues(integer,timestampwithtimezone)` (`execute: []`), `issue_report_guard()`. |
| `src/ops/console-routes.ts` | Registry row `/admin/issues/export` (HTTP-23, `ops.issues.manage`, no label). |
| `src/index.ts` | Two export lines. |
| `drizzle-pending/t59-contract.sql` | Two grant lines (`issue_report` UPDATE, `issue_notification`). |

### Web

`(operator)/admin/issues/page.tsx` (filter form, counts, export links, paging), `issues/[id]/page.tsx` (labelled context, page id title and task, log links only for `logs.read` holders, duplicate target, possible duplicates, triage and assignment forms, event history), `issues/actions.ts`, `issues/export/route.ts` (GET, gated by the console gate, `no-store`, `nosniff`, attachment disposition, typed 400/403), `ops/page.tsx` (function-health table for `ops.issues.manage` holders, each row links to the pre-filtered queue), `admin/page.tsx` (card rows link to the pre-filtered queue). ARCH-5 rows SA-36, SA-50, HTTP-23, JOB-13 edited in `docs/04-SYSTEM-ARCHITECTURE.md`.

## Decisions taken (defaults, revisable; none is an owner decision)

1. **Reads are audited twice**: the `issue.read` audit row (unchanged) and a `masked` access event through `withPersonalDataAccess` (purpose `issue_triage`, capability `ops.issues.manage`; the evidence row commits before the value leaves). Same for export. The purpose catalogue has no mapping for the capability, so any non-empty purpose is accepted (earlier rule).
2. **Export bound**: `ISSUE_EXPORT_MAX_ROWS` (named setting, default 1000, hard ceiling 10 000). Over the bound the export is refused (`export_too_large`) rather than truncated. Columns: id, page id, page title, task, route, category, severity, status, description, resolution note, assignee, duplicate-of, created at. No context, reporter, dedupe key or client request id. The audit row stores the filter with the search text replaced by its SHA-256 and length.
3. **Cell neutralisation**: a leading `=`, `+`, `-` or `@` gets a leading `'`; applies to every CSV cell.
4. **Assignee** is entered as the staff member's id (the page shows the viewer's own id); no staff directory is read (SA-38 belongs to T-63 and needs `staff.read`).
5. **Retention anonymises, never deletes**: description and resolution note are replaced by a fixed marker, context is emptied; ids, categories, severities, statuses, events and audit rows survive, so counts stay. Off until `ops.jobs.manage` sets a period through `retention_set_period('issue_report', …)`.
6. **`ops.issues.manage` holders may also assign themselves**; the guard only requires the assignee to hold the capability.
7. **Page title/task** come from `CONSOLE_ROUTES` labels, then `MODULE_MAP` labels, with an explicit detail-page table; task ids for pages outside T-62 are a small code table. A concrete page with no label shows "Tidak terpetakan".
8. **Transition from `duplicate`/`resolved`/`wont_fix` back to `triaged`** clears `duplicate_of`; any new decision needs a fresh note.

## Commands and observed results

All on this copy with `.env` pointing at `bukalaris_t68`, `bukalaris_t68_test`, `bukalaris_t68_e2e`, `E2E_PORT=3268`.

- `pnpm --filter @bukalaris/db generate --name t68_issues` → `0015_t68_issues.sql`; hand-written block appended.
- `pnpm lint`: clean. `pnpm typecheck`: clean (db and web). `pnpm map:check`: `97 route files in code, 98 map rows (91 Implemented)` ok. `pnpm build`: ok.
- `packages/db/test/t68-issues.test.ts`: 58 cases (36 for the full status matrix, 22 for the rest). The first full db run after the track passed 56 of 58 files; the two failures were a real defect of my own migration (the retention function used an unqualified CTE name, which the definer-function checker refuses), fixed by a subquery; `rls.test.ts`, `rls-contract.test.ts`, `t68-issues.test.ts`, `retention.test.ts` rerun: 4 files, 128 tests passed.
- **Final full run** (after the mutations were restored and the last code change): `pnpm --filter @bukalaris/db test`: **58 files, 1063 tests, 1063 passed**. `python3 docs/check-spec.py`: PASS.
- `e2e/t68.spec.ts` (both viewports): **4 passed** (two-page reports, correlation ids, inert `<script>`, assign, triage, duplicate with note, JSON and CSV export with `=cmd` canary, SA-36 count drop, keyboard-only; report-only staff see the control but not the queue and get the denied state on the queue, detail and the 403 export). `t62.spec.ts` and `ops.spec.ts` (touched surfaces): **23 passed, 1 skipped (existing skip)** on both viewports.
- A first e2e run failed on the desktop project: both viewport projects reported as the same staff member and hit RL-ISSUE (3 per minute). Fixed by one reporter per project.

## Tests (named)

`t68-issues.test.ts`: `exact transition matrix <from> → <to> allows|refuses` for all 36 pairs (an allowed pair writes one event and one audit row, a refused pair writes none), concurrent transitions have one winner and one typed conflict, duplicate target must exist / not self / not a duplicate / cycle refused even concurrently, resolution note required (3 states), assignment (non-holder refused, CAS, event plus audit, expired grant refused), audit insert failure rolls back transition and event, report-only staff refused on list, detail, export, assign and transition with five denial rows, forged non-staff session refused, app login has no grant on `issue_notification`, filters and counts with literal `%_` and injection-shaped search, audit rows for list, detail and every export plus access events, allowlisted export (no context, no canary, no reporter id), `=` `+` `-` `@` canaries in the real CSV, export refused over the bound, per-page counts equal an independent SQL query with module errors, 7-day count and oldest age, `scrubText` NIK / NPWP / bank-number canaries, one durable notification per new report (replay never doubles), fake sink carries ids only, retention off without a period then anonymise once under an injected clock keeping decision evidence. Inert `<script>`: DTO returns the text unchanged and the browser test shows it as text with no script execution.

## Mutation table (observed)

| Mutation | Named test that failed | Restored |
|---|---|---|
| `exportIssues` checked `ops.issues.report` instead of `ops.issues.manage` | `report-only staff are denied list, detail, export, transition and assignment with no report changes` | yes |
| `issueCsvCell` without the leading `'` | `CSV formula canary =cmd / +cmd / -cmd / @cmd is neutralised in the real export` (4 cases) | yes |
| `transitionIssue` UPDATE without `status = from` | `concurrent transitions have one winner, one typed conflict and one decision event` | yes |

## DEFERRED (with the exact missing decision or fact)

- **HTTP-24 and the attachment part of slice 3**: dormant by design (D-18); `issue_report_attachment` is not created; `ops.issues.attachments` stays a catalogue entry. A Phase 2 attachment design is the missing decision.
- **Real delivery to the alert sink (OBS-6)**: the sink (e-mail or chat webhook, vendor) is OPEN. Built: the durable `issue_notification` row and the `IssueAlertSink` interface with a fake. Missing: the owner's sink choice and its credentials, then a worker handler that drains unsent rows (digest cadence is a configured number, OPEN).
- **Retention period of `issue_report`**: privacy owner decision; until then the sweep does nothing.
- **Export row bound and the notification digest cadence**: named setting default 1000 / no cadence; owner numbers OPEN.
- **SA-14 card**: shows the top five pages by open count as before (not a new source).
- **Default grant of `ops.issues.report` to every active staff member** (T-62 deferral) is unchanged: it belongs to the staff creation path (T-59b).
- **Related Update Log entries in the detail** need T-69 (not built).

## Doc changes for the conductor

- **ARCH-5**: rows SA-36, SA-50, HTTP-23, JOB-13 are already edited in this tree (statuses Implemented). The SA-36 note about function health moved from "T-68" to implemented.
- **UX-22**: queue and export Implemented; HTTP-24 dormant; mention the `ISSUE_EXPORT_MAX_ROWS` default.
- **DATA-14**: `issue_notification` (platform class, SELECT and INSERT, append-only); `issue_report` now has UPDATE for the platform role behind `issue_report_guard`; retention class `issue_report`.
- **IAM-15 / PRIV-9**: issue queue reads and exports are masked access events with purpose `issue_triage`.
- **16-OBSERVABILITY**: OBS-6 issue notification row now exists in-product; the delivery sink is OPEN.
- **TASKS** T-68: Done locally for slices 1, 2, 4 and the export and sweep of slice 3; DEFERRED list above.

## For the conductor when folding

- Migration `0015_t68_issues` is the last in this fold; its hand-written block creates `issue_report_guard`, `retention_anonymize_issues`, `retention_purge_issue_report` (no replacement of earlier functions).
- Registry keys added: table `issue_notification`; `issue_report` platform privileges now `SELECT,INSERT,UPDATE`; definer functions `retention_purge_issue_report(integer)`, `retention_anonymize_issues(integer,timestampwithtimezone)`, `issue_report_guard()`.
- Shared files touched: `index.ts` (2 lines), `isolation-registry.ts`, `console-routes.ts` (1 row), `ops/jobs/{retention,jobs}.ts`, `drizzle-pending/t59-contract.sql`, `test/retention.test.ts` (one function name and one sweep kind in the lists), `test/t62-routes.test.ts` (the route-file scan now also accepts `route.ts` handlers: first await of a handler must be the gate), `docs/04-SYSTEM-ARCHITECTURE.md`. Pages edited that other tracks may also touch: `admin/page.tsx` (one line), `admin/ops/page.tsx`.
