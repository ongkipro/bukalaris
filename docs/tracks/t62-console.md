# T-62 — Owner console shell, navigation, capability-gated menu and "Lapor masalah" control (track `t62`)

Local, uncommitted work in an isolated copy (Goal Mode, D-20, D-21, D-22). Nothing deployed, no provider called, no secret read. Base: wave 1 overlay (migration `0011`). This track adds migration `0012_t62_console.sql`.

## Result per slice

| Slice | Status |
|---|---|
| 1 Route registry and single gate | DONE |
| 2 Shell, grouped navigation, SA-14 dashboard, store list moved to `/admin/stores`, 320 px | DONE (cards only for sources that exist) |
| 3 Approvals inbox SA-28, dead-letter and job health SA-36, JOB-12 sweeper | DONE |
| 3 Staff and access screens SA-38 / SA-39, session-isolation tests | DEFERRED (see below); cross-surface cookie tests already exist (T-70 `host-mode.spec.ts`) |
| 4 `personal_data_access_event` + retention class + audit viewer SA-37 + issue viewer + redaction allowlists with canary tests | DONE; SA-34 and SA-35 are read-only |
| 5 "Lapor masalah" control, server action, `issue_report`, `issue_report_event`, read-only viewer SA-50 | DONE (no screenshots, D-18) |
| CRUXR-03 remaining "Bos" / "Super Admin" copy | DONE for the admin layout, the shell, the Log System pages, titles, the account-security page |

## What changed

### Database package

| File | Change |
|---|---|
| `drizzle/0012_t62_console.sql` (+ snapshot, journal) | Generated structure (`issue_report`, `issue_report_event`, `personal_data_access_event`, `audit_log` extension columns `actor_capability`, `purpose_code`, `case_id`, `subject_kind`, `subject_id`, `access_level`, `outcome` with CHECKs and indexes), then a hand-written section marked `===== T-62`: platform grants for the issue tables and the append-only trigger of `issue_report_event`; `personal_data_access_event` handed to `bukalaris_restricted` (create-on-schema window, revoke of every login-role grant, UPDATE trigger `append_only_guard`), its two SECURITY DEFINER functions `console_record_access(...)` (only write path) and `console_access_events(integer, bigint)` (only read path, no free-text reason), retention class `access_event` with wrapper `retention_purge_access_event(integer)`, `retention_set_period` replaced by `CREATE OR REPLACE` so the `access_event` class has no setter (like `audit_log`, until T-59b), `platform_job_kind` rows `retention.access_event` and `approval.expire`. |
| `src/ops/schema-console.ts` | Drizzle tables for the three new tables. |
| `src/ops/console-routes.ts` | `CONSOLE_ROUTES`: the one registry (path template, ARCH-5 id, capabilities, phase, group, label); `consoleNavigation(caps)`; `resolveConsolePath`. P2 and P1.5 entries (`/admin/domains`, `/admin/updates`) exist only as dormant reservations. |
| `src/ops/console.ts` | `authorizeConsole` (re-reads operator and grants, registry check, denial audit), `consoleMutation` (capability, reason code, change and audit row in one transaction, capability re-checked after the change), `consoleDashboard`, `consoleJobHealth`, `consoleProviderHealth`, `consoleSettings`, `consoleAudit`, `consoleAccessEvents`. |
| `src/ops/console-approvals.ts` | `approvalInbox` (read-only, expiry computed, bank snapshot view recorded), `decideConsoleApproval` (step-up proof issued and consumed in the decision's transaction, audit row), JOB-12 `approval.expire` schedule + handler. |
| `src/ops/console-access.ts` | `withPersonalDataAccess`: capability, purpose, case and expiry, evidence row committed in the same transaction before the loader's value can leave. Exported for T-63, T-65 and T-37. |
| `src/ops/console-issues.ts` | `reportConsoleIssue` (versioned schema, unknown keys dropped, server-resolved page id, scrub, 16 KiB, idempotent per reporter, advisory-lock serialised, rate limit with injectable clock, server-resolved log links), `consoleIssues` (viewer, re-redacts, audited). |
| `src/ops/console-redaction.ts` | Per-action audit allowlist `AUDIT_VIEW`, issue-context allowlist, `assertSafeAllowlist` (import-time: the module throws on a credential-like key), `auditView`, `redactIssueContext`. |
| `src/ops/ops.ts` | `scrubText(input, max)`: also scrubs `password/token/secret/api key/otp/cookie/authorization` pairs, 40+ character credential-shaped tokens and 8+ digit runs (PRIV-9 bank/NIK/NPWP); `MODULE_MAP` and route prefixes for the new pages (`/admin` is now `admin.overview`). |
| `src/ops/jobs/retention.ts`, `jobs.ts`, `src/worker.ts` | Access-event class and daily sweep; replay-safe flags for the two new kinds; the worker imports the approval sweeper. |
| `src/platform/isolation-registry.ts` | Entries `issue_report`, `issue_report_event` (platform, `SELECT,INSERT`), `personal_data_access_event` (restricted), the two console functions (owner `bukalaris_restricted`, execute platform) and `retention_purge_access_event`. |
| `src/ops/capabilities.ts` | The denial audit row also fills `actor_capability` and `outcome = denied`. `src/ops/capabilities-bootstrap.ts`: the local demo operator also holds the capabilities of the new screens. |
| `src/schema.ts` (+2 hunks), `src/index.ts` (+6 exports) | `audit_log` columns and indexes; exports. |
| `drizzle-pending/t59-contract.sql` | Two lines: platform `SELECT, INSERT` on the issue tables (the contract test fails when the file is stale). |

### Web

`src/lib/console-gate.ts` (`consoleGate`, `consoleActionOp`), `lib/context.ts` (`operator()` also returns the session id; `operatorOrDeny` removed, `allowed` kept), `lib/errors.ts` (`JobManageError` is a user error), `components/admin-shell.tsx` (grouped navigation, header actions, "Bukalaris · Owner"), `components/console-nav.tsx`, `components/report-issue.tsx`, `next.config.ts` (`Cache-Control: no-store` on `/admin`), account-security copy. Pages under `(operator)/admin`: `page.tsx` (dashboard), `stores/page.tsx` (moved), `approvals`, `ops`, `audit`, `issues`, `issues/[id]`, `settings`, `settings/providers`; actions `stores/actions.ts` (the old `admin/actions.ts` is merged into it), `approvals/actions.ts`, `ops/actions.ts`, `issue-actions.ts`; every existing page and action now starts with the gate.

## Decisions taken (defaults, revisable; none is an owner decision)

1. **Gate** = `authorizeConsole` on the platform pool: operator row, grants and the registry are read for every page and every action. Not-an-operator and dormant/unlisted route answer not-found; a missing capability renders the denied state. A signed-in non-operator never reaches page code (layout shows the notice), an operator without a session MFA record is sent to sign-in by `operator()` (T-60).
2. **No `active` flag on `platform_operator`**: "dead cookie" means no session, no operator row, or no MFA record. Deactivation is part of the staff screens (deferred, T-59b).
3. **Step-up for every approval decision** (approve and reject), using the T-60 window `STEP_UP_WINDOW_SECONDS` = 300 s (fresh sign-in or code in this session). The matrix does not distinguish; this is the conservative reading of "where the matrix demands it".
4. **Approval inbox**: tabs waiting / mine / decided; `waiting` includes the viewer's own pending request, marked `own` so the page shows no approve control; expiry is computed on read, the sweeper persists it; viewing the payload of a transfer approval (`payout|refund|affiliate_payout.approve_transfer`) writes a `full`/`bank` access event with purpose `payout_review`.
5. **Named conservative values (D-22 item 3)**: audit window default 24 h, maximum 7 days (`AUDIT_MAX_RANGE_MS`); issue rate limit 3 per minute and 10 per hour per staff (`ISSUE_REPORT_BURST_LIMIT`, `ISSUE_REPORT_HOURLY_LIMIT`, the figures proposed in UX-22); issue context cap 16 KiB, newest 20 requests, 10 errors, 10 failed actions.
6. **Audit redaction** is keyed by the action family (text before the first `:`); an action that is not listed shows its name and structured columns only. Free-text reasons are shown (scrubbed) only for listed families.
7. **Provider health** never says "present": the console does not read credential stores. It shows the last `system_log` event and last failure per `provider` field, and "unknown" when there is none, plus the two live gates (`MENGANTAR_WRITE_ENABLED`, `SIGNALS_LIVE`) read-only.
8. **`ops.issues.report` is not auto-granted** (see DEFERRED). The local seed operator holds it.
9. **`personal_data_access_event` follows `audit_log` retention**: class and sweep exist, no period is seeded and no setter exists until operator identity is restricted (T-59b).
10. **`/admin` is the dashboard now**; the store list is `/admin/stores`.

## Commands and observed results

All on this copy with `.env` pointing at `bukalaris_t62`, `bukalaris_t62_test`, `bukalaris_t62_e2e`, `E2E_PORT=3362`.

- `pnpm --filter @bukalaris/db generate --name t62_console` produced `0012_t62_console.sql`; the hand-written block was appended after the generated statements.
- `pnpm --filter @bukalaris/db test` (final run): **34 files, 460 tests, 460 passed** (the five new files hold 62 cases; wave 1 left 31 files and 397 tests by my count of this tree before the track). Earlier full runs found three real problems that are fixed: the credential-token scrub swallowed a long run of one letter (now needs letters and digits), `lib/console-gate.ts` is a registered platform-pool user in the import-boundary test, `/admin` maps to `admin.overview` in `ops.test.ts`.
- `pnpm lint`: clean. `pnpm typecheck`: clean (db and web). `pnpm build`: ok. `pnpm map:check`: `72 route files in code, 79 map rows (72 Implemented)` ok. `python3 docs/check-spec.py`: PASS.
- Playwright (both `desktop` and `mobile-320`), after `pnpm build`: first run of `t62 capabilities super-admin accounts ops content ui shipping security-headers` = **64 passed, 2 skipped (existing skips), 2 failed** (`t62` shell test: the dashboard title and a nav selector); after fixing, `t62.spec.ts` alone = 14 passed + the shell test 2 passed on both projects (**16/16**). Other touched specs were last observed green in the 64-passed run; the later fixes did not touch them. The full suite and `host-mode.spec.ts` were not run (conductor).
- Mutation check: removing the post-change capability re-check in `consoleMutation` fails the in-flight-revocation case (observed), restored afterwards.
- Evidence PNGs written by the e2e runs were restored to the baseline bytes; none is part of the delta.

## Tests (named)

`packages/db/test` (real PostgreSQL, 5 new files, 62 cases): `t62-routes.test.ts` (the demanded directory-derived route test: every page has a registry entry and vice versa, every page's first await is its own gate, every exported action starts with the gate, dormant routes have no page, navigation hides empty groups and P2/P1.5), `t62-console.test.ts` (gate: seller/store owner, no grant, wrong capability, revoked on the next call, expired, unlisted, dormant, deleted operator, each with its denial row; mutation: audit failure aborts, revocation in flight aborts, no side effect on refusal; dashboard sums, per-card gating, failing source isolated; health scrub; provider health; settings), `t62-audit.test.ts` (allowlist canaries: credential-like keys refused for every spelling, DTO never contains the canary, own reads audited and never listed, bounded range and filters, cursor paging; access evidence: fail closed, case/expiry/purpose, non-revealing capability, no login role can touch the restricted table, UPDATE refused for the owner, retention class and purge), `t62-issues.test.ts` (who may report, page id and linked events resolved on the server, scrub canaries for e-mail, phone, URL, bearer, NIK, NPWP and bank shapes, caps, DB bound, double submit including concurrent, per-reporter idempotency, rate limit and recovery under an injected clock, viewer re-redaction, dedupe key), `t62-approvals.test.ts` (exact payload and hash, own request, bank view logged, expired never waiting, decide with reason, self-approval refused in the service and by the CHECK, step-up per session, wrong capability, two approvers racing, rejected stays rejected, sweeper through the real scheduler and worker path). Existing tests adapted: `retention.test.ts` (new class, function and sweep kind), `rls.test.ts` (the resolver-naming check now covers resolver-owned functions only), `rls-contract.test.ts` (one new case through the narrowed platform role, new imports).

Mutation check (observed): removing the post-change capability re-check in `consoleMutation` makes "a grant revoked while the change is in flight" fail.

`apps/web/e2e/t62.spec.ts` (both viewports): shell and dashboard (brand, chip, title template, group navigation with `aria-current`, slices sum, no Bos/Super Admin), one-capability staff and dormant/unlisted routes and a seller on every new route, unauthenticated redirects, audit and issue viewers (`no-store`, canary, own read in the log), Lapor masalah from the store list and Log System (keyboard only: open, Escape, focus return, radio and textarea by keyboard, submit with Enter, focus back on the trigger; stored page ids `SA-02` and `SA-05`; stored request ids are only ones the server answered with and the seeded log event is linked), approvals (requester sees no approve control, approver reads the exact text, reason required, decision saved and bank access event written), system health requeue, settings and providers. Updated selectors in `accounts`, `capabilities`, `content`, `ops`, `super-admin`, `ui`.




## DEFERRED (with the exact missing decision or fact)

- **Staff and access screens SA-38 / SA-39** (slice 3). Not built: (a) "invite by verified e-mail" needs the real mailer and `mail_outbox` hardening (T-73, still Proposed) and an account-creation path for staff on the operator auth instance (T-59b, D-20 item 6); (b) "deactivate" needs an operator deactivation state that the current `platform_operator` (no `active` column) does not have; its design belongs to the separate operator tables of T-59b; (c) SA-39 needs a "last use" source for grants, which does not exist. The services behind grant, revoke, sensitive-grant approval and last-holder protection (T-60) are tested and unchanged. No owner decision is missing for them.
- **Default grant of `ops.issues.report` to every active staff member** (UX-22, IAM-15). It belongs to the staff-creation path (deferred above) and to `bootstrap:console`, whose event count is asserted by the T-60 tests; the console shows the control only to holders. The first real operators therefore need the grant by `grant` from a `staff.manage` holder until the staff screens exist.
- **Fresh-authentication "configured window"**: the window is the T-60 constant (300 s), not a platform setting; a setting needs the audited settings table of SA-34 (read-only here).
- **Session-isolation tests of slice 3**: the cross-surface cookie matrix already exists and passes in T-70's `host-mode.spec.ts`; this track did not duplicate it and ran only the default-host project. Production DNS/TLS evidence is a separate step.
- **SA-34 write paths** (audited reserved-label additions) and **SA-35 per-account health** (T-48): the labels are code constants changed at deploy time; no decision is missing.
- **SA-36**: webhook receipt and signature-failure counts, provider balance freshness, backup and restore-rehearsal times have no source yet; per-page function health and issue counts are T-68.
- **SA-50 queue** (filters, triage, assign, export, `dedupe` grouping) is T-68. **Issue notification to the alert sink** (OBS-6 sink is OPEN). **Pointer pick mode, subject reference ids from route params and the error-boundary digest** of the report dialog are not built (the keyboard-operable control list is; UX-22 allows either picker).
- **`shipping.margin` four-eyes enforcement** (T-60 deferral): the inbox and `consumeApproval` exist; making `setMarginRule` require an approval changes the one-person form and needs a decision on the transition, so it stays as is.
- **`data_field_class` registry** (DATA-14) and **monthly partitioning** of `personal_data_access_event` (volume threshold of DATA-16 not reached).
- **Contract step**: `t59-contract.sql` still not applied; the two new platform grants are in it and proven on the scratch schema.

## Doc changes for the conductor

- **ARCH-5** (already edited in this tree, only these rows; the seven implemented rows moved from "Planned surfaces" into the Pages table because `pnpm map:check` reads rows only there): SA-02 route and files, SA-14, SA-28, SA-34, SA-35, SA-36, SA-37, SA-50 (statuses Implemented or Implemented (partial: ...)). Not touched: SA-01 text ("`/admin` renders the store list") and the HTTP/page table row near line 808 that still says `/admin` for SA-02, plus SA-38 / SA-39 (stay Planned).
- **UX-22**: statuses of SA-14, 28, 34-37, 50 as above; the staff group has no routes yet; the dashboard lists planned cards as "Belum tersedia".
- **05-DATA-MODEL DATA-14**: `personal_data_access_event` exists as class `restricted` (two definer functions, no login-role grant); `issue_report` and `issue_report_event` exist as platform class (no `issue_report_attachment`); `audit_log` extension columns exist; DATA-16: retention class `access_event`.
- **IAM-15 / PRIV-9**: access evidence is written before a protected value leaves; no break-glass flow yet (T-63); bank snapshot view in approvals is an access event.
- **16-OBSERVABILITY**: RL-ISSUE defaults (3 per minute, 10 per hour) as named environment settings.
- **TASKS** T-62: Done locally for slices 1, 2, 4, 5 and the approvals/job-health part of slice 3; DEFERRED list above. T-68 and T-63 can build on `consoleIssues`, `withPersonalDataAccess` and `consoleMutation`.
- **AGENTS.md**: layout row for `ops/console*.ts` and `lib/console-gate.ts`; rule "every `/admin` page and action starts with the console gate; add new pages to `console-routes.ts`".
- **DECISIONS**: record the defaults 3, 5 and 6 above if the owner wants them visible.

## For the conductor when folding

- Migration `0012_t62_console` goes last or in the single fold after `0011`; its hand-written block uses `CREATE OR REPLACE FUNCTION retention_set_period` (a replacement of the `0011` definition: keep the later one).
- Registry keys added: tables `issue_report`, `issue_report_event`, `personal_data_access_event`; definer functions `console_record_access(...timestampwithtimezone...)`, `console_access_events(integer,bigint)`, `retention_purge_access_event(integer)`. Retention class `access_event` and platform kinds `retention.access_event`, `approval.expire`.
- Shared files touched: `schema.ts`, `index.ts`, `isolation-registry.ts`, `ops/ops.ts`, `ops/capabilities.ts`, `ops/jobs/{retention,jobs}.ts`, `worker.ts` (one import line), `drizzle-pending/t59-contract.sql`, `test/{rls,retention,rls-contract}.test.ts`, `next.config.ts`, `lib/context.ts`, `lib/errors.ts`, `components/admin-shell.tsx`, `docs/04-SYSTEM-ARCHITECTURE.md` rows. `T73Mailer` also edits the registry, `index.ts`, `worker.ts`, `rls-contract.test.ts`, the contract file: separate hunks.
- `T65Tax` may call `withPersonalDataAccess` for tax-identity reveals.
