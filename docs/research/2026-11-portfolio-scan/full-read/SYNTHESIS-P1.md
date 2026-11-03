# Full-read synthesis — P1

Scope and method:
- I deduplicated the 138 P1 rows in `p1.txt`. The brief says 147; the file holds 138 non-empty rows. The G1–G10 items already in `README.md` are not repeated.
- Status comes from `rg` over `docs/*.md`, `AGENTS.md`, `packages/db/{src,test,drizzle}`, `apps/web/src`, `scripts` and `docker-compose.yml`. Evidence cites file:line.
- Status labels:
  - **Covered**: code or tests enforce it.
  - **Doc-only**: stated in a document, not enforced.
  - **Gap**: `rg` found neither.
  - **Conflict**: Bukalaris docs contradict the lesson.
  - **N/A**: the architecture differs.
- Lane codes: L01 and L02 are BUILD-LOG 1/2 (L03 is BUILD-LOG 3). L04 and L05 are CHANGELOG 1/2. L06 is root docs. L07 is spec docs a. L08 and L09 are spec docs b1/b2. L10 and L11 are tasks a/b. L12 is decisions/audits/user docs.
- Where a "Gap" rests on a narrow `rg` rather than a full read, the Evidence column says "no hit".
- Several rows in L01, L02, L03, L05, L07, L08, L09, L10, L11 and L12 were cut off at ~700 characters by my display. For those, "Modern option" is only what I could read. Rows I lost the tail of are marked "(tail cut)".

## Unique lessons

| U# | Lesson | Status in Bukalaris | Evidence | Owner doc § | Decision needed? | Modern option | Sources |
|---|---|---|---|---|---|---|---|
| U1 | Coolify's env parser rejects `${VAR:+…}` even inside comments. Only `${VAR}`, `:-` and `:?` are safe. | Gap | No hit for `:+`, "compose lint" or "plain forms" in docs, scripts or compose. G6 already notes the lesson in `RUNBOOK`; no guard exists. | DEPLOY-COOLIFY (compose rules), 15 | No | Compose-lint test that scans raw text, comments included | L01 BUILD-LOG.md:332-339 |
| U2 | The migrate step must not gate the app (`depends_on: service_completed_successfully`). Seed or demo-data must never sit in that gate. Measured downtime fell from 81–115 s to ~7–8 s. | Doc-only | `DEPLOY-COOLIFY.md:285-290` (consistent names, `start_interval`, migrate as a separate step, ~7–8 s). `docker-compose.yml` has no `depends_on` or `service_completed` hit. Seed is not mentioned in the gate rules. | DEPLOY-COOLIFY §zero-downtime, RUNBOOK | No | Expand/contract (15 DEL-2) removes the gate. Two replicas with a rolling swap for true zero downtime. | L01 :362-399; L02 :~2025-2125 |
| U3 | Offsite backup sidecar rules: unconfigured means unhealthy; `rclone copy` not `sync`; read-only mount; remote retention above local; restore from the remote copy. | Doc-only | `14-SLA:131-140` (G5, backup health by age) and `DEPLOY-COOLIFY.md:142,173` (R2 vars, 14 d local / 30 d offsite). The `copy`-not-`sync` and unconfigured-is-unhealthy rules have no hit. | 14 DR-1, DEPLOY-COOLIFY | No | pgBackRest or WAL-G with R2 object lock (WORM) for PITR | L01 :341-349; L06 specs/README, TASKS 8.4 |
| U4 | Origin exposure. The panel ports and the origin IP were reachable. Do NOT re-propose "Cloudflare ranges only on 80/443": it breaks ACME HTTP-01 and non-Cloudflare custom domains (withdrawn in TokoΦ TASKS 8.8). | **Conflict** | `DEPLOY-COOLIFY.md:32` says "80/443 (Cloudflare ranges only)" and `:329` assumes the same. Custom domains are a Bukalaris feature (`08`), so the two conflict. | DEPLOY-COOLIFY §firewall, 12 | **Yes** (see D1) | Cloudflare Tunnel or Authenticated Origin Pulls; panel behind Tailscale or an SSH tunnel | L01 :351-355; L06 TASKS 8.8 |
| U5 | AutoLaris `expired` is read as WIB while containers run UTC. Compute it by +7 h arithmetic and `getUTC*`, and pin parity with Asia/Jakarta. | Covered | `ADR-0006:116`; `t49-payments.test.ts:119,125` (`expiryStampWib`, midnight crossing). | — | — | Temporal with an explicit zone | L01 :355-357 |
| U6 | One invoice creator for cron, merchant and manual paths. Per-store try/catch counted as errors. Invoice numbers need entropy. A no-op cron must not report green. | Covered, with one Gap | Entropy: `billing/invoices.ts:15-17`. Per-store isolation: `billing/cycle.ts:48-51`. The lone remaining test is `invoicesCreated: 0` while a `past_due` store exists, with no alarm or test. The single-creator guard has no test; `t50-invoices.test.ts:65` inserts invoices directly (as a fixture). | 11 / 16 (alert) | No | Job-per-store queue; alert on `invoicesCreated: 0` with a `past_due` store | L01 :214-231; L06 TASKS 8.24; L11 finance audit :80-107 |
| U7 | Comp must not count as MRR or paid. Rp0 `kind=comp` invoice. Recency rule. Demo money excluded from platform KPIs. | Doc-only | Comp Rp0: `02-PRD.md:496`, `17-UX:518`. The recency rule and demo exclusion have no hit (`is_demo` absent from docs and `packages/db/src`). | 11 (KPI definitions), 17 SA-14 | No | A `subscription_revenue` view with one named predicate | L01 :246-262 |
| U8 | One named `COLLECTED` predicate for seller finance (an unpaid VA is not omzet). Two named definitions are fine if both are captioned. | Gap | `dashboard.ts:8-16` defines "counted = not cancelled", with no paid filter. That is the exact two-definition risk, and it is not captioned as such. | 17 SC-01, 11 | **Yes** (D5) | A single `collected_revenue` view | L01 :233-244 |
| U9 | COD fee floor (Rp2.500) and per-courier rate. The seller is credited at `selesai` while the courier remits later. Need a remittance fact (`cod_settled_at`) and an exposure rule. | Covered (design) / Doc-only (fee table) | COD sale is `pending` and released only by reconciliation: `11:214`, `ADR-0006:96`, `reconciliation.ts`, `/admin/money/cod-reconciliation`. COD bookings stay refused until Q-17: `fulfillment.ts:49`, `PRD:617`. Per-courier COD fee table: no hit (`courier_service_policy` carries `cod_allowed` only). | 11, ADR-0006 | Q-17 is already owner-open | Data-driven fee table per courier | L01 :233-242; L06 TASKS 8.29; L11 :142-156 |
| U10 | One money formula in ledger, view, report and analytics, with a parity test. Goods-only credit. | Doc-only | Ledger verify exists (`ledger/verify.ts:107`). Parity tests exist for affiliate and period (`t50-period.test.ts:6`, `affiliate/commission.ts:10`). No report-view-versus-ledger parity requirement for both tax modes. | 11, 15 verification plan | No | One SQL function used by both | L01 :540-545,573-577 |
| U11 | A cron secret must never be in a URL. Header-only, `timingSafeEqual`, fail closed. | N/A | No HTTP cron routes; jobs run in the worker (README "Not applicable", `worker.ts`). | — | — | Run jobs in the worker | L01 :1253-1262; L06 AGENTS ~1290 |
| U12 | Rate-limit policy per bucket. Login and signup buckets fail closed; payment callbacks and shopper buckets fail open. A counter failure must never lock out a merchant. | Gap | `rate-limit.ts` is the only counter implementation, with no failure-mode table. `16:17-21` lists buckets. Better Auth limiter is in-memory per process (`ADR-0004:37`, `16:16`). | 16, 12 | **Yes** (D6) | Shared Postgres counter; table of fail-open/closed per bucket | L01 :285-306 |
| U13 | Invitation: stamp `accepted_at` on the invitee's first sign-in, never by the inviter. Concurrent invite uses `on conflict do nothing` and a result union. | Doc-only | `accounts.ts:198` stamps `acceptedAt` when the invitee accepts (correct). The concurrent-invite race and the result union are not in code or docs. | 07, 17 team screen | No | Signed invitation token | L01 :1000-1083 |
| U14 | Read the law text, not summaries. PP 80/2019 Pasal 27, 66, 69 (≥2 working days), 71. A strict parser for numbers. | Doc-only | `13` and `17` carry legal rows. A hit for `PP 80\|Pasal 69\|UU 8` appears only in `17:871` (takedown). The strict-parser lesson (`7,5`→75) has no hit. | 13 | **Yes** (D7, legal review) | — (Current-source required) | L01 :35; L11 adviser brief :1-92 |
| U15 | No niche defaults in platform defaults (category, theme, copy, SEO). A repair needs a before-image. Seeder is insert-if-absent, so a changed default needs an explicit data fix. Platform defaults must be written, not copied from a demo store. | Gap | No hit for "Fashion", `insert-if-absent`, "neutral fallback", "default theme" (only `README.md:53`). | 10, 17, DECISIONS | No | Default as versioned code template, resolved at render | L01 :183-193,649-684; L04 :71-106; L05 :3686-3850 |
| U16 | Browser proof for admin and editor UI means a production build, `next start` and the exact route. `next dev` hides client loops (React #185, nine days). A client error beacon is also needed. | Doc-only | Playwright runs `pnpm start:standalone` (`apps/web/playwright.config.ts:64`), a production build. The rule is not stated in `RUNBOOK`, `17` or `TASKS`; no "exact route" hit. No `window.onerror` beacon. | 17 testing DoD, RUNBOOK | No | Playwright smoke for every editor route against `next start` | L01 :640-648; L04 :38-60; L11 :51-60 |
| U17 | A pipe or `tail` hides exit codes. Read the exit code, then the log. Prove the new server marker is served. | Doc-only | `scripts/_lib.sh:4` sets `pipefail`. The wider rule is not in `AGENTS.md`. `RUNBOOK:131` has one exit-code line. | AGENTS | No | `set -o pipefail` in all scripts | L01 :407-412,745-752 |
| U18 | Hosting billing lapse (70 h) is a named single point of failure. Probe off-box; the box cannot alarm itself. | Doc-only (G5 adopted) | `14:131-140`; `RUNBOOK:362`. `scripts/bukalaris-probe.sh` is still absent (T-79). | 14 | No | External pinger; prepaid hosting | L02 :3098-3118; L06 OBS "The gap" |
| U19 | Provider IP allow-list lapse is its own failure class. The status light must come from a real upstream call, never an `enabled` flag. Connectivity-test must be non-billing. | Doc-only | Allow-list mentions are only `ADR-0007` and `DEPLOY:32`. No probe state stored; `console.ts` and `02-PRD:615` carry no vendor-probe row. | 14, 17 SA-07/36 | No | Static egress IP; probe state stored | L02 :3118-3132; L04 :14-17; L11 OPEN.md:10-31 |
| U20 | Deploy only after green CI. Coolify deploys on merge and ignores Actions; twelve commits shipped untested. Reproduce CI locally if Actions is down. | Gap | `ci.yml:1-3` says "file only, never run". `RUNBOOK:304` is a checklist line, not a deploy gate. | DEPLOY-COOLIFY, 15 | **Yes** (D4) | Deploy on a webhook from a green workflow; a `test:release` script | L02 :1990-2020 |
| U21 | A merge is not a deploy: a docs-only merge is skipped by Coolify watch paths. Currency checks must compare with the newest non-excluded commit. | Gap | No hit for `watch path` in the docs searched. (G6 covers "merged is not deployed" in prose only.) | DEPLOY-COOLIFY | No | — | L10 open-work DEL-3 |
| U22 | A declared index may exist in no database (ghost index). A census must classify every index as `drizzle` or `sql-only: reason`. | Gap | No hit for index census, parity or ghost (`rg` found none). G2 covers the journal only. | 15 DEL-2, 05 | No | `drizzle-kit check` plus introspection diff in CI | L02 :2035-2055; L05 :2897,4067 |
| U23 | Concurrency tests: `Promise.all` passing proves nothing. Prove the lock with two connections and a barrier. Claim row is the first statement (PO double-receipt). | Gap | No hit for "barrier", "two real connections" in `15`. A 12-way race test exists for stock (README) but the method is not written down. | 15 verification plan | No | Barrier or advisory-lock tests | L02 :1601-1640; L05 (concurrency) |
| U24 | Owner pages need a role floor and the gate must be the first await, before any data read. A directory-derived sweep fails on an unclassified page. | Covered | `t62-routes.test.ts:8-10` (directory sweep), `17:761`, `07:403`. | — | — | DAL authorization | L02 :2243-2310 |
| U25 | Drizzle migrator traps: skip by `max(created_at)`, one batch transaction, stale snapshots re-add columns, an edited migration never re-runs, enum value used in the same transaction, journal timestamps monotonic, fresh DB from migration 0. | Covered (G2/T-77) / Gap for the rest | `15:44-` covers the journal, stamp, idempotent hand-written SQL, "generated SQL read before commit". Not stated: (b) enum value used in the same transaction, (d) edit-after-apply never re-runs, "CI migrates from zero and `generate` must report no changes". | 15 DEL-2 | No | CI from a fresh DB; enum additions in their own migration | L03 :3770-3790,4540; L05 :2897; L06 AGENTS ~95-130 |
| U26 | One ephemeral dev DB per branch. | Doc-only | `RUNBOOK:33` (per-worktree `.env`); no per-branch scratch DB rule. | AGENTS, RUNBOOK | No | `createdb bukalaris_<branch>` | L06 AGENTS ~95-130 |
| U27 | Parser vs captured body: tracking response was read as `r.data` and every pull silently did nothing. Parse against a captured real body with a schema; return a typed result. | Doc-only | `15:88` (fixture captured vs synthetic, G3). The adapter has typed errors (`partner.ts:33`). No schema-parse rule for the tracking body. | 09 / 15 | No | zod/valibot at the adapter edge; an "evidence line" metric per tick | L03 :4585-4590 |
| U28 | Provider outcome taxonomy: throttling can arrive as HTTP 200 with `{status:false}`. Separate data, empty and our-failure. `[]` is never the error value. | Gap | No hit (`ok \| empty \| vendor_error`). `partner.ts:84,111` handles 429 only. | 09 | No | Discriminated union per adapter | L06 TASKS 8.17 |
| U29 | Sandbox mock AWB (`MOCK-<ref>`) must not reach the label. Waybill guard. | Gap | No hit for `MOCK-` or waybill guard in code. | 09, 17 | No | Per-courier waybill format | L03 :4585-4590,4631-4640 |
| U30 | Provider answer caches must be keyed by environment and account identity, never cache empty or failed answers. | Gap | No cache-key rule in `04`/`09` (`06:10,47` covers tenant cache keys only). No quote cache hit in Mengantar client. | 09, 16 | No | Key by provider-account id | L03 :4440-4455 |
| U31 | Env invisibility: a sandbox booking looks like production. Show the active env and the last real vendor call outcome. Block the env switch unless the target account has quoted. Fail closed if env is unset. | Doc-only | G7 and `RUNBOOK` (one quote probe). README states Bukalaris defaults to production with writes gated by `MENGANTAR_WRITE_ENABLED`. No operator screen row for env + last real call. | 17 SA-07/36, RUNBOOK | No | Env in DB; probe state as a first-class platform fact | L03 :4440-4480; L06 AGENTS ~600; L06 TASKS 8.3,8.33 |
| U32 | Fee truth. The fee shown to the buyer must equal the fee billed. Our figures are written at insert. The provider echo is evidence only. Decide which endpoint nets the fee. | Doc-only | `11:121` says QRIS = 0.7 % of goods omset. `ADR-0006:118` and `11:~122` ("verification by pull") treat the callback as trigger-only. No test captures the amount handed to the PSP. | 11 BILL-2 | **Yes** (D2) | Compute once, persist as immutable snapshot, bill exactly that | L03 :4128-4140; L06 TASKS 8.25; L11 :108-127 |
| U33 | Refund row for a paid prepaid order cancelled or returned; one open refund per payment; created inside the cancel transaction; never netted against seller float. Refund row must exist before the first real payment. | Covered (row) / Gap (go-live gate) | `schema-ledger.ts:379` (`refund_one_open_per_payment`), `05:265`, `ADR-0006:110`. The release-gate test and "refund exists before the first real payment" are not stated. | RUNBOOK go-live, 11 | No | Gateway refund API with an idempotency key | L03 :4249-4277; L11 :218-227 |
| U34 | Migration/seed census: an "irreplaceable tables" census for a destructive reseed. "The seed is not a migration". `SEED_FORCE` needs a second switch. A seed that sets business behaviour must not be a migration. | Gap | No hit for `SEED_FORCE` or `IRREPLACEABLE`. `seed.ts:16` and `seed-demo.ts:212` refuse `NODE_ENV=production` (partial). | 15, AGENTS | No | `irreplaceable` flag in the isolation registry | L03 :4640-4660; L10 :2026-08-05 traps |
| U35 | Analytics must have a writer. A table fed only by the seed freezes. Compute at read time, with one shared revenue definition. | Doc-only | `dashboard.ts:8-16` reads orders directly (OK). No rule stated in `05`. | 05, 17 | No | Materialized rollup refreshed by an observable job at scale | L04 :814-910 |
| U36 | Time bucket: one `dayKey()`; per-store timezone. | Doc-only | Asia/Jakarta is the fixed convention (`dashboard.ts:8,30`, `period.ts:10`). No `store.timezone`, and `affiliate/risk.ts:33` buckets by UTC. | 05, 04 §time | No (single market) | IANA tz per store | L04 :858-866 |
| U37 | Quote and booking must use the same parcel (volumetric ÷6); dimensions in the rate cache key. Required dimensions on shippable products. | Doc-only | `ADR-0006:124` (booking live-priced from the same derivation and weight). `05:522` weight rule only. No L×W×H or volumetric requirement. | 09, 05 | **Yes** (D8) | One `parcelFor(cart)`; contract test | L04 :912-973,336-377 |
| U38 | Tracking code map must be total: unmapped status never moves money, never force-collapses to `shipped`; poller is isolated per item. | Covered (status) / Doc-only (isolation) | `fulfillment.ts:56-73,442-464` (unknown status never echoed, never drives `completed`). `ADR-0006` item 7. Per-item sweep isolation: no hit. | 17 fulfillment, 04 | No | Webhook first; exhaustive code table test | L04 :621-755; L05 CHANGELOG:2515,2520; L08 BACKLOG:60-110 |
| U39 | `cancelShipment` with no AWB must refuse before any network call. Void/rebook edge in the state machine. | Doc-only | `orders.ts:32` `TRANSITIONS` exists; no "void shipment" or `dikirim → diproses` hit. | 04 state machine | No | Transition table as data plus every-state-has-an-exit test | L04 :717-755; L10 audit :Tests; L08 WORKLOG:386-392 |
| U40 | Tax base is net of discount; one calculator; the UI never infers labels from sums. | Covered | `ledger/finance.ts:126-127` (net goods), README. | — | — | Persist `tax_mode` | L04 :1829-1842; L05 :2552 |
| U41 | Voucher usage limit enforced atomically in the order transaction. Status derived from dates. | Covered | `promotions/checkout.ts:94-95` (`UPDATE … WHERE used_count < usage_limit … RETURNING`, window by `clock_timestamp()`). | — | — | — | L04 :2208-2230 |
| U42 | Child tables need a store predicate; owner-connection paths need an explicit store predicate. | Covered | README ("every schema table in the isolation registry", `rls.test.ts`); ADR-0005:86. | — | — | Composite FK `(store_id, parent_id)` | L04 :1461-1475; L05 :2495; L06 AGENTS ~330; L08 BACKLOG:234-285 |
| U43 | Tenant-root table keyed by `id` (`stores`) is invisible to a `store_id`-driven verifier; a `limit(1)` leak. Guard fixtures must be deterministic. | Covered | README "store root under RLS by `id`"; registry is asserted both ways (`rls.test.ts`). | — | — | Explicit allowlist plus catalog check | L05 :3405-3445; L06 AGENTS ~330; L08 BACKLOG:617-650 |
| U44 | Webhooks: late PAID after cancel; replayed EXPIRED must not un-pay; no identity → 400; ambiguous → refuse; unsigned callback is a hint that triggers our own pull. | Covered | `payments/attempts.ts:23,149`; `callback.ts:31,63` (signed ref, enqueue `PAYMENT_VERIFY`); `route.ts:39`; `ADR-0006:118,137`; `11` ("verification by pull"). | — | — | Provider-event inbox | L04 :1860-1880; L06; L08 BACKLOG:112-124 |
| U45 | One live payment attempt per order, enforced by an index. Refuse creation on a terminal order. | Covered | `schema-payments.ts:20` (`payment_attempt_order_uq`); `attempts.ts:29` (terminal order never gets one). | — | — | — | L04 :1692-1700; L07 PAY-04,D-04 |
| U46 | Callback auth: a prod-only failure invisible in dev (dev accepts no secret). A contract test builds the callback URL and POSTs it. | Covered (fail closed) / Gap (contract test) | `signature.ts:13` and `callback.ts:28` fail closed. No test builds the real URL and POSTs it; not verified beyond a no-hit search. | 15 | No | Synthetic payment E2E | L04 :1806-1818; L08 WORKLOG:288-300 |
| U47 | Operator rank is re-read from the DB on every request; dead cookie redirect loop; self-service password change revokes sessions. | Covered | `07:391,594`; README (`revokeSessionsOnPasswordReset`). | — | — | Server-side sessions | L04 :379-412; L06 AGENTS ~455 |
| U48 | No fixed credential on any screen; seed prints random passwords; scan test; provisioned and invited accounts get random one-time secrets. | Doc-only | No login page prints a credential in `apps/web/src`. The seed uses fixed `DEV_PASSWORD` (`seed.ts:17`) and `DEMO_PASSWORD` (`demo/data.ts:10`, `DEMO.md:42`), refused in production (`seed.ts:16`, `seed-demo.ts:212`). No scan test. | 12, DEMO.md | No | Invite-link onboarding | L04 :987-1011,1229-1255; L08 WORKLOG:170-282 |
| U49 | A skipped money test is not green. DB tests fail hard; `verify` runs in CI; a red verifier blocks merge. | Covered (DB env) / Gap (rule) | `global-setup.ts:16-18` throws if `TEST_DATABASE_URL` is unset or not `_test`. No rule that skips on money suites fail CI; `ci.yml` never run. | 15 verification plan | No | `REQUIRE_DB=1` | L04 :414-460,1354-1377; L05 :3407-3412; L07 AUDIT-SUMMARY W2; L08 WORKLOG:326-338 |
| U50 | Seed-created platform default store themes: see U15. (merged) | — | — | — | — | — | — |
| U51 | Checkout UI: "Ongkir Rp 0" before an address; "Tercepat" ranks on the first ETD digit; checkout is a tunnel; payment hidden until the district is picked; COD thank-you shows the exact cash amount. | Gap | No hit for `Dihitung`, `ETD`, "tunnel" in `17`. `17:105` describes the flow only. | 17 UX-12-style checkout contract | No | — | L04 :1749-1775; L05 :3330,2890,3860 |
| U52 | Checkout forms: `reportValidity()` focus trap on an optional email; `novalidate`; `setCustomValidity`; hidden `required` radio. Normalise generously, reject narrowly. Test with click-and-type. | Gap | No hit in docs for `reportValidity\|novalidate\|setCustomValidity`. | 17 checkout contract | No | — | L05 :2793-2850 |
| U53 | Cart references a variant id, never a title string; a mismatch rejects the order. | Covered | `AGENTS.md:80`; `checkout.ts:77,104` (distinct variants, `variantId`); `05:109`. | — | — | — | L05 :3716 |
| U54 | Server-side shipping and item price; client number ignored; a service missing from the fresh quote rejects. | Covered | `AGENTS.md:80`; `checkout.test.ts:26-27` ("not the client"). | — | Quote id with TTL optional | — | L05 :4120 |
| U55 | Ledger reversal of a cancelled or returned paid order carries the same status as the sale. | Covered | `ADR-0006:84,90`; README (balance never joins `order`). | — | — | — | L05 :2548 |
| U56 | COD is ready to ship by definition; payment row stays `menunggu` until `selesai`. | Doc-only | `orders.ts:17-18,33` COD lifecycle `awaiting_confirmation → placed`. The explicit queue predicate "COD counts as ready-to-ship regardless of payment status" has no hit. | 17 SC-12/13 | No | `fulfillable_at` | L05 :2549,4266 |
| U57 | Record courier and service at checkout before launching a COD policy (scoreboard). | Covered | `checkout.ts:329` stores `courierCode`; `05:324` `courier_service_policy` with `return_free_evidence_ref` marked UNVERIFIED. | — | — | `quote_snapshot` JSON | L05 :4081,4087; L06 TASKS 5.19 |
| U58 | Fake or stub controls; honest empty state; save-round-trip test; an under-selecting read layer deletes merchant text. | Gap | No hit for "Belum terhubung", "round-trip" (docs), or "under-select". Only `17:816` ("Honest KPIs"). | 17, 15 | No | Form DTOs from one schema; round-trip test per editor | L05 :2639,2684,3980,4300 |
| U59 | Tenant-neutral fallbacks and a second-tenant render test. | Gap | See U15; no rendering test with an empty catalogue. | 10, 17 | No | Two seeded tenants | L05 :3135,3686-3850 |
| U60 | Bulk book/print: sequential; "marked printed" never "success"; book the service the buyer paid for; bulk stock editor needs optimistic concurrency. | Doc-only | `17:316` ("never silently drops rows past a limit", G8). The rest has no hit. | 17 SC-15/16 | No | — | L05 :3387,2516,2560 |
| U61 | "Not configured" vs "deliberately none": zero rows read as never configured. | Gap | No hit for `inherit\|sentinel`. `shipping.ts:190` refuses a key with neither (fail closed). | 05, 17 shipping settings | No | `mode` enum | L05 :3814 |
| U62 | No default tenant: slug-less requests and unknown hosts fail closed. | Covered | `host.test.ts:110`; `host.ts:178`; `08:239`. | — | — | — | L05 :2521,4310; L06 |
| U63 | JWT audience and pinned algorithms; lazy throw for a missing secret during `next build`. | N/A | No impersonation (ADR-0011). Better Auth sessions; no custom JWT. | — | — | — | L05 :2519,4026 |
| U64 | Stock edit overwrites a concurrent order decrement. Product save must not write `stock`; use `adjust(variant, delta, reason)` or a compare-and-set. | **Gap (confirmed)** | `catalog.ts:21,28` has `stock` in `variantInput`; `catalog.ts:208-217` locks the row then `.set(input)`. `17:20,330` only name "stock conflict". | 17 SC-02/03/17, 05 | **Yes** (D3) | Delta adjust or optimistic check | L12 `inventori.mdx`; L05 :2560 |
| U65 | Tenant role can UPDATE its own `store` row (status, suspended). `store_suspension_sync` syncs only `suspended_at`. | **Gap (confirmed)** | `0007_rls.sql:121` `GRANT SELECT, UPDATE ON "store" TO bukalaris_app`; trigger at `0013_chain_a_wave3.sql:2234-2244`. No column-level grant or guard hit. | 12, ADR-0005 grants, 06 | **Yes** (D3) | Column-level grants plus a guard trigger plus a test | L12 audit REPORT.md:233-251 |
| U66 | Abandoned prepaid orders hold stock forever. Reservation needs `expires_at`; a sweep. | **Gap** | `02-PRD.md:385` Q-10 still "Stock reservation expiry … open". No order-expiry job: `worker.ts` registers none for orders; `payments/jobs.ts:130` only polls Advice. | 05 stock flow, 11 BILL-5, Q-10 | **Yes** (D2) | Reservation row with `expires_at = bill expiry`, released in the same transaction | L07 PAY-04,D-04; L09 PANDUAN P17,P18 |
| U67 | Action availability derives from one server function (state × payment × role × subscription), used by UI and action. Expiry job scope covers every non-terminal pre-fulfilment state. | Doc-only | `17:96` ("allowed actions only"), `04:820` marks `applyOrderAction` as "(proposed)". `orders.ts:32` `TRANSITIONS`. | 17, 04 | No | — | L09 PANDUAN_SPEC:191,192,196 |
| U68 | Verification ladder: a flow is verified at its terminal evidence point (COD = parcel booked, delivered, cash collected). typecheck-green, checkout-dead. | Doc-only | `15:94` ("not a green build"); `15` verification plan names evidence by flow. The COD terminal evidence point and the `queueSave` incident are not named. | 15 | No | One COD plus one prepaid order smoke E2E per PR | L09 STATUS; L06 AGENTS ~870; L05 :3260 |
| U69 | Payment break-glass must reuse the callback's own code path. Stale-`menunggu` reconciliation screen. | Doc-only | `11:47` "Candidate (owner decision): anomaly queue" (G10); `failUnknownAttemptAsOperator` (`billing/console.ts:192`). The "no direct UPDATE" rule has no hit. | 11 BILL-2 | Part of G10 | Scheduled pull of pending payments | L08 BACKLOG:1659-1685; L04 |
| U70 | First real callback captured and its shape logged (names, types, lengths; never values) before the amount gate is trusted. Raw status log before any status moves money. | Doc-only | `ADR-0006:141` ("not yet observed by Bukalaris"); `15:88`. No "capture one real callback" go-live gate and no raw-capture soak. | RUNBOOK go-live, 09 | No | Append-only `provider_event_raw` table | L08 BACKLOG:60-110; L11 :192-216 |
| U71 | Disk full crash-looped Postgres (204 images, ~129 GB). Image retention cap, disk alerts, a DB-touching probe, a heartbeat for every maintenance cron. | Gap | `14` and `RUNBOOK` have no image-retention or disk-percent hit. Worker heartbeat exists (`16:221`, `DEPLOY:43`) but not disk. | 14, RUNBOOK | No | Volume alert at 70 % | L08 BACKLOG:1337-1370 |
| U72 | Stock can go negative: cart naming one variant twice; check and decrement must touch the same row set. | Covered | README ("no oversell", `variant_stock_chk`, 12-way race test, same-variant-twice tests). | — | — | — | L08 WORKLOG:301-304 |
| U73 | `selesai → batal` claws back collected cash. Explicit transition table. Payment after `retur` credited as withdrawable. | Covered | README (no bill on terminal order; `completed` only via courier or four-eyes); `orders.ts:32` `TRANSITIONS`; `ADR-0006:137`. | — | — | — | L06 AGENTS ~1030; L08 WORKLOG:386-392 |
| U74 | Subscription entitlement: payments move it; "mark paid" is bookkeeping. Suspension for abuse separate from non-payment. Goodwill actions are additive, never destroying a paid period. | Covered (split) / Gap (additive) | `t50-access.test.ts:159` (lift clears no debt), `02-PRD:496`, `store_suspension_sync`. No "comp never shortens or overwrites a paid period" hit. | 11 owner actions | No | `entitlement_grant` rows | L06 AGENTS ~640; L10 audit wave money |
| U75 | Self-serve signup review queue: the unapproved store's storefront must not be public. Gate on `suspended_at`, not `status`. Holding page (503, `noindex`). | Doc-only | `05:537` account status events; `store_suspension_sync` exists. No review-queue hit for storefront gating in `08` or `host.ts`. (tail cut) | 08, 12, 17 | **Yes** (D9) | — | L10 audit-waves-6-9 (§ tenant lifecycle) |
| U76 | Custom domains: a shared Traefik instance has priority collisions. Add an explicit `Host()` only after `store_domains.status='active'`. | Gap | `08` has apex CNAME and host fallback only. No `priority` or `Host()` hit. | 08, DEPLOY-COOLIFY | No | — | L10 (§ custom domains / proxy) |
| U77 | HSTS ramp: 24 h → 1 year; one-way door; per-zone preconditions. | Gap | `DEPLOY-COOLIFY.md:81` and `security-headers.ts:33` go straight to `max-age=31536000; includeSubDomains`. | DEPLOY-COOLIFY, 12 | **Yes** (D10) | Staged ramp | L10 SEC-2/T-2..T-4 |
| U78 | Platform sync must not overwrite operator intent: `provider_available` (synced) vs `operator_enabled`. | Covered | README: channels are read live, nothing persisted. | — | — | — | L06 TASKS 8.18,8.34 |
| U79 | Provider credentials from the admin: encrypted per environment, "test before store" gate. | Doc-only | `07:440` (`providers.manage`, "credential rotation"), `DEPLOY-COOLIFY:140`. No test-before-store gate. | 07, 12 | No | Versioned secrets manager | L06 TASKS 8.33 |
| U80 | Public API tenant selector: `storeSlug` in the body is correct; do not move the routes. | N/A | Bukalaris uses host resolution (`08`, ADR-0008). | — | — | — | L06 AGENTS ~1250 |
| U81 | A role label can be true of nothing. Ship order: create role and password, set env, then merge the strict code. A change that adds a hard env requirement ships in two phases. Healthcheck must not depend on tenant data. Rollback is one env variable. | Doc-only | G1/SEC-25 (T-76) covers proof. The two-phase ship order has no hit. `DEPLOY:63` notes the role. `/api/health` is "no DB call" (`DEPLOY:~281`), which fits. | DEPLOY-COOLIFY | No | Separate Postgres roles per service | L06 AGENTS ~300; L11 task-4.12 :36-95; L11 session-close :19-36 |
| U82 | Go-live runbook shape: every real-money step is owner-run with read-only witness checks; prefix, webhook registered, who pays the courier, test product with real dimensions. | Doc-only | `RUNBOOK:334-366` is a checklist; the owner-run step shape and the sandbox prefix check are not there. | RUNBOOK | No | Signed-off checklist with evidence capture | L11 go-live-runbook :22-80 |
| U83 | Hand-written provider fixtures: see G3. | Covered | `15:88`. | — | — | — | (merged into G3) |
| U84 | An under-test table or UPDATE that matched 0 rows reported success. | Covered (G8) | — | — | — | — | — |

## By owner document (only Gap / Doc-only)

- **02-PRD**
  - U66 (close Q-10 reservation expiry — decision)
  - U9 (Q-17 already open)
- **05-DATA-MODEL**
  - U22 (index census)
  - U35
  - U36
  - U37
  - U61
  - U64 (stock write path)
  - U66 (reservation `expires_at`)
- **06-TENANT-ISOLATION**
  - U65 (store row self-UPDATE)
- **07-IAM-RBAC-ABAC**
  - U13
  - U79
- **08-DOMAIN-ROUTING**
  - U75 (decision)
  - U76
- **09-API-SPECIFICATION**
  - U27
  - U28
  - U29
  - U30
  - U37 (decision)
  - U70
- **11-BILLING-PAYMENTS**
  - U6 (alarm)
  - U7
  - U8 (decision)
  - U9
  - U10
  - U32 (decision)
  - U33
  - U66
  - U69
  - U74
- **12-SECURITY-ARCHITECTURE**
  - U4 (decision)
  - U12 (decision)
  - U48
  - U65 (decision)
  - U77 (decision)
  - U79
- **13-COMPLIANCE-PRIVACY**
  - U14 (decision, legal review)
- **14-SLA-DISASTER-RECOVERY**
  - U3
  - U18
  - U19
  - U71
- **15-DELIVERY-MIGRATIONS**
  - U10
  - U22
  - U23
  - U25
  - U34
  - U46
  - U49
  - U68
  - U70
- **16-OBSERVABILITY-RATE-LIMITING**
  - U6
  - U12 (decision)
  - U30
- **17-UX-FLOWS-SCREEN-CONTRACTS**
  - U8
  - U13
  - U15
  - U16
  - U19
  - U31
  - U39
  - U51
  - U52
  - U56
  - U58
  - U59
  - U60
  - U67
- **10-DESIGN-SYSTEM**
  - U15
  - U59
- **RUNBOOK**
  - U2
  - U16
  - U33
  - U70
  - U81
  - U82
- **DEPLOY-COOLIFY**
  - U1
  - U2
  - U3
  - U4 (decision)
  - U20 (decision)
  - U21
  - U76
  - U77 (decision)
  - U81
- **AGENTS**
  - U17
  - U26
  - U34
  - U48

## Decision candidates for the owner

- **D1 — Origin exposure and `DEPLOY-COOLIFY.md:32,329` (U4). The docs conflict with a TokoΦ lesson.**
  - Bukalaris wants custom domains, and ACME HTTP-01 and non-Cloudflare custom domains would break under a Cloudflare-only 80/443 rule.
  - Recommendation: close the panel ports (8000/6001/6002) and reach the panel through Tailscale or a Cloudflare Tunnel. Use Authenticated Origin Pulls only on Cloudflare-proxied hosts. Remove "80/443 Cloudflare ranges only" from the doc, or scope it to the apex and platform hosts.
- **D2 — Stock reservation expiry and abandoned prepaid orders (U66, U32, Q-10).**
  - Recommendation: add a reservation row with `expires_at` equal to the bill expiry, released in the same transaction as the `EXPIRED` write. For fee truth, submit `order payable + our fee` and persist the amounts as an immutable snapshot, so the buyer sees exactly what is billed.
- **D3 — Tenant self-write on `store` and the product-edit stock write (U65, U64).** Both are confirmed in code (`0007_rls.sql:121`, `catalog.ts:208-217`).
  - Recommendation: replace the table-level `UPDATE` grant on `store` with column-level grants, and add a guard trigger for `status` and `suspended_at`, plus a test. Remove `stock` from the product-edit write; allow stock changes only through a delta `adjust` with a reason.
- **D4 — Deploy gate when CI is unavailable (U20).** `ci.yml` has never run.
  - Recommendation: deploy only from a green workflow, or from a protected `deploy` branch. Make `pnpm verify` the documented local gate until then.
- **D5 — Seller finance definition (U8).** `dashboard.ts` counts every non-cancelled order, including an unpaid VA.
  - Recommendation: add one `collected` predicate (paid prepaid, or COD at `selesai`) and caption the "live orders" tile.
- **D6 — Rate-limit failure modes (U12).** The shared counter is implemented, but the open/closed policy per bucket is not written.
  - Recommendation: fail closed on login and signup; fail open on payment callbacks and checkout. The login-failure counter must never lock out an owner.
- **D7 — Legal items from the statutes (U14).** Two working days minimum for exchange or cancellation (PP 80/2019 Art. 69), a complaint service (Art. 27), and refund by a payment-receiving operator (Art. 71).
  - Recommendation: send the facts as a brief to a lawyer. Show no legal basis on a buyer screen until it is answered. Current-source required.
- **D8 — Shippable product dimensions and volumetric weight (U37).**
  - Recommendation: require L×W×H on shippable products and use one `parcelFor(cart)` for quote and booking.
- **D9 — Unreviewed store storefront policy (U75).** A real hole only if self-serve signup opens before a review step.
  - Recommendation: gate on `suspended_at`; return the same 404 as "no such store".
- **D10 — HSTS ramp (U77).**
  - Recommendation: start with 24 h at the origin, then ramp to one year per zone once all records are proxied and TLS is validated. Do not use `includeSubDomains` until custom-domain hosts are decided.

## Covered

- U5 → `ADR-0006:116`; `t49-payments.test.ts:119,125`
- U6 (entropy, per-store isolation) → `billing/invoices.ts:15-17`; `billing/cycle.ts:48-51`
- U24 → `t62-routes.test.ts:8-10`; `17:761`; `07:403`
- U25 (journal, stamp, idempotent SQL) → `15:44-`
- U38 (unmapped status never moves money) → `fulfillment.ts:56-73,442-464`
- U40 → `ledger/finance.ts:126-127`
- U41 → `promotions/checkout.ts:94-95`
- U42 → `rls.test.ts` registry; `ADR-0005:86`
- U43 → README; `rls.test.ts`
- U44 → `attempts.ts:23,149`; `callback.ts:31,63`; `ADR-0006:118,137`
- U45 → `schema-payments.ts:20`; `attempts.ts:29`
- U47 → `07:391,594`; `auth.ts` (`revokeSessionsOnPasswordReset`)
- U49 (DB env) → `global-setup.ts:16-18`
- U53 → `AGENTS.md:80`; `checkout.ts:77,104`
- U54 → `AGENTS.md:80`; `checkout.test.ts:26-27`
- U55 → `ADR-0006:84,90`
- U57 → `checkout.ts:329`; `05:324`
- U62 → `host.test.ts:110`; `host.ts:178`; `08:239`
- U72 → README (no oversell; same-variant-twice test)
- U73 → `orders.ts:32`; `ADR-0006:137`
- U78 → README (channels read live)
- U33 (refund row) → `schema-ledger.ts:379`; `05:265`
- U9 (COD release only after reconciliation) → `11:214`; `ADR-0006:96`; `fulfillment.ts:49`
- U11, U63, U80 → N/A (no HTTP cron, no custom JWT, host resolution)

**Not checked in code:** U13 (concurrent-invite race), U46 (callback URL contract test) and U75 (storefront gating for an unapproved store) were not fully read. I recorded them from a narrow `rg` only. Verify before acting on them.

## Orchestrator verification (2026-11-01)

Re-checked by reading the files (not executed):
- U65 confirmed: `drizzle/0007_rls.sql` grants `UPDATE` on the whole `store` table to `bukalaris_app`, and
  `isolation-registry.ts` records `store: tenant("SELECT,UPDATE", …)`. The `store_suspension_sync` trigger
  (`0013_chain_a_wave3.sql`) only keeps `suspended_at` consistent with `status`; it does not stop the app role
  from writing `status`. This is defense in depth, because seller services do not write `status` today.
- U64 confirmed: `variantInput` in `seller/commerce/catalog.ts` includes `stock`, and `updateVariant` writes it
  with `.set(input)`. A value loaded in the form before a sale overwrites the decremented stock (lost update),
  even though the row is locked during the write.
- U13, U46 and U75 were flagged by the synthesis agent as narrow-grep only; they stay unverified.
