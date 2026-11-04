# T-82 — Session-bound CSRF protection

## Execution frame

- Date: 2026-11-04.
- Worktree: `/home/ongki/Projects/bukalaris-wt/t82-session-csrf`.
- Branch/base: `task/t82-session-csrf` at `283f322dec04ab58bbc0353b25d5c4e17c58348a`.
- State: inventory and implementation-seam review complete; implementation in progress. The primitive, auth HTTP/header path, original portal/cart action checks and form transport are written but not yet runtime-accepted. HTTP/browser transition and complete transport coverage proof are still pending; do not declare the application fully CSRF-protected.
- Requirement: PR-15; accepted task T-82 and the existing D-20 item 4 / DOM-6 non-local-exposure gate. Preserve SEC-9 and IAM cookie/origin rules.
- Latest authority: local implementation/verification/independent review only; NO commit, push or deploy (supersedes earlier local-commit permission). One unfinished canonical task at a time; audit/verify/review before the next. Uptime before every heavy stage; wait at one-minute load>4; never overlap browser/integration suites. STOP/report corrupt Git objects or missing commits without self-repair writing.git. No non-local exposure, live provider activation or production acceptance; T-59 stays separate/unapplied.
- Acceptance: reject missing, forged, stale-session and cross-surface tokens before protected mutations; retain valid login, recovery and intended Server Action behavior. Keep Origin/Fetch-Metadata protection, explain independent signed/bearer authorization, keep CSRF tokens out of URLs/logs, and prove a named deliberate regression.

## Sequential combined-candidate checkpoints after WWW closure

Historical experiments retain their actual outcomes below; the latest scoped disposition appears immediately before Initial inventory.

- WWW prerequisite and its listener-origin blocker passed verification and post-task audit/P2 closure before T-82 resumed: b6a8a7839 all26 host cases and six320/390/1280 JSoff/on cases, standalone/dev loopback evidence, final9cf4e59a plus b2213c8d closure CLEAR. Historical failed flag/raw127 candidates remain in the sibling WWW track.
- Applied only accepted WWW source/config/specs into this existing worktree; all7 transferred files byte-identical to reviewed prerequisite. No next.config normalization opt-out, git merge/commit or main integration. New readonly/deny-only WWW transport route adds HTTP-33 in ARCH-5; no mutation/session authority. All prior T-82 files and unrelated work preserved.
- Corrected cart-token replacement regression now has three explicit viewport test names320/390/1280, with recipient quantity1 checked before the filtered Notice. Named host-mode regression retains explicit GET/HEAD308/absolute apex and logs three real-browser viewport steps320/390/1280. No token/cookie/binding values logged; traces off.
- Combined gate `b75bfc25b` completed exit0: lint/types/map/clean build PASS; cart replacement320/390/1280 all PASS (12.0s); named host case PASS (9.9s), explicit GET/HEAD308/exactapex plus real browser320/390/1280 steps. Load6.13 deferred browser until3.09; next host suite began2.91. No integration overlap or historical baseline/old cart cohort repeat. These scoped results are not overall/final T-82 acceptance.
- New diagnostic: one `The destination stream closed early.` digest4188643836 between cart cases, alongside known separate fixture-reset worker table warnings. Source: installed `react-server-dom-turbopack-server.node.production.js:3541-3545,3918-3920` calls abort on destination close. A standalone in-memory pending-RSC/PassThrough destruction probe reproduced the exact message with no HTTP/data effects. Original test closed contexts/reloaded after visible UI but without awaiting RSC action completion; this is a concrete cancellation mechanism, not yet a runtime attribution claim.
- Test-only fix retains all security/state assertions and exact viewport coverage; await each matched same-path POST response.finished(), recipient reload response.finished() and native document load completion before teardown. No app changes, log suppression, fixed sleeps or assertion weakening. `b8ce42677` is retesting only this changed regression at3widths with strict early-stream-close log failure, lint/types and uptime gates; reuses unchanged b75 application build. b8ce42677 FAILED exit1: lint/both typechecks PASS;320 timeout90s with finally/context.close masking awaited position,390/1280 UNRUN. Whole-response waits unproven, not a verified fix; no evidence yet of an application response defect. Independent read-only source diagnosis2d686aab-4368-4420-a327-f6dce28ede7f running; no browser/build/integration rerun pending its findings. #30 remains OPEN.
- Independent diagnosis2d686aab returned P1/BLOCK for accepting the completion-wait candidate. Source supports cancellation and unresolved RSC tasks as possibilities, not attribution; document load is not Flight EOF. Test was untracked, so historical source was not reconstructed by reviewer; earlier PASS/log evidence is from preserved run outputs. No missing Git-object error or repair occurred. Report: `/home/ongki/Documents/work/notes/bukalaris/t82-stream-lifecycle-diagnosis-review.md`.
- Following that review, bd86ba924 runs one320px case only: named5/8s phase budgets; observers installed before clicks using matched request object identities; logs fixed phase/status/completion booleans, no URLs/headers/bodies/cookies/tokens. Record request/UI state before teardown, attempt both closes independently, rethrow original phase failure rather than masking it with cleanup. One click per intended action, no replay on timeout. Application/framework source/build unchanged; traces off, load gates and browser/integration separation retained. bd86ba924 FAILED in6.4s: B addition completion timed out5s; A addition200/finished=true, B addition200/finished=false/failed=true BEFORE teardown; both cart headings visible and both contexts closed successfully. No original early-close attribution or application-failure claim. Lint/types PASS; load1.60/2.30/3.63. Removing hanging .finished waiters is necessary to avoid late target-closed errors and continue observing semantic UI state.
- Next bd0950ad4 runs one320px diagnostic: bounded finished-or-failed request events, no EOF prerequisite for cart/quantity/Notice observations; classify only exact net::ERR_ABORTED and document-cart navigation booleans, never output raw error/URL/headers/body/cookies/tokens. Security ordering and one click/action retained. Explicit final diagnostic requires all matched requests finished, so a failed/unfinished stream cannot become an acceptance PASS. Same application/build/framework, no logging filter or integration overlap. bd0950ad4 FAILED1.6s at added all-actions-finished diagnostic, NOT at security assertions: recipientquantity1-beforefilteredNotice both PASS. Beforecleanup A-addition200/failed/exactnet::ERR_ABORTED, B-addition200/finished, refusal200/failed/exactnet::ERR_ABORTED; bothcartheadingsvisible, documentCartAfalse/Btrue (B flag includes explicit reload, not initial-navigation attribution), bothcontextsclosed. No early-stream-close message in this or bd86 probe; original b75 log still unattributed. Lint/typesPASS; loads0.63/1.00/1.15. No390/1280 rerun.
- Read-only follow-up24d3e594-e349-49b9-88ef-79b28e0ef8e9 now reviews the source/evidence, validity of EOF oracle and smallest justified remaining observation/disposition; no current runtime rerun. Initial resume rejected before launch because options.output was misplaced; reported, preserved current test SHA25610905704fdc84da5ec4e548cfb7b6e8b83ad02293a91cd713eb1dfa1455ee2d8, corrected same native call once with top-level output, successfully resumed (no alternateCLI or source loss). No app bug/benign classification or final T-82 acceptance inferred.
- Follow-up24d3e594 report read in full142lines: earlier diagnostic P1 CLOSED by bounded finish-or-fail observation and preserved failure attribution. P2: all-matched-actions-finished is an unsupported extra product oracle, not accepted denial/recovery contract; remove assertion, keep observations. Verdict OK with notes for diagnostic disposition only; original one-off error and abort causes remain unproven. Report `/home/ongki/Documents/work/notes/bukalaris/t82-stream-lifecycle-followup-review.md`.
- Corrected only P2 oracle; no blanket abort exemption. Minimum b6507181d one320px confirmation running: exactly1 relevantPOST per intended click (Aproduct1/Acart1/Bproduct1/Bcart0), pageerror0, safe resource-type/navigation/monotonic event times, quantity1-beforefilteredNotice, bounded observations and both-close/primary-failure handling. Same b75 app build/framework; no broader viewport/cohort rerun, log suppression, payload capture, replay or integration overlap. b6507181d PASS exit0: lint/both typechecks,1case1.7s/total10.6s, onePOST per intended click/pageerror0/recipientquantity1-beforeNotice. Loads0.75/1.11/1.46. A-addition fetch/non-navigation exactERR_ABORTED at704ms beforeAready781ms; B-addition finished1114ms beforeBready1182ms; refusal finished1284ms; recipientreload1353→1533ms, same stream-close digest4188643836 printed between these markers. Bothcontextsclosed1611ms. Server stderr cross-process ordering is not causal correlation. This is scoped contract PASS with recurrent server warning, NOT transport-benignity/root-cause/clean-server/overall acceptance.
- Recurrence is concrete new evidence; one320px b4bbcb1e3 narrows GET/RSC/prefetch metadata around reload (fixed routeclass/resource/nav/status/times/booleans only). No rawURL/query/header values/body/cookie/token capture, framework instrumentation/patch, app/build change, unsafe POST replay, other viewport/cohort or integration overlap. Pending; no broad lifecycle expansion.
- Task tracking clarification: #24 owns remaining full T-82 implementation/regression proof (not merely this viewport milestone); #25 is final independent authentication review/verification. Neither is complete.
- Latest: b4bbcb1e3 PASS (case1.7s/total10.9s), retains quantity1-beforeNotice/exactPOST counts/pageerror0. Browser GET/RSC/prefetch200 terminal aborts are observed, including product-class requests and around recipientreload. Existing instrumentation/Log System reused without new instrumentation: a read-only aggregate on owned disposablebukalaris_t82_e2e as platform role returned one matching product-route GET event (exactmessage/digest4188643836); no rawrequestID/path/query/fields/header/body/cookie/token readout. That classifies recorded render-side request, not exact browser correlation or cancellation cause.
- Independent scoped disposition22835841-ae5f-49f3-9301-8a1cfa20dd9a read in full129lines: P1/P2 CLOSED, no issues, OK with notes to close ONLY diagnostic#30. Report `/home/ongki/Documents/work/notes/bukalaris/t82-stream-scoped-disposition-review.md`. Recurrent render observation retained as incompletely attributed; no transport-benignity/framework-fix/overallT82/WWW acceptance inferred. Stop probes absent concrete wrongstate/duplicatePOST/pageerror/missingrecovery/foregroundnavigation defect or separately approved attribution requirement. No framework/sourcepatch/logfilter/bypass/newmatrix. #30 CLOSED; #24 resumed for the remaining full T-82 proof; #25 final independent acceptance still pending.
- Remaining authority/MFA/transport/side-effect/original-export mutation verification and final independent T-82 acceptance remain pending. Do not proceed to T-83 before T-82 is verified/reviewed; live gates closed.

## Original-callable-entry mutation proof checkpoint

Prepared `/home/ongki/Documents/work/notes/bukalaris/t82-cart-original-export-proof/` (original source,manifest,run.sh); shell syntax/source/backup fingerprints PASS before mutation. Traced all cartMutation callers: only original addToCart/add and updateCart/set; original updateCart bound by cart page form. Mutant skips requireCartCsrf only for set, retaining add guard. Ownedfixture stock20 permits requested9. Named320px test must fail persisted recipient expected1/received9, not timing/transport noise. Recipient assertion has2s budget inside5s phase for unambiguous failure reporting. Script EXIT restores source only if current SHA matches exactmutant/original; refuse other edits. Always run restored clean build/positive original-entry case after expected-failure observation; persist outcome/logs outside/tmp. Interim build untrusted until positive restoration proof. Result bbd431285 exit0: guard-removal check on original updateCart (set mode only; add path kept) made the named 320px recipient check fail as intended (expected "1", received "9"). Source restored to exact SHA256 bdd6f990…ff5b, clean rebuild and the same 320px case PASS (9.5s). Logs/manifest: /home/ongki/Documents/work/notes/bukalaris/t82-cart-original-export-proof/. No residual source change. This closes R4 gap 7 for the cart entry only; other original entries rely on the earlier shared-primitive checks. Overall acceptance still pending.

## Checkout refusal effects

Checkout refusal effects (R4 gap 4, same-store part) PASS ba509ebfe (5.6s case): invalid token proven present in both the capture and the submit POST (boolean check, no payload logged); capture stored 0 contact rows, submit created 0 orders and showed the 'Muat ulang' Notice; reload with the current token captured 1 row and created exactly 1 order. First attempt bf43df1dd failed because the client re-render restored the hidden field before submit (restoredByClient=true, confirmed); the test now re-applies the value and asserts it was sent. That was a test defect, not an application bypass. Cross-store/foreign/closed-cart cookie cases are still open.

## Pending-MFA lifecycle

Pending-MFA lifecycle (R4 gaps 1 and 2, pending/challenge-cookie part) PASS be301fee8 (1.6s case), seed user owner-b, disposable DB: the password step issues a challenge without a session. A duplicated challenge cookie gets 403 at issuance. A pending-class token gets 403 on sign-out, two-factor/enable and revoke-other-sessions. Verification with a missing, invalid or duplicated token gets 403 and creates no session. Verification with the current pending token creates the session. After that, the old pending token gets 403 on sign-out and the session is kept. A freshly issued session-class token is different from the pending one and signs out. Challenge expiry was not exercised (native Better Auth expiry is unchanged).

## Store-host enforcement

Host-mode store cart host enforcement (R4 gap 3, cart part) PASS b62fa1594 (1.5s case). On toko-a.localhost the hydrated add and update worked (quantity 1→2). The identical captured update, carrying the valid rendered token and asking for quantity 9, left the quantity at 2 when sent with a self-consistent Host/Origin on a different port and on the sibling store host toko-b; the same request on the exact Host changed it to 9 (positive control). First attempt b36286fbb used Host≠Origin: Next.js itself refused it (500, 'Invalid Server Actions request') before the app check, then the test's reload aborted. That is recorded as a framework-layer refusal, not as proof of the app binding. Landing/checkout host-mode success flows are not separately exercised here.

## Nonstandard callers

Nonstandard callers on the combined candidate (R4 gap 5, valid-transport side) PASS bdd540d14: 48/48 in 9.0m at 320px and desktop across existing specs content, t37, feeds (multipart upload), t62, t68 (issue reporting, approvals with fresh code), accounts (invite, operator TOTP enrolment/sign-in) and t37 finance step-up. This proves the legitimate paths still work with the T-82 guards; it does not add new refusal cases for those callers. Two render-side 'destination stream closed early' lines and the known worker job-table fixture errors appeared; no test failed.

## Fresh issuance

Fresh issuance (R4 gap 6) PASS b26dda1e9 (2.5s case): (1) when the token issuer returns 503 the login form sends no auth POST and shows its error; (2) when another tab signs the session out between issuance and the POST, that POST gets 403, exactly one POST is sent and nothing is replayed; (3) with that stale browser state, anonymous password recovery still sends exactly one request-password-reset POST and shows its status message.

## Invalid cart cookies

Invalid cart cookies (R4 gap 4, cookie part) PASS b9d7ac959 (3.7s case), all four cases executed: a toko-a cookie carrying a toko-b cart id, a random UUID, a malformed id, and a toko-a cart closed by a real in-test checkout (exactly 1 order verified). Each add issued a new own cart, never the presented id; DB line totals of the toko-b cart and the closed cart were unchanged. Earlier attempts failed only in setup: b90a5e694 built a URL from a seeded toko-b product without a slug; bc14919af used a hand-built cookie Chromium rejected; bddc1933a passed but silently skipped the closed case (closedCovered=false) and was not accepted. The case is now mandatory.

## Final acceptance blocked

Final independent review (05ebe330-e1c5-4a26-8e57-d6845c29bae9; report: /home/ongki/Documents/work/notes/bukalaris/t82-final-acceptance-review-retry.md) BLOCKS T-82 acceptance. Earlier parent claims that all R4 gaps were closed are withdrawn: gaps 1–6 are PARTIAL, gap 7 is CLOSED narrowly for original updateCart only. Remaining evidence includes pending challenge replacement/expiry/replay, live-session/cart duplicate-cookie mutation boundaries, configured-host landing/checkout, invalid-capability checkout/update refusal, and nonstandard-caller refusal. Existing scoped passes remain valid, but do not establish these missing cases. Review also found sensitive matcher operands, a vacuous replacement-cookie inequality, and manual-fetch rather than authPost no-replay coverage. Targeted test edits address these three findings; verification is pending. Previous reviewer b908d879 timed out after 30 minutes without a report; no acceptance is inferred.

## Review-finding verification

Review-finding verification b9705f13a PASS: lint/typecheck, three desktop cases (pending-MFA baseline, actual SecurityEnrol authPost revoked-session/no-replay, four invalid-cart-cookie cases with mandatory replacement-cookie presence and own-store quantity 7) and one host-cart case with safe boolean body comparison. This closes the three immediate test-quality findings subject to reviewer confirmation; it does not close the remaining R4 lifecycle/cookie/host/nonstandard refusal boundaries. No acceptance is inferred.

## Pending challenge lifecycle extension

Pending-MFA lifecycle extension PASS b5dfe2d1e (12.0s case): old challenge MAC with replacement pending cookie refused 403/no session; previous fixture challenge expired server-side (exactly one fixture verification row updated), valid MAC refused natively 401/no session; replacement challenge verified 200; independently retained consumed pending cookie+MAC replay refused natively 401/no session; session transition and fresh-token sign-out control passed. Prior b74111e35 reached replay but got native 429, not accepted. Final test waits one installed native 10s rate-limit window before verification/replay, with max=3 unchanged; no guard/config relaxation.

## Duplicate-cookie mutation boundaries

Duplicate-cookie boundary proof PASS b70459018 (2.5s): identical and conflicting duplicate live-session cookies refuse token issuance/sign-out (403) and leave original seller product mutation unchanged after fresh read; exact unambiguous native multipart form persists. Identical/conflicting duplicate cart cookies leave quantity 1 unchanged after fresh read; exact unambiguous form changes it to 9. b215f432c was not evidence: URL-encoded transport unsupported by installed Next, including failed positive control. b7b175ef8 passed session checks/control but stopped at a test cookie-name regex that omitted the production __Host- prefix. Fixed to source-defined optional prefix; no app/guard change. Overall acceptance remains BLOCK.

## Direct configured checkout host

Direct configured checkout-host proof PASS b05dd1776 (1.8s): a cart created on toko-a.localhost was explicitly installed as an owned fixture cookie on checkout.localhost, then its real checkout form produced exactly one order and confirmation remained on the configured checkout origin. Lint/typecheck passed. This is evidence of checkout-host CSRF audience compatibility only; it is NOT evidence of automatic cross-host cart handoff. No routing, cookie-sharing, or production gate was changed. Configured store-host landing mutation/refusal proof is now being added, with the same handoff limitation explicit.

## Open seller-host fixture redirect observation

Configured landing-host probe b6a56f0e3 FAILED during fixture creation on app.localhost: one landing_page was persisted (read-only disposable-DB count=1), but the post-submit snapshot showed login and no editor. The cause is unproven; this is an OPEN seller-host redirect observation (#31), not classified benign or accepted as merely test setup. To isolate the public store-host landing action, the next probe creates its fixture through the established single-host builder. No auth/host/redirect implementation was changed; neither this probe nor a later public-landing pass proves seller-host redirect correctness.

## Configured store-host landing mutation

Configured store-host landing original mutation PASS b7c1f6198 (3.1s): fixture built through single-host seller UI; native multipart landing form on toko-a.localhost refused forged CSRF (303 recovery, no new cart/cookie), accepted current CSRF (303 /checkout?store=toko-a, exactly one own-store cart with quantity 2). Redirect was not followed; automatic cross-host handoff remains unproven/out of scope. Seller app-host redirect observation #31 remains OPEN and will receive a bounded session/render diagnostic; no app/host/auth implementation changed.

## Confirmed seller-host post-submit render blocker

Seller-host redirect diagnostic ba615e88b FAILED its strict editor-render invariant (2.0s), confirming a real UI consequence, not a lost session: POST 200, beforeSession=true, afterSession=true, advertisedEditor=true, renderedEditor=false, renderedLogin=true, freshEditorGetWorks=true. A single owned fixture mutation persisted; fresh GET to its app-host editor returns revision 1. Lint/typecheck passed. #31 is a confirmed acceptance blocker; exact internal cause is still unproven. Installed Next createRedirectRenderResult uses initURL origin for a streamed redirect and filtered forwarded headers (action-handler.js); this is a hypothesis to review, not authorization for normalization/auth/transport compensation. No framework, routing, session or CSRF implementation changed.

## Independent blocker review and approval boundary

Independent blocker review 5e0f1649-55ca-473d-9fca-ecc0d57a5b5c keeps #31 P1/BLOCK. Correction: installed Next getForwardedHeaders does NOT filter Host; the parent's earlier 'Host filtered' explanation is withdrawn. Post-action render/auth divergence is confirmed, but internal Host loss, cookie merging, or client RSC behavior is not attributed. Whether inherited or T82-introduced is unproven. Read-only SHA-256 comparison of standalone vs installed action-handler.js and server-ipc/utils.js MATCHES both files (d759c976… / 593daddb…), removing that source-version discrepancy candidate without tracing internal runtime. No safe concrete in-scope fix is established. Await owner approval for ONE metadata-only internal-redirect proof (destination origin, received Host, selected surface, expected-cookie presence boolean, login redirect boolean); no credential/token/session-id/body/header dumps, framework patch, normalization change, forwarded-Host trust or transport bypass. Any auth/Host integration fix requires a separate decision after that proof. No diagnostic or tests are running now.

## Redirect-render metadata proof (#31 root cause)

Approved metadata proof b68c9673e (first attempt ba6cbd23d captured no metadata: Playwright ignores webServer stdout; switched to stderr, same scope). Six context.ts session resolutions on the host-mode server: every browser request carried Host=app.localhost:3285, surface=seller, expected session cookie present, session present. Exactly one request — the post-action redirect render — carried Host=localhost:3285 with x-forwarded-host=app.localhost:3285, rsc=false, surface=local, expected cookie absent, session absent → seller() redirects to login. Mechanism established by runtime + installed source: Next createRedirectRenderResult (action-handler.js:260–332) GETs the redirect target at initURL origin (next-server.js:1279–1285 builds it from fetchHostname:port), and the request Host observed by the app becomes that listener origin while the original host only survives in x-forwarded-host. Because auth surface is Host-selected (context.ts → authForHost), any successful hydrated server-action redirect on a non-local surface renders with the wrong surface. Likely inherited from the T-70 multi-host design rather than T-82 (pre-T82 listener 127.0.0.1 would also not resolve to the seller surface), but baseline runtime was not executed. Instrumentation was temporary and env-gated; source restored by fingerprint and restored build verified clean (RESTORED_BUILD_CLEAN). Logged only host strings, surface name and booleans. No safe in-scope fix: trusting x-forwarded-host is forbidden (client-suppliable), and transport/framework/normalization changes are unauthorized. Owner decision needed.

## Invalid-capability checkout refusal

Invalid-capability checkout refusal PASS ba8bfbe61 (3.6s): the exact hydrated checkout submission for an own toko-a cart was captured and aborted before reaching the server (0 orders). Replaying the identical body/action with a real open toko-b cart cookie created no order on it; with a toko-a cart already closed by a real checkout created no second order; the rendered cart still had 0 orders. The identical replay with its own cart created exactly one order (positive control). Lint/typecheck passed.

## Nonstandard-caller refusals

Nonstandard-caller refusal proof PASS bb3d917b0 (2/2, desktop; seller case also b07b880b9). Seller: multipart upload (forged: no media row; current: +1), finance step-up setDestination (forged: no destination AND no step-up proof consumed; current: +1 held destination), current-user invitation acceptance (forged: no membership; current: +1). Console: per-button formAction approval — exact hydrated submission captured and aborted, replay with only the CSRF field forged left the request pending; identical replay with the current token approved it. Argument-only issue report — the token is an encrypted bound argument, so instead of tampering Next's blob the real component submitted after its session was revoked elsewhere and replaced: recoverable alert, no report; after reload exactly one report. Earlier attempts b38946ce9/b3ba38b54/bfbd36f4e failed only in setup: /seller/members has loading.tsx, so its form never renders without JS; the form is now read from the JS page while the mutation stays a native multipart post. Desktop only; no 320 run for these refusal cases.

## #31 fix and combined verification

Combined verification after the #31 fix and review follow-ups PASS b5a1c4326: map:check ok (103 route files, 125 rows), lint, typecheck, clean build; all host-mode specs 33/33 (incl. strict #31 editor render, 421 refusal matrix with multi-value/case-port/127.0.0.1 rows and request id, WWW, store-host cart, configured landing and checkout); auth-csrf + t82-callers + purchase + landing + accounts 42/42 at mobile-320 and desktop in one run. Earlier failures in b5f0a99bd/bc9b5071a/bcfda240a were test-fixture defects (cross-project TOTP/membership leak on shared seed users, sign-in 3/10s window, challenge-id regex too narrow); fixed with per-project fixture stores/users and source-derived patterns, no assertion weakened, no limiter relaxed. #31 fix (proxy refuse-only 421, D-25) reviewed ACCEPT WITH NOTES (089b6b7e); notes applied. Fingerprints: proxy.ts c0ea5b06…, auth-csrf.spec.ts acb45983…, host-mode.spec.ts 62168a3a…, t82-callers.spec.ts 358a5ea2…, helpers.ts f8d2ccde…. Baseline #31 probe at 283f322 running; final independent T-82 acceptance review next.

## Baseline reproduction of #31

Baseline #31 probe b7d3ffedc at 283f322 (pre-T82, original 127.0.0.1 listener, no CSRF): seller-host landing creation persisted=true, session after=true, renderedEditor=false, renderedLogin=true — the same symptom. #31 is therefore an inherited T-70 multi-host defect, not a T-82 regression; T-82 surfaced it and D-25 fixes it. The probe ran in its own disposable DB/ports; its temporary spec was removed and the baseline worktree verified clean (BASELINE_CLEAN).

## Final acceptance (2026-11-05)

T-82 accepted locally (2026-11-05), uncommitted in worktree `task/t82-session-csrf`; next: T-83 only after owner direction. Final independent review 4d65c038 (`/home/ongki/Documents/work/notes/bukalaris/t82-final-acceptance-review-2.md`): ACCEPT WITH NOTES, no P0/P1; R4 gaps 1–7 and the retry review's three test-quality findings CLOSED; no assertion weakened; no reachable implementation defect found. Its P2 test notes were applied (pre-expiry live-challenge control, 429 wait on the replacement sign-in, CSRF-cause assertion on the foreign/closed checkout replay) and pass in bf4997347 (auth-csrf 22/22 at mobile-320 and desktop). Combined verification b5a1c4326: map/lint/types/clean build, host-mode 33/33, T-82 + purchase/landing/accounts 42/42 at 320 and desktop. Inherited T-70 blocker #31 (seller-host post-action render showed login; reproduced at baseline 283f322 in b7d3ffedc) fixed by the refuse-only proxy rule D-25 (review 089b6b7e ACCEPT WITH NOTES). Evidence index: `/home/ongki/Documents/work/notes/bukalaris/t82-final-evidence-index.md`. Open notes, not blocking local acceptance: render-side "destination stream closed early" GET observation (unattributed, not declared benign); worker job/scheduler_heartbeat fixture noise (T-84); D-25 production proxy check is a deploy gate (DEPLOY-COOLIFY); custom-domain resolver parity and cross-bundle action forwarding recorded in D-25; 390 px covered only for replacement-cart and WWW cohorts; the original-export mutation proof covers the cart updateCart family only. Not committed, pushed or deployed; D-20/DOM-6 non-local exposure gates unchanged.

## Initial inventory

A TypeScript AST scan of application source at the base commit found **44 module-level `use server` files / 130 exported action functions**. A separate JSX search found **143 forms**; this includes read-only GET/filter forms and is not a count of mutations requiring a token. There are **21 route-handler files**. Counts are structural inventory, not runtime or security acceptance.

| Surface | Existing authority / entry seam | Inventory implications |
|---|---|---|
| Owner console actions | `consoleActionOp` in `src/lib/console-gate.ts`, then `operator` / current session and capability re-read | Preserve the existing first-statement console gate and authorization/audit behavior; do not protect only a UI wrapper while leaving original action exports callable. |
| Seller actions | Usually `sellerScope`; store switching also reads the current user directly | `sellerScope` is also called by GET pages and privacy export. Unconditionally making it a mutation-only CSRF gate would break legitimate reads. Include actions with bound IDs and no current FormData parameter. |
| Identity actions | `login/actions.ts` calls `auth.api.signOut`; `invite/actions.ts` has current-user acceptance and new-account acceptance; support recovery uses a one-time capability | Current-user invitation acceptance is a cookie-authenticated write, not exempt merely because an invitation token is present. Examine new-account and recovery authorization separately. |
| Better Auth HTTP | `/api/auth/[...all]`; browser callers share the native-fetch `authPost` helper | The handler already enforces exact surface Origin, refuses cross-site Fetch Metadata and refuses cookies without Origin. Browser sign-in, TOTP/backup verification, enrollment, revoke-other-sessions and recovery use `authPost`. |
| Server-side step-up | `src/lib/step-up.ts` calls `auth.api.verifyTOTP` | Must remain behind the caller's mutation boundary; this does not pass through the HTTP auth wrapper. |
| Storefront / hosted checkout actions | Ambient cart/capability cookies; no user session is required | Anonymous does not imply CSRF-exempt: distinguish authority supplied by an ambient cookie from an independently validated capability in a URL/body. Preserve cart, checkout, voucher and progress flows. |
| Buyer refund action | `o/[token]/actions.ts`, signed buyer order-status capability | Confirm the capability's validation/binding and absence of reliance on an authenticated user cookie before recording an exemption. |

### Route-handler boundaries

- `/api/auth/[...all]` exposes GET and POST for the selected exact-host auth instance; non-sign-in hosts are refused. Safe reads are not blanket mutation endpoints.
- Storefront API mutations (`POST /carts`, `POST /carts/:id/items`, `PATCH /carts/:id/items/:variantId`, `POST /carts/:id/checkout-handoffs`) call the existing `withChannel` adapter. Verify its credential transport and tenant binding before classifying these as independent bearer-authorized operations.
- AutoLaris callback POST validates its domain-separated, attempt-bound HMAC reference before source/reference limits and bounded body consumption. It records a callback digest and queues inquiry verification rather than treating the callback as payment success. Its existing `cb` URL capability is **not** a CSRF token and must not be replaced by browser-session authentication. No provider call is authorized by this task.
- `/api/signals` POST is anonymous event collection, not authenticated commerce/account authority. Its attribution cookies are inputs rather than user-session authorization. Do not silently convert public ingestion into a logged-in-session endpoint.
- Checkout handoff/resume GET routes and referral GET need explicit capability/continuity classification; safe-method syntax alone does not prove absence of side effects.
- Remaining route files serve health/readiness, catalog/cart reads, feeds, media and authenticated exports. Preserve existing read authorization; this inventory does not establish their complete security correctness.

## Pinned native controls inspected

- Next.js **16.3.8**, `next/dist/server/app-render/action-handler.js`: native Server Action validation compares Origin host against Host / forwarded Host and configured allowed origins. An absent Origin is allowed with a warning. This is useful existing protection, not an application session-bound token or an exact scheme-and-origin check.
- Better Auth **1.7.7**, `better-auth/dist/api/middlewares/origin-check.mjs`: installed middleware validates trusted origins/callback destinations and applies Fetch-Metadata checks to initial login forms. It does not provide the missing Bukalaris session-bound token. Keep native checks enabled.
- `src/lib/auth.ts`: per-surface Better Auth instances already separate cookie names, origins and derived secrets. Reuse this authority rather than introducing another auth instance or trusting a client-supplied surface/session identifier.
- `src/lib/auth-client.ts`: browser auth uses a small native `fetch` wrapper, not `createAuthClient`. Do not invent plugin/client APIs for a client this repository does not use.

## Selected implementation plan

The independent read-only review (`/tmp/bukalaris-t82-boundary-review.md`, 307 lines) confirms the acknowledged P1 gap and recommends action-entry validation. Its BLOCK verdict applies to completion/non-local exposure until implemented and proved; it is not a new regression or implementation acceptance.

The parent selects this bounded direction:

1. Add one Node HMAC primitive with version/class/surface/origin/store/session-or-capability separation, bounded constant-time verification, and behavioral tests. Reuse the existing auth secrets; no dependency, schema migration, nonce table, general anonymous-session subsystem or CSRF cookie.
2. Extend the existing auth HTTP handler with a reserved private/no-store token GET and a header check for actual session/pending-MFA authority. Resolve active sessions authoritatively without refresh; get pending-cookie names from native Better Auth configuration. Keep native controls and all existing exact-Origin/metadata checks. Fetch a current token before each `authPost`, with no automatic unsafe POST replay.
3. Require tokens in original portal mutation exports and existing direct-auth callers; preserve console gates before the new check. Do not change shared read helpers into unconditional mutation gates. Server-render token transport for native forms; handle argument-only and imperative callers explicitly. Any transport through existing shared presentation components must still leave enforcement in the original action and stay within the task boundary.
4. Bind storefront/cart/checkout mutations to the server-selected per-store capability and exact request surface/origin, not an incidental portal session. An absent cart has a distinct initial-cart binding, not authority over any existing cart. Reuse existing cart ownership/state checks; copy the token into checkout progress's manually constructed FormData.
5. Preserve explicitly classified independent capability/bearer/callback operations and read-only forms. Run real HTTP/native pre-JS/browser transition proofs, deliberate named mutations, lint/typecheck/build, and independent R4 implementation review before recording Done.

The proxy stays body-unaware. In particular, do not add a second multipart parser ahead of Next's existing 11 MB action decoder or rely on its separate default 10 MiB proxy clone cap as a clean body-size rejection. Existing upload constraints remain unchanged.

The parent owns integration and final proof. The complete exported-action checklist below fixes the coverage target.

Constraints for selecting the smallest implementation:

1. Validate at actual callable mutation entries, not just a rendered form wrapper.
2. Preserve plain-HTML Server Action submissions before hydration and existing console gates.
3. Cover both FormData-based and programmatically invoked/bound actions; distinguish read-only filters.
4. Bind tokens to authoritative session/capability context and surface; reject missing/forged/replayed context without protected writes.
5. Preserve anonymous login/recovery and MFA transitions without inventing an unnecessary identity subsystem.
6. If proxy-side form parsing is considered, establish bounded chunked/upload handling first; do not introduce an unbounded pre-framework body read.
7. Issue tokens through private/no-store responses or request-rendered fields, never URLs or diagnostic logs. Do not cache another session's token.
8. Stay within T-82's allowed paths or identify a required shared-file boundary before editing it.

## Verification record

- `pnpm install --offline --frozen-lockfile`: PASS; all 640 packages reused, none downloaded; no manifest/lockfile change.
- Focused pre-change auth/host baseline: PASS — **4 files / 104 tests**, **60.97 s**, exit 0, on isolated `bukalaris_t82_test`; selected `accounts.test.ts`, `host.test.ts`, `t48-accounts.test.ts`, `t63-accounts.test.ts`. Public test fixtures were supplied directly to the test command; no credential environment file was created. This establishes the existing focused service/host baseline, not T-82 HTTP/browser acceptance.
- Independent implementation-seam review: COMPLETE, read-only, no tests/builds run by reviewer. The review confirms the baseline session-token gap, recommends direct original-action entry validation and rejects unbounded proxy parsing; no application implementation has been accepted yet.
- Initial primitive tests: PASS — **1 file / 22 tests**, **3.34 s**, exit 0 (`vitest run test/auth-csrf.test.ts`). The pure MAC tests cover context replacement/separation, malformed/duplicate fields and exact-Origin policy, not live session expiry or full action/HTTP transport.
- First static gate: lint PASS; package DB typecheck FAILED (TS1295/TS1287) because the NodeNext test imported an ambiguous `.ts` file under the web package's non-ESM package declaration. Web typecheck and chained whitespace check did not run in that command. Fix: give only the new pure helper explicit `.mts` module identity and explicit imports; do not change package module types or weaken compiler flags. This is an auth-library filename-extension adjustment, not an expansion into another subsystem. Static/primitive reruns pending.
- Added `auth-csrf-token.mts` (explicit-ESM pure Node HMAC/request policy), `auth-csrf.ts` (live portal/pending-MFA/cart binding resolution), reserved auth GET `/api/auth/csrf-token`, header enforcement in the auth HTTP wrapper, and fresh token fetching in `authPost`. Existing per-surface secret derivation is exported for server-only reuse. These changes are uncommitted and not yet independently implementation-reviewed.
- Mandatory portal checks are now inserted in all **121** classified portal-session exports across **39 modules**, preserving console gate calls before verification and leaving shared GET/read helpers unchanged. Argument-only form actions receive required FormData; sign-out and issue reporting also accept an explicitly bound opaque token for existing shared presentation callers. Successful verification strips `_csrf` before business validation/processing.
- Native form fields have been added to **121** portal forms (including button-only `formAction` forms), plus current-user invitation and cart/landing/checkout forms. Request-rendered providers supply only the opaque token; GET filters remain unchanged. Checkout progress explicitly copies the hidden field into its own FormData. Existing cart mutations check before limits/writes; checkout capture/submission check before service effects. These are source changes, not complete transport acceptance.
- Required shared layout changes: Seller/Admin layouts wrap existing content in the token provider and bind sign-out/issue-report tokens; storefront/landing layouts provide the cart binding. No navigation ownership, role policy or shared component implementation changed. The allowed auth-library seam also uses `.mts` solely for explicit module identity; no compiler/package configuration was weakened.
- Web typecheck initially found the zero-argument feed-token action's `useActionState` parameter shift. Added the required previous-state parameter before FormData, preserving the native state/payload protocol. Subsequent DB and web package typechecks PASS; `git diff --check` PASS. These checks do not prove browser action behavior.
- TypeScript LSP initialization failed: it could not locate a valid TypeScript installation. TypeScript is installed in the workspace packages; configure the LSP's `tsserver.path` / workspace resolution rather than treating that failed tool as a successful check. Package lint/typecheck results are pending independently; no LSP configuration change was made.
- Primitive mutation evidence: deliberately bypassed token validation, omitted session binding, omitted surface binding, and omitted authority-class binding in turn. Each corresponding named test failed with the expected boolean assertion, exit 1. Each edit was restored in a `finally` path; source and test SHA-256 fingerprints match exactly. Manifest: `/tmp/bukalaris-t82-primitive-mutations.json`; individual logs are listed there. Restored suite PASS — **22 tests / 3.78 s**, exit 0. This proves primitive invariants, not coverage of original callable actions or the assembled HTTP stack.
- Full initial source-cohort gate PASS: `pnpm lint`, both package typechecks, **6 files / 133 focused tests / 49.18 s**, production Next build, and `git diff --check` (task `bfeccb009`, exit 0). This predates the recovery fix below.
- Independent R4 implementation review `/tmp/bukalaris-t82-implementation-review.md` identified no P0/P1 from source and one P2: expected CSRF refusals outside existing action error handling reached the generic error boundary instead of a reload instruction. No missing protected export was found by the reviewer, but this was not executable transport coverage or security acceptance.
- First production-browser attempt (`bf8d29190`, exit 1) stopped **before the intended refusal/recovery assertion**: the native settings test found zero `_csrf` fields on its repeated navigation. The failure snapshot showed the default logged-in fixture page (products), not necessarily the separate native-context page, so it cannot establish a redirect. This does **not** reproduce the P2 yet or independently identify the transport root cause. Follow-up `b66121188` (exit 1) passed explicit native route assertions for `/seller/settings`, then again found zero hidden fields. Thus no redirect was established; issuance versus SSR field placement remained to be distinguished, before any intended test mutation. A further probe records counts/type/status only, never actual tokens, and exercises the real HTTP separation checks. No unknown-outcome POST was blindly retried. Bootstrap also logged worker DB/table-not-ready errors before fixture setup finished; no worker-runtime acceptance is claimed (T-84 remains separate).
- P2 source fix written, not yet rebuilt/browser-accepted: the original redirect-form checks may name their existing server-controlled recovery route and reuse `withError`; checks still precede scope/step-up/service effects, with no automatic mutation retry. The three typed-state forms catch a CSRF DomainError at their original entry and return their existing error shape; account search catches it after the unchanged first-statement console gate. Sign-out refusal redirects to login with the constant safe message, rendered by the existing `Notice` component. No token/binding is placed in the recovery URL. Web package typecheck and whitespace PASS after these edits.
- Further diagnosis `b2bf3efc6`: **2 passed / 6 failed / 35.3 s**. Native anonymous cart create → forged update refusal → valid update passed at 320 and 1440 px. Seller metadata showed issuer **200**, token type **string**, **one hidden field** and opaque MACs present in HTML, but **zero forms under `main`**; absence of tokens was a false inference from an unsuitable selector/JS-disabled streaming boundary. Settings has a pre-existing `loading.tsx`; native seller proof now uses product detail without that boundary. Hydrated cart first-add and HTTP probes still failed: the former needs request metadata diagnosis; the latter stopped at an over-specific local Referrer-Policy expectation, before their intended security assertions.
- Issuer policy correction: Next's global `strict-origin-when-cross-origin` policy overrides the route's attempted `no-referrer`. Removed the ineffective local claim and retained/asserted the existing global policy rather than widening shared header configuration; tokens never enter URLs/referrers. Privacy/no-store and Vary Cookie assertions already passed. No global header policy was weakened or edited. Typecheck and whitespace PASS after revised tests/policy source.
- Original-build runtime diagnosis `bb4c9de71`: two native-cart cases and both HTTP cases PASS. HTTP proves rejection of the earlier same-user session's token, rejection after revocation, preservation of the other active session, and rejection across all **20 ordered pairs of the five surfaces** with the recipient's otherwise-valid cookie. Native product cases reached their original export: the **missing-token** POST left persisted metadata unchanged, then failed specifically on recovery-message visibility, reproducing the review P2 at both viewports. They stopped before forged/positive subcases. Hydrated cart still refused with the rendered token in its body; Origin comparison used Playwright's limited `request.headers()` and is not proof of a missing Origin.
- Current rebuild uses `request.allHeaders()` in test diagnostics and a **temporary boolean-only `DomainError.cause`** on cart refusals to distinguish origin, FormData transport and MAC failures. This diagnostic source is explicitly **not final/shippable** and must be removed after root-cause proof, followed by a clean rebuild/verification. Source/test scope is frozen during `b23f7f24b` (lint/typechecks → six focused files → production build → runtime cases).
- Recovery cohort `b23f7f24b` completed before reboot: lint, typechecks, focused checks and build proceeded successfully to E2E; runtime **6 PASS / 2 FAIL / 50.4 s**. Native seller missing/forged refusal, explicit recovery and valid metadata save/restore now PASS at both viewports; native cart and HTTP separation also PASS. Only the two hydrated cart cases fail. `allHeaders()` confirms the exact browser Origin and submitted MAC are present. Production error formatting did not show the temporary `cause`, so its absence is not evidence about which resolver/check failed.
- Reboot resume: worktree/HEAD and unfinished changes confirmed; no integration/commit occurred. The stopped local `bukalaris-db-1` was restarted and completed ordinary crash recovery without repair/reset/data removal, then reported healthy. No live provider or external service touched. Temporary `/tmp` review/mutation artifacts are no longer available; earlier outcomes above are historical records, not currently retrievable files. Final independent review and mutation evidence must be regenerated durably before acceptance.
- A narrow rebuilt desktop run (`bbb9e1eb2`) now records only refusal stage/boolean metadata directly, not raw headers, identifiers, capabilities or tokens; all temporary instrumentation remains a stop-ship item. No control has been relaxed to make the hydrated case pass.
- `bbb9e1eb2`: clean production build PASS; narrow desktop reproduction FAIL. Diagnostic statements existed in the built chunk, but Playwright's default server stdout suppression hid them. `bc24945ca` reused the same build/validators and temporarily exposed only the app server's stdout (worker stdout unchanged): refusal stage is **host**, `forwarded: false`; the application error record identifies **cart GET/render**, not the original mutation. Correction to earlier diagnosis: the observed UI failure did not prove the first add was refused; the subsequent internal redirect render failed. No unsafe request was automatically retried to infer an outcome.
- Root fix: retain configuration-selected origin and live cart/ownership binding in the shared resolver, but return the exact-host comparison for enforcement by `requireCartCsrf`. Read-only token issuance can run during Next's internal redirect render; every original cart/checkout mutation still requires exact Host **and** Origin/Fetch-Metadata **and** the MAC. No inbound Origin or forwarded host selects the audience. Removed all temporary server/request diagnostics and restored Playwright stdout defaults. Web typecheck/whitespace PASS; clean rebuilt runtime acceptance remains pending (`bf5ff5226`). Added native duplicate-field refusal and well-formed forged/duplicate auth-header cases.
- Clean cohort `bf5ff5226`: lint/typechecks/production build PASS; **14 runtime PASS / 3 FAIL / 1.7 min**. Hydrated cart reached the intended refusal, but both tests selected Next's additional route-announcer `role=alert` as well as the actual Notice. A separate existing WWW assertion received relative `/x`, not the required canonical URL; no routing assertion was relaxed.
- Follow-up `b6c1161a9`: scope recovery to the Notice containing `Muat ulang` and read the recipient cart quantity **before** checking recovery. Both **320/1440 hydrated cart cases PASS**, proving positive initial additions plus rejection of A's rendered token under B's replacement capability with B's quantity still `1`. A stronger real-browser WWW navigation instead reproduces **ERR_TOO_MANY_REDIRECTS**. This is a real observed routing blocker, not merely an HTTP-header formatting discrepancy.
- Baseline check in progress (`b93a0c56a`): separate clean detached worktree `t82-www-baseline` at `283f322`, isolated ports `3382/3385` and disposable `bukalaris_t82_baseline_20261104_e2e`. Original proxy, Next config and host dispatcher are byte-unchanged by T-82 (`git diff 283f322 --` those paths is empty). Reproduce the original exact-host test without T-82 helpers before attributing the loop or proposing any broader routing change. Canonical WWW expectations, local-only binding and D-20/DOM-6 gates remain unchanged.
- Baseline `b93a0c56a`: offline install and production build PASS; original unmodified host test at **283f322** FAILS with the identical mismatch, expected `http://localhost:3385/x`, received `/x`. Therefore the canonical redirect defect predates T-82; the current real-browser loop is not attributed to the CSRF change. Existing bootstrap worker/table errors occurred before fixture setup as in other runs; they are not worker acceptance evidence. Routing source remains unchanged. A global Next/proxy normalization fix is a separate scope decision requiring owner approval; no config workaround, skipped assertion, commit or integration was applied. Task remains open while that decision and the remaining T-82 verification are pending.
- Restored-session independent R4 source review **6bb21987-b8fa-424b-aff4-a1f89110a33e** completed: **no issues found, OK with notes**; reviewed original callable exports, console gates, live/pending authority, MAC separation, issuance/mutation host split, privacy, exemptions and expected-refusal recovery. Durable report: `/home/ongki/Documents/work/notes/bukalaris/t82-session-csrf-resumed-r4-review.md` (216 lines). Six source fingerprints are recorded there as parent-supplied, not independently computed. No tests/build/browser/DB work was performed by the reviewer; no executable or production acceptance follows from this verdict.
- Reviewer identified verification gaps, not defects: actual pending-MFA lifecycle and ambiguous-cookie cases; negative cart Host/port and host-mode transport; refused checkout/capture effect checks; representative console/argument-only/upload/report/invite/step-up callers; issuance failure/session-transition no-replay; and original-entry deliberate mutation evidence. Previously completed baseline and hydrated-cart checks must not be rerun merely because of this review.
- Owner subsequently approved the bounded WWW routing prerequisite first, in a separate worktree, including a necessary global Next normalization option, full host regressions and independent review. If it spreads beyond WWW routing, stop and record an OPEN owner item in STATUS.md. That prerequisite is now in `t82-www-routing` / `fix/www-canonical-routing`; T-82 source remains unchanged while it runs. No push/deploy authorization.
- WWW prerequisite review `001fa662-b458-4c60-9ad9-ed70fde8f234` subsequently **BLOCKED** the global-flag candidate despite 19 passing scoped cases: parent verified non-WWW raw/internal query propagation and a conditional downstream relativization layer. This is source evidence, not an invented runtime failure or auth-bypass result. Work stopped at the owner's boundary; an OPEN decision is recorded in both worktree STATUS.md files. No compensating routing edits, integration, commit, push or deploy.
- Latest explicit owner requirement: confirm the two corrected regressions (cart Notice versus route-announcer strictness, and real WWW navigation) at **320/390/1280**. These additional confirmations are NOT RUN yet. DOM-5 proof must include WWW **GET/HEAD status 308 and apex destination**, not final destination alone. A relative Location from loopback transport with overridden WWW Host supplies no apex authority; resolving it against an assumed apex would manufacture evidence. Preserve explicit status/absolute-header assertions and actual WWW navigation after an accepted fix. Overall verification and final independent acceptance remain unfinished; the preceding clear source review is not final runtime acceptance.
- Original-export mutation evidence, remaining HTTP/native-pre-JS/browser acceptance and final independent acceptance remain pending. T-82 remains incomplete and the non-local-exposure gate remains closed.

## Complete exported-action coverage checklist (base inventory)

Each row names an original exported entry, not only its usual UI caller. These are planned validation classes, not claims of implemented enforcement. Paths are relative to `apps/web/src/app/`.

| Module | Export | Authority class |
|---|---|---|
| `(checkout)/checkout/actions.ts` | `previewVoucher` | read-only cart quote |
| `(checkout)/checkout/actions.ts` | `captureProgress` | ambient cart capability |
| `(checkout)/checkout/actions.ts` | `submitCheckout` | ambient cart capability |
| `(identity)/account/support-recovery/[token]/actions.ts` | `redeemSupportRecoveryAction` | independent capability |
| `(identity)/invite/actions.ts` | `acceptAsCurrentUser` | portal session |
| `(identity)/invite/actions.ts` | `acceptAsNewAccount` | independent capability |
| `(identity)/login/actions.ts` | `signOut` | portal session |
| `(operator)/admin/accounts/actions.ts` | `revokeSessionsAction` | portal session |
| `(operator)/admin/accounts/actions.ts` | `startRecoveryAction` | portal session |
| `(operator)/admin/accounts/actions.ts` | `suspendAction` | portal session |
| `(operator)/admin/accounts/actions.ts` | `requestMfaResetAction` | portal session |
| `(operator)/admin/accounts/actions.ts` | `executeMfaResetAction` | portal session |
| `(operator)/admin/accounts/actions.ts` | `revealAction` | portal session |
| `(operator)/admin/accounts/actions.ts` | `searchAccountsAction` | portal session |
| `(operator)/admin/approvals/actions.ts` | `decideApprovalAction` | portal session |
| `(operator)/admin/billing/actions.ts` | `createInvoiceAction` | portal session |
| `(operator)/admin/billing/actions.ts` | `setPpnAction` | portal session |
| `(operator)/admin/billing/actions.ts` | `changeDaysAction` | portal session |
| `(operator)/admin/billing/actions.ts` | `setControlsAction` | portal session |
| `(operator)/admin/billing/actions.ts` | `requestPriceAction` | portal session |
| `(operator)/admin/billing/actions.ts` | `changePriceAction` | portal session |
| `(operator)/admin/billing/actions.ts` | `requestCompAction` | portal session |
| `(operator)/admin/billing/actions.ts` | `grantCompAction` | portal session |
| `(operator)/admin/billing/invoices/[id]/actions.ts` | `requestMarkPaidAction` | portal session |
| `(operator)/admin/billing/invoices/[id]/actions.ts` | `markPaidAction` | portal session |
| `(operator)/admin/billing/invoices/[id]/actions.ts` | `voidInvoiceAction` | portal session |
| `(operator)/admin/billing/invoices/[id]/actions.ts` | `failUnknownAttemptAction` | portal session |
| `(operator)/admin/cases/actions.ts` | `openCaseAction` | portal session |
| `(operator)/admin/cases/actions.ts` | `addNoteAction` | portal session |
| `(operator)/admin/cases/actions.ts` | `moveCaseAction` | portal session |
| `(operator)/admin/issue-actions.ts` | `reportIssueAction` | portal session |
| `(operator)/admin/issues/actions.ts` | `transitionIssueAction` | portal session |
| `(operator)/admin/issues/actions.ts` | `assignIssueAction` | portal session |
| `(operator)/admin/money/actions.ts` | `requestAdjustmentAction` | portal session |
| `(operator)/admin/money/actions.ts` | `applyAdjustmentAction` | portal session |
| `(operator)/admin/money/cod-reconciliation/[batchId]/actions.ts` | `submitBatchAction` | portal session |
| `(operator)/admin/money/cod-reconciliation/[batchId]/actions.ts` | `applyBatchAction` | portal session |
| `(operator)/admin/money/cod-reconciliation/[batchId]/actions.ts` | `voidItemAction` | portal session |
| `(operator)/admin/money/cod-reconciliation/[batchId]/actions.ts` | `voidBatchAction` | portal session |
| `(operator)/admin/money/cod-reconciliation/[batchId]/actions.ts` | `voidStaleBatchAction` | portal session |
| `(operator)/admin/money/cod-reconciliation/actions.ts` | `prepareBatchAction` | portal session |
| `(operator)/admin/money/cod-reconciliation/actions.ts` | `requestManualCompleteAction` | portal session |
| `(operator)/admin/money/cod-reconciliation/actions.ts` | `applyManualCompleteAction` | portal session |
| `(operator)/admin/ops/actions.ts` | `requeueJobAction` | portal session |
| `(operator)/admin/ops/actions.ts` | `resolveJobAction` | portal session |
| `(operator)/admin/payouts/[kind]/[id]/actions.ts` | `requestApprovalAction` | portal session |
| `(operator)/admin/payouts/[kind]/[id]/actions.ts` | `executeApprovalAction` | portal session |
| `(operator)/admin/payouts/[kind]/[id]/actions.ts` | `claimAction` | portal session |
| `(operator)/admin/payouts/[kind]/[id]/actions.ts` | `unknownAction` | portal session |
| `(operator)/admin/payouts/[kind]/[id]/actions.ts` | `completeAction` | portal session |
| `(operator)/admin/payouts/[kind]/[id]/actions.ts` | `rejectDirectAction` | portal session |
| `(operator)/admin/payouts/[kind]/[id]/actions.ts` | `requestRejectAction` | portal session |
| `(operator)/admin/payouts/[kind]/[id]/actions.ts` | `executeRejectAction` | portal session |
| `(operator)/admin/payouts/[kind]/[id]/actions.ts` | `reopenRefundAction` | portal session |
| `(operator)/admin/payouts/actions.ts` | `setFreezeAction` | portal session |
| `(operator)/admin/risk/actions.ts` | `acknowledgeRiskAction` | portal session |
| `(operator)/admin/shipping/actions.ts` | `requestMarginAction` | portal session |
| `(operator)/admin/shipping/actions.ts` | `applyMarginAction` | portal session |
| `(operator)/admin/shipping/actions.ts` | `requestSettingsAction` | portal session |
| `(operator)/admin/shipping/actions.ts` | `applySettingsAction` | portal session |
| `(operator)/admin/shipping/actions.ts` | `saveCashbackRuleAction` | portal session |
| `(operator)/admin/shipping/actions.ts` | `setCourierPolicyAction` | portal session |
| `(operator)/admin/shipping/actions.ts` | `recoverAccountAction` | portal session |
| `(operator)/admin/staff/access-reviews/actions.ts` | `reviewGrantAction` | portal session |
| `(operator)/admin/staff/access-reviews/actions.ts` | `reviewBreakGlassAction` | portal session |
| `(operator)/admin/staff/actions.ts` | `grantAction` | portal session |
| `(operator)/admin/staff/actions.ts` | `requestSensitiveGrantAction` | portal session |
| `(operator)/admin/staff/actions.ts` | `revokeAction` | portal session |
| `(operator)/admin/staff/actions.ts` | `deactivateAction` | portal session |
| `(operator)/admin/staff/actions.ts` | `reactivateAction` | portal session |
| `(operator)/admin/staff/actions.ts` | `revokeSessionsAction` | portal session |
| `(operator)/admin/staff/actions.ts` | `requestMfaResetAction` | portal session |
| `(operator)/admin/staff/actions.ts` | `executeMfaResetAction` | portal session |
| `(operator)/admin/staff/break-glass/actions.ts` | `requestBreakGlassAction` | portal session |
| `(operator)/admin/staff/break-glass/actions.ts` | `activateBreakGlassAction` | portal session |
| `(operator)/admin/staff/break-glass/actions.ts` | `revokeBreakGlassAction` | portal session |
| `(operator)/admin/stores/[id]/verification/actions.ts` | `submitVerificationAction` | portal session |
| `(operator)/admin/stores/[id]/verification/actions.ts` | `reviewVerificationAction` | portal session |
| `(operator)/admin/stores/[id]/verification/actions.ts` | `revealVerificationAction` | portal session |
| `(operator)/admin/stores/actions.ts` | `createStoreAction` | portal session |
| `(operator)/admin/stores/actions.ts` | `setStoreStatusDetailAction` | portal session |
| `(operator)/admin/stores/actions.ts` | `setStoreStatusAction` | portal session |
| `(public-services)/o/[token]/actions.ts` | `submitRefundDestinationAction` | independent capability |
| `(seller)/seller/actions.ts` | `switchStore` | portal session |
| `(seller)/seller/actions.ts` | `createProductAction` | portal session |
| `(seller)/seller/actions.ts` | `updateProductAction` | portal session |
| `(seller)/seller/actions.ts` | `addVariantAction` | portal session |
| `(seller)/seller/actions.ts` | `updateVariantAction` | portal session |
| `(seller)/seller/actions.ts` | `changeMemberAction` | portal session |
| `(seller)/seller/actions.ts` | `inviteMemberAction` | portal session |
| `(seller)/seller/actions.ts` | `revokeInvitationAction` | portal session |
| `(seller)/seller/billing/actions.ts` | `payAction` | portal session |
| `(seller)/seller/channels/actions.ts` | `createChannelAction` | portal session |
| `(seller)/seller/channels/actions.ts` | `revokeChannelAction` | portal session |
| `(seller)/seller/collections/actions.ts` | `createCollectionAction` | portal session |
| `(seller)/seller/collections/actions.ts` | `updateCollectionAction` | portal session |
| `(seller)/seller/customers/carts/actions.ts` | `openWhatsApp` | portal session |
| `(seller)/seller/finance/actions.ts` | `setDestinationAction` | portal session |
| `(seller)/seller/finance/actions.ts` | `requestPayoutAction` | portal session |
| `(seller)/seller/inventory/actions.ts` | `adjustStockAction` | portal session |
| `(seller)/seller/landing-pages/actions.ts` | `createLandingPageAction` | portal session |
| `(seller)/seller/landing-pages/actions.ts` | `updateSettingsAction` | portal session |
| `(seller)/seller/landing-pages/actions.ts` | `addBlockAction` | portal session |
| `(seller)/seller/landing-pages/actions.ts` | `moveBlockAction` | portal session |
| `(seller)/seller/landing-pages/actions.ts` | `removeBlockAction` | portal session |
| `(seller)/seller/landing-pages/actions.ts` | `saveBlockAction` | portal session |
| `(seller)/seller/landing-pages/actions.ts` | `publishAction` | portal session |
| `(seller)/seller/landing-pages/actions.ts` | `unpublishAction` | portal session |
| `(seller)/seller/marketing/actions.ts` | `createFeedTokenAction` | portal session |
| `(seller)/seller/marketing/actions.ts` | `revokeFeedTokenAction` | portal session |
| `(seller)/seller/marketing/actions.ts` | `saveDestinationAction` | portal session |
| `(seller)/seller/marketing/actions.ts` | `clearTokenAction` | portal session |
| `(seller)/seller/orders/[id]/actions.ts` | `bookShipmentAction` | portal session |
| `(seller)/seller/orders/[id]/actions.ts` | `refreshTrackingAction` | portal session |
| `(seller)/seller/orders/actions.ts` | `orderAction` | portal session |
| `(seller)/seller/pages/actions.ts` | `createPageAction` | portal session |
| `(seller)/seller/pages/actions.ts` | `updatePageAction` | portal session |
| `(seller)/seller/privacy/actions.ts` | `redactAction` | portal session |
| `(seller)/seller/privacy/actions.ts` | `redactSessionsAction` | portal session |
| `(seller)/seller/products/media-actions.ts` | `uploadMediaAction` | portal session |
| `(seller)/seller/products/media-actions.ts` | `updateMediaAltAction` | portal session |
| `(seller)/seller/products/media-actions.ts` | `moveMediaUpAction` | portal session |
| `(seller)/seller/products/media-actions.ts` | `removeMediaAction` | portal session |
| `(seller)/seller/promotions/actions.ts` | `savePromotionAction` | portal session |
| `(seller)/seller/settings/actions.ts` | `updateSettingsAction` | portal session |
| `(seller)/seller/shipping/actions.ts` | `setPickupAreaAction` | portal session |
| `(seller)/seller/shipping/actions.ts` | `setPickupAddressAction` | portal session |
| `(storefront)/s/[store]/(shop)/actions.ts` | `addToCart` | ambient cart capability |
| `(storefront)/s/[store]/(shop)/actions.ts` | `updateCart` | ambient cart capability |
| `(storefront)/s/[store]/lp/actions.ts` | `orderFromLanding` | ambient cart capability |
