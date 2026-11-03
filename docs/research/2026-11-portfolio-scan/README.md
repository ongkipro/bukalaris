# Portfolio scan for Bukalaris — 2026-11-01

Status: Research (reference, not a specification). Requirements, decisions and tasks stay in their owners
(`02-PRD.md`, `DECISIONS.md`, `TASKS.md`, the numbered documents); this folder records where a lesson came from
and how it was checked. Base: working tree on top of `2ddf5d2`, read-only, nothing executed against a database.

## Why and what was scanned

The owner asked to scan the related projects, TokoΦ first, for lessons that make bukalaris.com better. Sources
(Markdown first; code only to confirm a claim):

| Source | Location | Nature | Report |
|---|---|---|---|
| TokoΦ core docs | `~/Projects/tokophi-consolidate` (newest branch, contains `origin/main` `3403e044`): `AGENTS.md`, root records, `specs/docs/*.md` | Live product since 2026-07; incidents and audits | [sources/tokophi-core.md](sources/tokophi-core.md) |
| TokoΦ tasks and decisions | same repo: `specs/docs/tasks/*`, `specs/decisions/*`, `specs/*.md` | Task reports, ADRs | [sources/tokophi-tasks.md](sources/tokophi-tasks.md) |
| Etalashop snapshot | `~/Documents/work/prd/etalashop` (2026-10-11 snapshot) | `BUILD-LOG`, `CHANGELOG`, `RELEASE` incidents | [sources/etalashop.md](sources/etalashop.md) |
| Sibling packs | `~/Documents/work/prd/{99ribu,geraiexpress}`, `notes/geraiexpress-*`, `notes/99ribu-*` | Specs plus a legacy-code comparison | [sources/sibling-prds.md](sources/sibling-prds.md) |
| Other packs | `~/Documents/work/prd/{CMSPRO,punyasitus,tokoku,tokophi-landing-v2}`, related research and notes | Specs and research | [sources/other-prds.md](sources/other-prds.md) |
| Owner memory | `~/.config/ai/project-memory/{tokophi*,mengantar-*,autolaris-*,…}` | Advisory, may be stale | [sources/memory.md](sources/memory.md) |

## Method

1. Six read-only lanes (`ai-ask claude`, plan mode) extracted findings per source and grepped Bukalaris for
   coverage. Codex lanes failed (sandbox `bwrap` cannot create namespaces on this host) and were rerun on Claude.
2. The 88 P1 findings were verified against Bukalaris **code first, then docs** by four read-only Pi agents
   (`9router-fantastico/cc/claude-sonnet-5-5`, tools `read,bash`): [verification/](verification/).
3. The orchestrator re-checked every CONFLICT and every claim used below against the files; three agent
   conclusions were corrected (see "Corrections").

Labels: **Covered** = enforced in code or tests; **Doc-only** = stated, not enforced; **Gap** = neither;
**N/A** = architecture differs; **Conflict** = docs disagree with docs or code. Source facts are never
Bukalaris facts; vendor, price and law items are `Current-source required`.

## Result in one view

Bukalaris already enforces most of the hard lessons TokoΦ paid for. Verified as covered (do not re-open):
store root under RLS by `id` and every tenant table carrying `store_id` (every schema table must be in the
isolation registry, asserted both ways by `rls.test.ts`); no fallback to an owner URL (`client.ts`); balance queries never join `order`
(`t37-ledger.test.ts`); no bill on a terminal order and late payment quarantined (`payments/attempts.ts`,
`t49-payments.test.ts`); only `rc 00` + `PAID` + exact total settles (`classifyAdvice`); tax base is net of
discount (`ledger/finance.ts`); no oversell (`variant_stock_chk`, ordered lock, 12-way race test); COD is derived
from the order, not a parameter (`fulfillment.ts`); `completed` is written only by the courier status or a
four-eyes manual completion (`orders.ts`), so seller clicks never start the release clock; password reset revokes
sessions (`apps/web/src/lib/auth.ts`); SVG uploads are refused by byte sniffing (`content.test.ts`); test
databases must end in `_test` (`global-setup.ts`); impersonation is deliberately absent (ADR-0011).

## Conflicts fixed in the documents with this scan

| # | Conflict | Fix |
|---|---|---|
| C1 | `14` probe baseline said `/api/ready` proves "DB + roles ready"; the route runs only `select 1` (`apps/web/src/app/api/ready/route.ts`). | `14` now states what the route checks; the role proof is SEC-25. |
| C2 | `14` named `scripts/bukalaris-probe.sh`, which does not exist. | Marked as planned (T-79). |
| C3 | `02-PRD` Q-10 still listed late payment as open; it is implemented (BILL-5, T-49). | Q-10 narrowed to what is still open. |
| C4 | `STATUS.md`, `docs/README.md` and ADR-0005 still described M3 chain B and the T-59 expand step as not built. | Updated to the verified state. |

Known and already tracked (not new): unknown booking outcome is a retryable `failed` in code
(`fulfillment.ts` `RETRYABLE`) while ADR-0006 says non-retryable — open defect CRMON-04 (`TASKS.md`, gap report).

## Verified gaps — P1 (adopted into owners and the task queue)

| ID | Lesson (source) | Bukalaris evidence | Owner change | Task |
|---|---|---|---|---|
| G1 | A "restricted" pool silently ran as superuser for months; prove the role at boot (TokoΦ `AGENTS.md:332`) | Roles exist (`05-roles.sql`), checked only offline (`scripts/_registry.sh`); no runtime proof | `12` SEC-25 | T-76 |
| G2 | Drizzle applies the pending batch in one transaction; a stamp below the newest is skipped while printing success; generated SQL can re-add columns (TokoΦ `AGENTS.md:76,83`) | No journal check in `scripts/`; `15` silent | `15` DEL-2 | T-77 |
| G3 | Provider fixtures that look captured but were hand-written (GeraiExpress lane-INV) | No captured/synthetic marker rule | `15` verification plan | T-77 |
| G4 | Buyer pays from a QRIS shown as raw text (CMSPRO/TokoΦ notes) | `checkout/confirmation/page.tsx` and `seller/billing/_payment.tsx` render the payload in a `<textarea>` | `17` UX-12 contract | T-78 |
| G5 | 70 h outage found by a merchant; every probe lived on the box; backups "alive but writing nothing"; retention counted files, not age (TokoΦ `SLA-DRP.md`, Etalashop `OBSERVABILITY.md:47,54`) | Probe script absent; no dump-age health; no hosting-balance alert; Coolify's own DB not in the backup list | `14` DR-1 baseline | T-79 |
| G6 | "Merged" is not "deployed"; one green poll during a rolling swap is not proof; Coolify rejects `${X:+…}` even in comments; production mail never sent (Etalashop `RELEASE.md:89`, `BUILD-LOG.md:129`; GeraiExpress) | Not in `RUNBOOK` pre-production checklist | `RUNBOOK` | T-79 |
| G7 | Courier go-live with no couriers registered broke every quote; COD fee 0 vs 4994 from a parameter name (Etalashop `BUILD-LOG.md:4176`; GeraiExpress lane-ARCH) | No production quote probe or multi-amount COD estimate in the checklist | `RUNBOOK` | T-79 |
| G8 | An UPDATE that matched 0 rows reported success; bulk runs dropped rows past 50 (Etalashop `BUILD-LOG.md:902,1360`) | Code mostly uses `.returning()`; no stated contract | `17` mutation rule | — (rule only) |
| G9 | Gateway call with no timeout after the order commit (TokoΦ `AUDIT_PAYMENT_CHECKOUT.md`) | No `AbortSignal.timeout` in `payments/` (the real adapter is not built yet) | `11` BILL-2 | T-48/T-49 constraint |
| G10 | Payment anomalies (second paid, paid on void, amount mismatch) need an operator queue (CMSPRO `11-BILLING`) | Events recorded (`billing/attempts.ts`), no Owner console queue | `11` BILL-2 | Candidate (owner) |

## P2/P3 kept for later (no owner change yet)

Body reader capped by streamed bytes rather than `content-length` (chunked bodies bypass it); Storefront API
create-cart accepts 50 items while the line cap is 30 (`cart_full` still enforced); concurrency test for two
invoices of one store; a "two lines of the same variant" checkout test; metric dictionary with one shared
predicate per KPI (`17` SA-14) and demo stores excluded from platform KPIs; per-store COD conditions (opt-in,
total cap, province list) as a PR-19 candidate; custom-domain TXT ownership step (`08` DOM-3, T-15); route-level
capability floor test enumerating every Owner console page; unbundled consent under PP 33/2026
(`Current-source required`, legal review).

## Corrections to the agents' conclusions

- "No proof that password reset revokes sessions" — wrong: `revokeSessionsOnPasswordReset: true` (`apps/web/src/lib/auth.ts`).
- "Record who wrote `selesai`" (Gap) — wrong: `completed` only via `applyProviderTransition` with `source: provider | manual_approved` (`seller/commerce/orders.ts`).
- "Cart cap 30 vs 50 conflict" — not a conflict: `assertCartHasRoom` enforces `CART_MAX_LINES = 30`; only the API schema bound differs (P3).

## Not applicable

KiriminAja sandbox default (Bukalaris uses Mengantar and defaults to production with writes gated by
`MENGANTAR_WRITE_ENABLED`); impersonation exchange (rejected by ADR-0011); cron secret in URLs (no HTTP cron
routes; jobs run in the worker); payment-channel sync toggles (channels are read live, nothing persisted);
Astro storefront build issues (ADR-0008).

## Owner direction (2026-11-01)

Etalashop and TokoΦ (their documents and their built, live systems) are the reference used to complete the Bukalaris
documents. They are lessons, not templates: later decisions may choose a more modern design where it beats the inherited
pattern, and each such choice is recorded in `DECISIONS.md`. Development has not started from this scan.

## Full read of TokoΦ and Etalashop (started 2026-11-01)

Owner asked for a complete read before the decision list. Twelve parallel read-only lanes (Pi,
`9router-fantastico/cc/claude-sonnet-5-5`, tools `read,bash`) read every line of the TokoΦ Markdown corpus
(`~/Projects/tokophi-consolidate`: `BUILD-LOG.md` 4,696 lines, `CHANGELOG.md` 4,725, root records and `AGENTS.md`,
`specs/docs/*.md` 18,089, `specs/docs/tasks/*.md` 13,708, `specs/decisions/*.md` 2,829, audits/UAT 3,530, `apps/**/*.md`
2,017) and the Etalashop snapshot differences. Each lane reports a coverage table (lines read = lines total), only findings
not already in `sources/`, and a "Modern option" per finding. Results: [full-read/](full-read/).

Result (completed 2026-11-01):
- **Coverage:** every assigned file read to its last line (coverage table at the top of each `full-read/L*.md`);
  the only partial reads are screenshot-path lists in `apps/account/design/review*.md` (about 97 %).
- **Etalashop** is a strict, older subset of TokoΦ (snapshot of revision `caee811`): no Etalashop-only lesson (L12).
- **Volume:** 554 new findings across 12 lanes, 139 of them P1. A synthesis agent deduplicated the P1s into 84 unique
  lessons and checked each against Bukalaris code and docs ([full-read/SYNTHESIS-P1.md](full-read/SYNTHESIS-P1.md)):
  about 27 covered, 29 doc-only, 23 gaps, 1 conflict and 3 not applicable.
- **Confirmed new gaps worth noting:** the app role can update its own `store` row, including `status` (U65), and the
  product edit writes `stock` from the form, so a sale that lands while the seller is editing is overwritten (U64).
  The conflict is U4: `DEPLOY-COOLIFY.md` plans an origin firewall of "80/443 Cloudflare ranges only", which TokoΦ
  withdrew because it breaks ACME HTTP-01 and custom domains that are not on Cloudflare.
- **Decision candidates for the owner** (D1 to D10 in the synthesis, each with a recommendation): origin exposure and the
  firewall rule; stock reservation expiry and fee truth (Q-10); `store` column grants and the stock write path; the
  deploy gate while CI has never run; one "collected money" predicate for the seller dashboard; rate-limit fail-open or
  fail-closed per bucket; consumer-law items from PP 80/2019 for legal review; parcel dimensions for quote and
  booking; storefront gating for an unreviewed store; the HSTS ramp.
- **Not yet applied to the owner documents:** the P2/P3 findings (415) and the P1 gaps above wait for the decision list,
  as planned.

## Limits

The initial six-lane pass sampled the two large TokoΦ logs (`BUILD-LOG`, `CHANGELOG`); the later full-read pass supersedes that sampling limit for assigned files, with the screenshot-path-list exception noted above. Source citation accuracy was spot-checked, not exhaustively independently verified. No test or database was run for this scan; every "Covered" cites code or a test name, not an execution.

## Review disposition — 2026-11-04

D-24 in `docs/DECISIONS.md` now owns the candidate dispositions; T-80 to T-94 in `docs/TASKS.md` own missing technical and policy-gated work. T-87 owns the complete remaining lesson/finding inventory, including P2/P3; no blanket acceptance is inferred. U64/U65 are assigned to T-80/T-81. The origin-firewall candidate is conditional on custom-domain/TLS architecture, not grounds to open the origin now; the blanket fail-open recommendation is not adopted (T-90). Recommendations in the dated synthesis remain research history, not current approved policy.
