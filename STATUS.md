# Bukalaris — status

Updated: 2026-11-04 (local development resumed task by task; latest owner boundary prohibits commit, push and deploy). Approved backlog committed and pushed as `70a97c1`; GitHub repository visibility verified PUBLIC by explicit owner decision. T-80 is verified Done (local commit `dd7511e`, not pushed). T-81 is verified Done locally from isolated `task/t81-store-column-grants` over that commit; next is T-82. Neither development task authorizes another push or deployment. M3 chain A delivered locally and chain B partly against fake adapters. Nothing is deployed. Task status is scoped delivery, not production acceptance.
This file owns current status. Evidence: `BUILD-LOG.md`, `docs/TASKS.md`
("M1 implementation evidence", M2 task statuses, M3 planned tasks) and the track reports in
`docs/tracks/`. Historical checkpoints below describe evidence at their recorded time; backlog code/docs are now pushed at `70a97c1`, not deployed. Existing local evidence screenshots remain excluded from that push.

## Current development

**Latest execution constraints (supersede earlier commit permission):** local only; NO commit, push or deploy. Run `uptime` before every heavy suite/stage and wait while one-minute load >4. Never overlap browser and integration suites. If corrupt Git objects or a missing commit are discovered, STOP/report; no repair writing `.git`. Final report must separate completed work with observed results per viewport, blockers and owner-decision questions.

**T-82 is active; WWW prerequisite closed.** Owner-approved local WWW alignment passed26 host cases, six320/390/1280 JSoff/on navigations, standalone/dev loopback and GET/HEAD308/exact-apex proof (`b6a8a7839`), then independent code/technical review9cf4e59a and documentation closureb2213c8d. Seven accepted source/config/spec transfer files matched byte-for-byte when applied to this worktree; default normalization/private-path denial remain unchanged. No main integration or commit.

**Completed scoped T-82 verification, not overall acceptance:** combined `b75bfc25b` lint/types/map/clean build PASS; replacement-cart and named WWW navigation regressions each at320/390/1280 PASS. Minimum320 confirmations `b6507181d` and `b4bbcb1e3` PASS: recipient quantity1 before filtered Notice, exact onePOST/click, pageerrors0 and successful cleanup. Diagnostic-only failed experiments remain recorded in the track/build log; they are not acceptance results. Existing320/1440 cart and baseline evidence is retained, not repeated on account of review/reboot.

**Render-side observation retained:** stream-close digest4188643836 recurred. Existing Log System on the owned disposable DB classifies one captured event as product-route GET rendering; browser metadata separately shows aborted RSC/prefetch GETs. Exact request correlation/cancellation cause remains unknown—not declared benign or fixed. Scoped review22835841 CLOSED diagnostic P1/P2, no issues, OK with notes to close only #30; no further probe warranted without a concrete product consequence. No framework patch, log filter or blanket abort exemption.

**Original-entry mutation experiment prepared/launching:** deliberately bypass only updateCart's delegated guard (`mode=set`, addToCart remains guarded); expect named320px recipient assertion1→9 failure, then exact source restoration/rebuild/positive confirmation. Durable checkpoint/script/backup: `/home/ongki/Documents/work/notes/bukalaris/t82-cart-original-export-proof/`. Original SHA256bdd6f990490683d1077cd2f4f324c72a275bb94a1753cd8cee1cb98df035ff5b; mutantc50395e9ab4571b2b083ead84737c10244ed92dd1adcbcca09e0deb75bcf3442. Restoration refuses unexpected edits, never git repair. Result bbd431285 exit0: guard-removal check on original updateCart (set mode only; add path kept) made the named 320px recipient check fail as intended (expected "1", received "9"). Source restored to exact SHA256 bdd6f990…ff5b, clean rebuild and the same 320px case PASS (9.5s). Logs/manifest: /home/ongki/Documents/work/notes/bukalaris/t82-cart-original-export-proof/. No residual source change.

**Checkout refusal effects (R4 gap 4, same-store part) PASS ba509ebfe (5.6s case): invalid token proven present in both the capture and the submit POST (boolean check, no payload logged); capture stored 0 contact rows, submit created 0 orders and showed the 'Muat ulang' Notice; reload with the current token captured 1 row and created exactly 1 order. First attempt bf43df1dd failed because the client re-render restored the hidden field before submit (restoredByClient=true, confirmed); the test now re-applies the value and asserts it was sent. That was a test defect, not an application bypass. Cross-store/foreign/closed-cart cookie cases are still open.**

**Pending-MFA lifecycle (R4 gaps 1 and 2, pending/challenge-cookie part) PASS be301fee8 (1.6s case), seed user owner-b, disposable DB: the password step issues a challenge without a session. A duplicated challenge cookie gets 403 at issuance. A pending-class token gets 403 on sign-out, two-factor/enable and revoke-other-sessions. Verification with a missing, invalid or duplicated token gets 403 and creates no session. Verification with the current pending token creates the session. After that, the old pending token gets 403 on sign-out and the session is kept. A freshly issued session-class token is different from the pending one and signs out.**

**Host-mode store cart host enforcement (R4 gap 3, cart part) PASS b62fa1594 (1.5s case). On toko-a.localhost the hydrated add and update worked (quantity 1→2). The identical captured update, carrying the valid rendered token and asking for quantity 9, left the quantity at 2 when sent with a self-consistent Host/Origin on a different port and on the sibling store host toko-b; the same request on the exact Host changed it to 9 (positive control). First attempt b36286fbb used Host≠Origin: Next.js itself refused it (500, 'Invalid Server Actions request') before the app check, then the test's reload aborted. That is recorded as a framework-layer refusal, not as proof of the app binding. Landing/checkout host-mode success flows are not separately exercised here.**

**Nonstandard callers on the combined candidate (R4 gap 5, valid-transport side) PASS bdd540d14: 48/48 in 9.0m at 320px and desktop across existing specs content, t37, feeds (multipart upload), t62, t68 (issue reporting, approvals with fresh code), accounts (invite, operator TOTP enrolment/sign-in) and t37 finance step-up. This proves the legitimate paths still work with the T-82 guards; it does not add new refusal cases for those callers. Two render-side 'destination stream closed early' lines and the known worker job-table fixture errors appeared; no test failed.**

**Fresh issuance (R4 gap 6) PASS b26dda1e9 (2.5s case): (1) when the token issuer returns 503 the login form sends no auth POST and shows its error; (2) when another tab signs the session out between issuance and the POST, that POST gets 403, exactly one POST is sent and nothing is replayed; (3) with that stale browser state, anonymous password recovery still sends exactly one request-password-reset POST and shows its status message.**

**Invalid cart cookies (R4 gap 4, cookie part) PASS b9d7ac959 (3.7s case), all four cases executed: a toko-a cookie carrying a toko-b cart id, a random UUID, a malformed id, and a toko-a cart closed by a real in-test checkout (exactly 1 order verified). Each add issued a new own cart, never the presented id; DB line totals of the toko-b cart and the closed cart were unchanged. Earlier attempts failed only in setup: b90a5e694 built a URL from a seeded toko-b product without a slug; bc14919af used a hand-built cookie Chromium rejected; bddc1933a passed but silently skipped the closed case (closedCovered=false) and was not accepted. The case is now mandatory.**

Final independent review (05ebe330-e1c5-4a26-8e57-d6845c29bae9; report: /home/ongki/Documents/work/notes/bukalaris/t82-final-acceptance-review-retry.md) BLOCKS T-82 acceptance. Earlier parent claims that all R4 gaps were closed are withdrawn: gaps 1–6 are PARTIAL, gap 7 is CLOSED narrowly for original updateCart only. Remaining evidence includes pending challenge replacement/expiry/replay, live-session/cart duplicate-cookie mutation boundaries, configured-host landing/checkout, invalid-capability checkout/update refusal, and nonstandard-caller refusal. Existing scoped passes remain valid, but do not establish these missing cases. Review also found sensitive matcher operands, a vacuous replacement-cookie inequality, and manual-fetch rather than authPost no-replay coverage. Targeted test edits address these three findings; verification is pending. Previous reviewer b908d879 timed out after 30 minutes without a report; no acceptance is inferred.

Review-finding verification b9705f13a PASS: lint/typecheck, three desktop cases (pending-MFA baseline, actual SecurityEnrol authPost revoked-session/no-replay, four invalid-cart-cookie cases with mandatory replacement-cookie presence and own-store quantity 7) and one host-cart case with safe boolean body comparison. This closes the three immediate test-quality findings subject to reviewer confirmation; it does not close the remaining R4 lifecycle/cookie/host/nonstandard refusal boundaries. No acceptance is inferred.

Pending-MFA lifecycle extension PASS b5dfe2d1e (12.0s case): old challenge MAC with replacement pending cookie refused 403/no session; previous fixture challenge expired server-side (exactly one fixture verification row updated), valid MAC refused natively 401/no session; replacement challenge verified 200; independently retained consumed pending cookie+MAC replay refused natively 401/no session; session transition and fresh-token sign-out control passed. Prior b74111e35 reached replay but got native 429, not accepted. Final test waits one installed native 10s rate-limit window before verification/replay, with max=3 unchanged; no guard/config relaxation.

Duplicate-cookie boundary proof PASS b70459018 (2.5s): identical and conflicting duplicate live-session cookies refuse token issuance/sign-out (403) and leave original seller product mutation unchanged after fresh read; exact unambiguous native multipart form persists. Identical/conflicting duplicate cart cookies leave quantity 1 unchanged after fresh read; exact unambiguous form changes it to 9. b215f432c was not evidence: URL-encoded transport unsupported by installed Next, including failed positive control. b7b175ef8 passed session checks/control but stopped at a test cookie-name regex that omitted the production __Host- prefix. Fixed to source-defined optional prefix; no app/guard change. Overall acceptance remains BLOCK.

Direct configured checkout-host proof PASS b05dd1776 (1.8s): a cart created on toko-a.localhost was explicitly installed as an owned fixture cookie on checkout.localhost, then its real checkout form produced exactly one order and confirmation remained on the configured checkout origin. Lint/typecheck passed. This is evidence of checkout-host CSRF audience compatibility only; it is NOT evidence of automatic cross-host cart handoff. No routing, cookie-sharing, or production gate was changed. Configured store-host landing mutation/refusal proof is now being added, with the same handoff limitation explicit.

Configured landing-host probe b6a56f0e3 FAILED during fixture creation on app.localhost: one landing_page was persisted (read-only disposable-DB count=1), but the post-submit snapshot showed login and no editor. The cause is unproven; this is an OPEN seller-host redirect observation (#31), not classified benign or accepted as merely test setup. To isolate the public store-host landing action, the next probe creates its fixture through the established single-host builder. No auth/host/redirect implementation was changed; neither this probe nor a later public-landing pass proves seller-host redirect correctness.

Configured store-host landing original mutation PASS b7c1f6198 (3.1s): fixture built through single-host seller UI; native multipart landing form on toko-a.localhost refused forged CSRF (303 recovery, no new cart/cookie), accepted current CSRF (303 /checkout?store=toko-a, exactly one own-store cart with quantity 2). Redirect was not followed; automatic cross-host handoff remains unproven/out of scope. Seller app-host redirect observation #31 remains OPEN and will receive a bounded session/render diagnostic; no app/host/auth implementation changed.

Seller-host redirect diagnostic ba615e88b FAILED its strict editor-render invariant (2.0s), confirming a real UI consequence, not a lost session: POST 200, beforeSession=true, afterSession=true, advertisedEditor=true, renderedEditor=false, renderedLogin=true, freshEditorGetWorks=true. A single owned fixture mutation persisted; fresh GET to its app-host editor returns revision 1. Lint/typecheck passed. #31 is a confirmed acceptance blocker; exact internal cause is still unproven. Installed Next createRedirectRenderResult uses initURL origin for a streamed redirect and filtered forwarded headers (action-handler.js); this is a hypothesis to review, not authorization for normalization/auth/transport compensation. No framework, routing, session or CSRF implementation changed.

Independent blocker review 5e0f1649-55ca-473d-9fca-ecc0d57a5b5c keeps #31 P1/BLOCK. Correction: installed Next getForwardedHeaders does NOT filter Host; the parent's earlier 'Host filtered' explanation is withdrawn. Post-action render/auth divergence is confirmed, but internal Host loss, cookie merging, or client RSC behavior is not attributed. Whether inherited or T82-introduced is unproven. Read-only SHA-256 comparison of standalone vs installed action-handler.js and server-ipc/utils.js MATCHES both files (d759c976… / 593daddb…), removing that source-version discrepancy candidate without tracing internal runtime. No safe concrete in-scope fix is established. Await owner approval for ONE metadata-only internal-redirect proof (destination origin, received Host, selected surface, expected-cookie presence boolean, login redirect boolean); no credential/token/session-id/body/header dumps, framework patch, normalization change, forwarded-Host trust or transport bypass. Any auth/Host integration fix requires a separate decision after that proof. No diagnostic or tests are running now.

Approved metadata proof b68c9673e (first attempt ba6cbd23d captured no metadata: Playwright ignores webServer stdout; switched to stderr, same scope). Six context.ts session resolutions on the host-mode server: every browser request carried Host=app.localhost:3285, surface=seller, expected session cookie present, session present. Exactly one request — the post-action redirect render — carried Host=localhost:3285 with x-forwarded-host=app.localhost:3285, rsc=false, surface=local, expected cookie absent, session absent → seller() redirects to login. Mechanism established by runtime + installed source: Next createRedirectRenderResult (action-handler.js:260–332) GETs the redirect target at initURL origin (next-server.js:1279–1285 builds it from fetchHostname:port), and the request Host observed by the app becomes that listener origin while the original host only survives in x-forwarded-host. Because auth surface is Host-selected (context.ts → authForHost), any successful hydrated server-action redirect on a non-local surface renders with the wrong surface. Likely inherited from the T-70 multi-host design rather than T-82 (pre-T82 listener 127.0.0.1 would also not resolve to the seller surface), but baseline runtime was not executed. Instrumentation was temporary and env-gated; source restored by fingerprint and restored build verified clean (RESTORED_BUILD_CLEAN). Logged only host strings, surface name and booleans. No safe in-scope fix: trusting x-forwarded-host is forbidden (client-suppliable), and transport/framework/normalization changes are unauthorized. Owner decision needed.

Invalid-capability checkout refusal PASS ba8bfbe61 (3.6s): the exact hydrated checkout submission for an own toko-a cart was captured and aborted before reaching the server (0 orders). Replaying the identical body/action with a real open toko-b cart cookie created no order on it; with a toko-a cart already closed by a real checkout created no second order; the rendered cart still had 0 orders. The identical replay with its own cart created exactly one order (positive control). Lint/typecheck passed.

Nonstandard-caller refusal proof PASS bb3d917b0 (2/2, desktop; seller case also b07b880b9). Seller: multipart upload (forged: no media row; current: +1), finance step-up setDestination (forged: no destination AND no step-up proof consumed; current: +1 held destination), current-user invitation acceptance (forged: no membership; current: +1). Console: per-button formAction approval — exact hydrated submission captured and aborted, replay with only the CSRF field forged left the request pending; identical replay with the current token approved it. Argument-only issue report — the token is an encrypted bound argument, so instead of tampering Next's blob the real component submitted after its session was revoked elsewhere and replaced: recoverable alert, no report; after reload exactly one report. Earlier attempts b38946ce9/b3ba38b54/bfbd36f4e failed only in setup: /seller/members has loading.tsx, so its form never renders without JS; the form is now read from the JS page while the mutation stays a native multipart post. Desktop only; no 320 run for these refusal cases.

Combined verification after the #31 fix and review follow-ups PASS b5a1c4326: map:check ok (103 route files, 125 rows), lint, typecheck, clean build; all host-mode specs 33/33 (incl. strict #31 editor render, 421 refusal matrix with multi-value/case-port/127.0.0.1 rows and request id, WWW, store-host cart, configured landing and checkout); auth-csrf + t82-callers + purchase + landing + accounts 42/42 at mobile-320 and desktop in one run. Earlier failures in b5f0a99bd/bc9b5071a/bcfda240a were test-fixture defects (cross-project TOTP/membership leak on shared seed users, sign-in 3/10s window, challenge-id regex too narrow); fixed with per-project fixture stores/users and source-derived patterns, no assertion weakened, no limiter relaxed. #31 fix (proxy refuse-only 421, D-25) reviewed ACCEPT WITH NOTES (089b6b7e); notes applied. Fingerprints: proxy.ts c0ea5b06…, auth-csrf.spec.ts acb45983…, host-mode.spec.ts 62168a3a…, t82-callers.spec.ts 358a5ea2…, helpers.ts f8d2ccde…. Baseline #31 probe at 283f322 running; final independent T-82 acceptance review next.

Baseline #31 probe b7d3ffedc at 283f322 (pre-T82, original 127.0.0.1 listener, no CSRF): seller-host landing creation persisted=true, session after=true, renderedEditor=false, renderedLogin=true — the same symptom. #31 is therefore an inherited T-70 multi-host defect, not a T-82 regression; T-82 surfaced it and D-25 fixes it. The probe ran in its own disposable DB/ports; its temporary spec was removed and the baseline worktree verified clean (BASELINE_CLEAN).

**T-82 accepted locally (2026-11-05), uncommitted in worktree `task/t82-session-csrf`; next: T-83 only after owner direction.** Final independent review 4d65c038 (`/home/ongki/Documents/work/notes/bukalaris/t82-final-acceptance-review-2.md`): ACCEPT WITH NOTES, no P0/P1; R4 gaps 1–7 and the retry review's three test-quality findings CLOSED; no assertion weakened; no reachable implementation defect found. Its P2 test notes were applied (pre-expiry live-challenge control, 429 wait on the replacement sign-in, CSRF-cause assertion on the foreign/closed checkout replay) and pass in bf4997347 (auth-csrf 22/22 at mobile-320 and desktop). Combined verification b5a1c4326: map/lint/types/clean build, host-mode 33/33, T-82 + purchase/landing/accounts 42/42 at 320 and desktop. Inherited T-70 blocker #31 (seller-host post-action render showed login; reproduced at baseline 283f322 in b7d3ffedc) fixed by the refuse-only proxy rule D-25 (review 089b6b7e ACCEPT WITH NOTES). Evidence index: `/home/ongki/Documents/work/notes/bukalaris/t82-final-evidence-index.md`. Open notes, not blocking local acceptance: render-side "destination stream closed early" GET observation (unattributed, not declared benign); worker job/scheduler_heartbeat fixture noise (T-84); D-25 production proxy check is a deploy gate (DEPLOY-COOLIFY); custom-domain resolver parity and cross-bundle action forwarding recorded in D-25; 390 px covered only for replacement-cart and WWW cohorts; the original-export mutation proof covers the cart updateCart family only. Not committed, pushed or deployed; D-20/DOM-6 non-local exposure gates unchanged.

**Superseded (kept for history):** #24 full T-82 authority/MFA/ambiguous-cookie/host/checkout-effect/nonstandard-transport/fresh-issuance/original-export mutation proof, overall verification, and #25 final independent authentication acceptance. Source-only R4 is not runtime acceptance. Do not advance to T-83 or open live/non-local gates; NO stage/commit/push/deploy.

**T-81 completed locally (2026-11-04); next: T-82.** App-role store UPDATE is limited to four profile columns; identity/lifecycle columns are denied even on its own row. Settings, governed platform lifecycle and tenant RLS remain valid. Full DB PASS: 74 files / 1400 tests; lint and DB/web typechecks PASS. Fresh Docker migration/idempotence/registry/health PASS (133 tables, 75 policies, zero differences). Populated-copy migration/parity/idempotence PASS with 6 stores / 55 products / 64 orders and protected fields unchanged, journal 17→18→18. Deliberately reintroduced broad UPDATE: named denial failed; all six source fingerprints restored exactly, followed by 82/82 focused tests passing. Independent R4 and test-closure reviews clear. Evidence and compatibility/recovery plan: `docs/tracks/t81-store-column-grants.md`. Original dev remains untouched; no T-59 production contract, full application E2E, worker/cleanup container proof, push or deployment is implied.

**T-80 completed locally (2026-11-04), commit `dd7511e`.** Catalog metadata edits cannot overwrite existing stock; initial stock remains at creation and manual deltas remain in audited Inventaris. Explicit stock-writing mutation failed expected 4 / received 5; source restored exactly. Final full DB PASS: 74 files / 1393 tests, with public local signing/fingerprint fixtures (the initial environment-only failures and 134-test recovery are recorded). Final lint/typecheck/build, 18 browser checks at 320/1440 px, map/spec/traceability and independent code/visual reviews passed; review findings were fixed. Evidence: `docs/tracks/t80-stock-safe-edit.md`, BUILD-LOG. This is scoped local acceptance, not full application E2E/Docker or production readiness (T-85 remains Planned). Gated tasks still require their named approvals. Local commits were authorized at that historical checkpoint; the latest execution constraints above supersede that permission.

**Historical documentation follow-up 2026-11-04 (owner: apply the recommendations, turn missing work into development tasks, and improve the system map).** The earlier docs-only pause is superseded for this bounded pass. D-24 records the disposition of the review; T-80 to T-94 own missing technical, verification and policy-gated work. Priority: stock lost-update protection (T-80), store-column grants (T-81), CSRF and shared auth limits (T-82/T-83), runtime/migration guards (T-76/T-77), then the current-tree verification baseline (T-85). T-84 adds worker/cleanup container proof; T-86 finishes spec/API alignment; T-87 owns full research triage. These tasks are planned, not implemented by this documentation pass. T-12 map maintenance is verified for this pass: 102 exact-owned routes, 124 current rows (117 implemented including disabled/stub entries), plus 14 passing guard fixtures; task inventory is now 94. Spec/traceability checks pass. No application tests/build/E2E/database check was run. Business/provider/legal choices stay gated on their named owner. No commit, provisioning or live-provider permission is implied.

**Parked 2026-11-01 (owner: "catat dulu, kita lanjut nanti"; documents only, development not started).** Etalashop and TokoΦ,
both their documents and their built and live systems, were studied to complete the Bukalaris documents
(`docs/research/2026-11-portfolio-scan/`). The first pass sampled the two large TokoΦ logs; the full read of the whole TokoΦ and Etalashop
Markdown corpus was completed the same day (12 lanes, every file to its last line; Etalashop is an older subset of TokoΦ;
`docs/research/2026-11-portfolio-scan/full-read/`). Owner direction: expect many further decisions, and choose the more modern
system design where it beats the TokoΦ/Etalashop pattern instead of copying it (lessons are inputs, not templates).
Resume with, in order (all documents, no code):
(1) close the open questions already decided elsewhere (Q-1 by ADR-0006, Q-5/Q-6 by D-1 and ADR-0004, Q-13, Q-16 email) and merge
the duplicate Q-12/Q-13/Q-15/Q-16 rows in `02-PRD.md`; (2) settle ADR-0001..0003 (Accepted or Superseded by ADR-0008) and note in
ADR-0007 that its file name says "hybrid" while the content is unified (D-15); (3) sync the Status lines of documents 03 to 17 with
D-20/D-21; (4) one owner decision list with a recommendation per item, recorded as D-24, built from the full read
(`docs/research/2026-11-portfolio-scan/full-read/SYNTHESIS-P1.md`, candidates D1 to D10, unique lessons U1 to U84) and: the ten Proposed PRs (PR-3, PR-6, PR-7,
PR-18, PR-23 to PR-27, PR-29 to PR-31), the scan candidates (payment anomaly queue, per-store COD conditions, consent under
PP 33/2026) and where a more modern design should replace an inherited pattern.

**Docs pass 2026-11-01 (owner: scan the portfolio, perfect the docs).** Research and its verification are in `docs/research/2026-11-portfolio-scan/`; owner documents and tasks T-76 to T-79 were updated; no code changed. Conflicts fixed: `/api/ready` wording and the missing probe script (14), Q-10 (02-PRD), the ADR-0005 amendment status, the README scope paragraph and this file's header.

**Parked 2026-10-28 (owner: stop here for now).** Working tree after commit `2ddf5d2` holds, uncommitted: hosting direction D-23 and the deploy-doc refresh,
`CLIENT_IP_HEADER`, the UI/UX polish of Seller Admin, Owner console and public pages (reports `docs/tracks/ux-*.md`), and the audit of the old 'Partial' task
statuses (`docs/tracks/audit-partial.md`). Open next, none needs the deploy: (1) T-59 contract step and T-59b/T-59c hardening, (2) the deferred P3 backlog listed per task
in `docs/TASKS.md`, (3) worker and cleanup inside `verify:docker`, (4) the affiliate chain T-53 to T-55 and T-71/T-66, (5) a design review of the public pages
(the external review step of `design-gate.py` has not run), (6) provisioning (Vultr, Coolify, Cloudflare) only after the domain exists and the owner asks.

**Goal Mode run 2026-10-28 (owner: continue the whole queue, build what needs no decision, defer the rest).** Implemented locally and
independently reviewed (three review rounds, every P1/P2 fixed with a named test): T-59 expand step, T-60, T-74, T-62, T-49, T-65, T-73
(except the real mail provider), T-57, T-37, T-63, T-50. Evidence per task is in `docs/TASKS.md` and `BUILD-LOG.md`; last full gates:
DB 73 files / 1388 tests, Playwright 207 passed / 0 failed, `verify:docker` 133 tables / 75 policies / 0 registry differences, restore rehearsal green,
migration 0011..0016 applied to a populated copy of the dev database. Also built since: T-46, T-48, T-68, T-45, T-47, T-52. Owner-decision and external-fact items are recorded as DEFERRED on each task and in
the ledger section of `docs/TASKS.md`; defaults taken on the orchestrator's recommendation are DECISIONS D-22 items 1 to 9.

Nothing running in parallel: M2 waves 1–4 are merged into `main` (wave 4 on
2026-10-07). On 2026-10-26, the M3 specification pass (`ADR-0006`, `PR-23`..`PR-26`,
`BILL-4`..`BILL-5`, `DATA-7`..`DATA-8`, `UX-14`..`UX-16`, `T-37`, `T-44`..`T-47`)
was recorded in `docs/` from the Etalashop reference pack, adapted for Mengantar.
Subscription billing is no longer deferred: `PR-18` is Proposed at Rp175.000 per store per
month (DPP), see `BILL-7`, `DATA-10`, `T-50`. On 2026-10-27 the owner also decided: seller money is
credited only for delivered and reconciled parcels (D-14, replacing the H+1 rule of D-11), unified
Bukalaris-managed shipping where Bukalaris generates a Partner Mengantar seller account per store and
controls all shipping discounts, margin, and cashback (`ADR-0007`, D-15; no `own_key` and no two-system split),
affiliate commission across all opted-in prepaid and COD orders only for delivered and reconciled parcels
with a 3-day hold default (`ADR-0009`, D-16), PPN off by default and Owner-switchable with no rate in code (D-17),
no issue-report screenshots in Phase 1 (D-18), decided 72-hour payout destination hold, self-service recovery,
and startup SLA/DR baseline (D-19), a global buyer identity (`ADR-0010`), and
the host map `owner` / `app` / `affiliate` / `buyer` / `logs`.bukalaris.com (`ADR-0008`; the interim `berkah` label was never deployed and is retired), the
Owner console (formerly Super Admin / Bos) managing sellers, affiliates and accounts (`ADR-0011`),
an online-store posture with tax and compliance relaxed for the startup phase (`ADR-0012`, D-12,
D-13), a 'Lapor masalah' issue-report button and an Update Log host. The canonical build order is
the header of `docs/TASKS.md` ("M3 chains"); tasks T-48..T-69 and T-71..T-75 were all Proposed specification on 2026-10-26 (T-75, PPN activation readiness, is deferred);
the current per-task status is the `Status:` line of each task in `docs/TASKS.md`. **Implemented locally on 2026-10-28 (working tree, not committed, nothing deployed):** T-51 (surface route
groups in `apps/web`, bounded contexts in `packages/db/src`; routes 64 before and after, no schema change) and T-70 (exact-host
dispatch per DOM-5, reserved labels, one auth instance and `__Host-` cookie names per surface, per-surface link origins).
Observed: `pnpm map:check` ok, lint and typecheck clean, `pnpm build` ok, 229 db tests (22 files) passed, Playwright 101
passed and 2 skipped including the new `*.localhost` host-mode project; details and the recorded gaps are in `docs/TASKS.md`
(T-51, T-70) and `BUILD-LOG.md`. Reviews: `docs/reviews/2026-10-27-code-vs-spec-gap-report.md` (code versus spec; lint,
typecheck and 186 db tests passed at the time) and `docs/reviews/2026-10-27-doc-audit-report.md` (102 findings
from four documentation audits, fixes applied, policy items recorded as OPEN with recommended
defaults). Drift guards: `pnpm map:check`, `python3 docs/check-spec.py`.
Demo: `pnpm db:seed:demo` store Batik Nusantara (seller admin + storefront run for real);
affiliate, subscription and seller-affiliate screens are static mockups in `docs/mockups/`.

Owner input still needed before live production calls: Q-17 legal sign-off on
holding seller COD funds (the platform advances COD cash for the unverified
Mengantar remittance lag), Mengantar write-test approval and sandbox capture of
tracking status codes, ad-platform test-event approval, email provider, VPS/DNS
for deployment.

Business direction (owner, 2026-10-06): revenue = shipping margin through a
platform-owned Mengantar account; first segment = COD sellers nationwide; ad
signals follow the TokoΦ/AdsBookCMS concept; email notifications first.
Blocking before any real COD shipment: Q-17 COD remittance (finance + legal);
Mengantar writes stay disabled until the owner approves a write test.

## What works on `main` (verified locally, 2026-10-07)

- M1 slice (auth, store-scoped catalog, storefront, cart, hosted checkout,
  Super Admin suspend) plus merged M2 wave 1:
  - Seller orders lifecycle + inventory with audited stock adjustments (T-21).
  - Password recovery, member invitations, session lifecycle, operator TOTP MFA (T-22).
  - Correlation ids, JSON logs, Log System (`/admin/logs`), error pages, `/api/ready` (T-23).
  - Store settings, two themes, product images, collections, CMS pages,
    search, Super Admin store create/detail, UI/UX pass (T-24..T-26).
  - Storefront API v1 with channel tokens and one-use checkout handoff (T-16/T-19 subset).
  - Transactional outbox + worker; payment instruction via outbox (T-32).
  - Mengantar read client, platform margin, seller pickup area (T-34 phase 1).
  - `pnpm verify`, `pnpm verify:docker`, backup/restore rehearsal, runbook (T-18).
  - Wave 2a: security headers + nonce CSP (T-29), five-digit string catalog ids
    + slug aliases + catalog audit (T-14, T-31), Mengantar shipping in checkout
    with margin snapshot (T-34), COD confirmation + risk signals (T-35),
    rate limits + cart caps/cleanup (T-30).
  - Wave 2b: email order notifications + signed status links (T-36), ad
    conversion signals in simulation (T-38), seller/admin UI pass (T-28).
  - Wave 3: PostgreSQL RLS with owner/app/platform roles (T-27, ADR-0005).
  - Wave 4 (merged 2026-10-07; migrations `0008_wave4.sql` + hand-written
    `0009_wave4_rls.sql`, five new tables, all store tables under FORCE RLS):
    - Shipment booking and tracking through the outbox on the fake adapter;
      Mengantar writes still locked, COD booking refused while Q-17 is open (T-39).
    - Token-protected Meta CSV and Google Merchant RSS catalog feeds (T-40).
    - Seller dashboard at `/seller`: KPIs, COD work queue, funnel, top products (T-41).
    - Landing pages v1 with immutable revisions and an order section at
      `/s/<slug>/lp/<page>`, independent of the store theme; storefront routes
      moved into the `(shop)` route group (T-42).
    - Buyer data export and audited redaction; retention job off by default (T-43).
    - Local demo data: `pnpm db:seed:demo` (four fictional stores, `docs/DEMO.md`).
- Gates on `main` before wave 4 (`0a3cfd8`): lint 0, typecheck 0, Vitest 137
  passed (as the RLS-bound app role), build 0, Playwright 72 passed + 2 skipped
  with a CSP-violation guard on every evidence step, `verify:docker` exit 0
  (26 policies), backup + restore rehearsal rls_ok=yes.
- Gates on `main` after wave 4 (`c1adf27`): lint 0, typecheck 0, Vitest
  186 passed (21 files), build 0, Playwright 92 passed + 2 skipped,
  `verify:docker` exit 0 (42 tables, 31 tenant policies, health 200,
  HEALTHCHECK healthy).

## Current outstanding work (reconciled 2026-11-04)

- **Security and inventory:** T-80 closed the product-edit stock lost-update defect (local `dd7511e`); T-81's four-column app UPDATE allowlist is verified Done locally with full/focused/mutation/fresh/populated/Docker proof (DB defense in depth, not a demonstrated browser exploit). T-59 has delivered only expand: the contract migration needs all consumers upgraded and explicit owner approval. T-59b separate operator identity and T-59c definer hardening remain unbuilt; T-82/T-83 track session-bound CSRF and shared auth limits. D-20 requires the CSRF work before non-local exposure.
- **Verification:** T-81 passed 74 DB files / 1400 tests, 82 restored focused tests, lint/typechecks and Docker web/migrate build plus fresh/populated migration and registry proof. T-80's 18 touched browser checks remain its scoped UI evidence. Whole-application E2E and worker/cleanup container execution were not performed in T-81; no full current-tree application verification is claimed. T-85 re-establishes the baseline; T-84 adds worker and cleanup to container proof; the independent public-page design review remains open under T-28.
- **Runtime and operations:** T-76 role proof, T-77 migration journal / fixture provenance, T-78 scannable QRIS and T-79 off-box monitoring / backup / deploy evidence are planned. Restore-time erasure replay remains open under T-33; production purge periods remain unset. Evidence from an earlier build is historical, not proof of the latest tree.
- **Remaining product work:** taxonomy T-44; affiliate wallet, portal and storefront T-53 to T-55; buyer portal T-58; statements and startup tax UI T-71/T-66; affiliate/buyer governance T-72. Delivered-local tasks keep their per-task deferred slices. Optional/deferred: marketplace T-7, custom domains T-15, MCP/visual builder T-11/T-20, external sources T-56, Compliance T-64, Phase 2 tax T-67, Update Log T-69 and PPN documents T-75.
- **External gates:** Q-17 legal custody review; Mengantar Partner Secret rotation and approved write tests; OPEN-F7/F8/F9 provider terms, reconciliation and cashback evidence; AutoLaris account/sandbox/vendor codes; ad-platform test events; mail provider/sender configuration; hosting and DNS approval. No live transaction or deployment is authorised by task completion.
- **Documentation:** T-86 owns remaining ADR-0001..0003 disposition, document-level status lines and OpenAPI parity; T-87 classifies all remaining research lessons and deferred review findings before creating more tasks. No research recommendation becomes accepted policy merely by being listed.

Resolved historical gaps (do not reopen): T-47 covers shipment privacy inventory/export/redaction, the signal placeholder guard, wave-4 demo content and example-environment additions; T-73 removes app-role mail-body privileges (real transport remains open); T-37 delivers a local ledger/payout/refund path; T-61 replaces the old 1 kg-per-line quote rule; T-70 delivers exact-host dispatch and per-surface sessions. The M2 implementation evidence above and dated track reports remain historical.

## Current decisions and external facts

| Item | Decided / still open | Owner / task |
|---|---|---|
| Stack and auth (Q-5/Q-6) | Pinned repository stack and Better Auth decided; production hosting direction is D-23, not provisioned | Architecture / T-18, T-79 |
| AutoLaris (Q-1) | Platform-managed ownership direction in ADR-0006; commercial account, profile and sandbox evidence still open | Finance + integration / T-5, T-6, T-49 |
| Checkout (Q-10) | Server stock decrement and terminal-payment/refund rules implemented locally; reservation expiry/backorder policy still open | Product + finance / T-88 |
| COD custody (Q-17) | Delivered-and-reconciled release decided; legal custody and provider settlement facts still gate real COD | Finance + legal / T-37, T-48 |
| Retention and risk sharing (Q-11/Q-14) | Retention periods undecided; COD risk remains store-scoped | Privacy / T-33, T-74 |
| Email (Q-16) | Email-first decided; real provider and sender domain open, WhatsApp integration deferred | Product / T-73 |
| Portfolio candidates | Recommendations and task links in D-24; gated items remain unaccepted | Named owners / T-87 to T-94 |
