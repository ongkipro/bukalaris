# Bukalaris implementation decisions

Repository-level decisions taken while implementing. Costly-to-reverse
architecture choices get an ADR (`docs/ADR-*.md`); this file records the rest,
including deliberate ceilings. Newest last.

## D-1 — M1 stack and pinned versions (2026-10-06, T-1)

Decision: pnpm workspace (`pnpm@11.22.0`), Node 24 (engines `>=20.9.0`, Next 16
minimum). Exact pins, checked against the npm registry on 2026-10-06:

| Package | Version | Note |
|---|---|---|
| next / eslint-config-next | 16.3.8 | App Router, Turbopack default, `proxy.ts` replaces middleware |
| react / react-dom | 19.2.8 | Version paired by `create-next-app@16.3.8` |
| typescript | 6.0.3 | 7.x (native) only exposes an `unstable/*` API; typescript-eslint 8.71 supports `<6.1` |
| eslint | 9.39.5 | eslint-config-next plugins not yet verified on ESLint 10 |
| tailwindcss / @tailwindcss/postcss | 4.3.3 | |
| shadcn (+ @base-ui/react 1.8.0, cn 0.4.0) | 4.21.1 | `base-nova` style from `shadcn init -d` |
| drizzle-orm / drizzle-kit | 0.45.3 / 0.31.11 | Stable lines; 1.0 is still RC |
| postgres (postgres.js) | 3.4.9 | Pure JS driver, no native build |
| better-auth | 1.7.7 | See ADR-0004 |
| zod | 4.6.5 | |
| vitest | 5.0.3 | |
| @playwright/test | 1.63.0 | |
| PostgreSQL (compose) | 17-alpine | Local dev; host port 5442 |

Telemetry is disabled for Next (`NEXT_TELEMETRY_DISABLED=1` in scripts and
Dockerfile) and Better Auth (`telemetry.enabled: false`). Fonts use the system
stack instead of `next/font/google`, so builds need no external font fetch.

## D-2 — One Next.js app for M1; Astro storefront deferred (deliberate ceiling)

Superseded in part (2026-10-27): the separate-apps proposal below and the ceiling "no separate origins/cookie namespaces per surface" are replaced by [ADR-0008](ADR-0008-platform-architecture-and-routing.md) and TD-7: one Next.js application with exact-host dispatch and a separate host-only cookie and session audience per surface (delivered by T-70). The Astro recommendation is superseded by the owner direction recorded in 02-PRD ("Stack and named surfaces"). The text below is kept as history.

Context: Architecture proposes `apps/bos`, `apps/app`, `apps/checkout`,
`apps/storefront` (Astro) and `apps/worker`.

Decision for M1: a single Next.js app `apps/web` hosts the Owner console (`/admin`, formerly Super Admin),
Seller Admin (`/seller`), a minimal storefront (`/s/<slug>`, also reachable via
`<slug>.<STORE_ROOT_DOMAIN>` host rewrite in `src/proxy.ts`) and hosted
`/checkout`. Shared business rules live in `packages/db` so a later split
reuses them unchanged.

Ceiling and upgrade path: no separate origins/cookie namespaces per surface
(IAM "separate operator and merchant session namespaces" is not met), no Astro
renderer, no checkout handoff/session (ARCH-7), single responsive theme. Split
surfaces into their own apps when M2 introduces custom domains, the external
channel handoff or the second theme; the core services move with no rule fork.

## D-3 — Store is the tenant root in M1

The data model shows TENANT ||--o{ STORE. M1 has exactly one store per seller
organisation and no tenant-level data, so `store` is the tenant root and
`store_id` is the ownership key on every seller-owned row. Upgrade path: add a
`tenant` table and `store.tenant_id` when a seller needs more than one store
under one billing/ownership root.

## D-4 — Tenant enforcement in M1: scoped data access + compound FKs; RLS deferred

Superseded (2026-10-07, T-27): row-level security with the three roles `bukalaris_owner`, `bukalaris_app` and `bukalaris_platform` is implemented; [ADR-0005](ADR-0005-database-tenant-isolation-rls.md) and its 2026-10-27 amendment (T-59) are the current tenant-enforcement decision. The text below records the M1 ceiling as history.

Decision: Every store-owned query lives in `packages/db/src/*.ts` and takes a
scope object (`SellerScope`, `StorefrontScope`, `OperatorScope`) produced only
by `packages/db/src/scoped.ts`: from verified membership (`sellerContext`),
from active-store host/slug resolution (`storefrontScope`), or from a
`platform_operator` row (`operatorScope`). Queries filter by `scope.storeId`.
Child rows use compound `(store_id, parent_id)` foreign keys, so a write that
mixes stores fails in PostgreSQL even if application code is wrong.

Ceiling: no PostgreSQL row-level security and a single DB role for app and
migrations (05-DATA-MODEL recommends both). Upgrade path: add a non-owner
runtime role, `SET LOCAL app.store_id` per transaction inside the scope
helpers, RLS policies on store-owned tables, and run the existing isolation
tests under that role.

## D-5 — Checkout stock and payment policy defaults (Q-10 open)

Safe reversible defaults until the finance owner decides Q-10:
- No cart reservation; stock is decremented atomically at order submit
  (`UPDATE … WHERE stock >= qty` in the order transaction). No expiry,
  cancellation or restock flow exists in M1.
- COD orders are `placed`; manual transfer orders are `awaiting_payment` and
  get a payment instruction from the (fake) AutoLaris adapter after commit. A
  failed instruction leaves the order `awaiting_payment` with no reference
  (explicit pending state, NFR-5). Nothing marks an order paid in M1.
- Shipping fee comes from the server-side (fake) Mengantar quote; the client
  only names the courier option.

## D-6 — Cart, idempotency and order-outcome access

- The cart is a server row keyed by a random UUID kept in an HttpOnly cookie
  named per store (`bl_cart_<storeId>`, REVIEW R-8); the UUID is the buyer's
  capability. Carts of different stores coexist in path mode; in host mode the
  host-only cookie is already per store. A cart belongs to one store
  (FK-enforced); a foreign-store or checked-out cart id is never reused.
- `/checkout?store=<slug>` only selects which store's cart cookie to read; the
  store must be active and the cart row must belong to it, otherwise checkout
  shows nothing.
- `order.cart_id` is unique (one order per checked-out cart); idempotency key
  is unique per store and stored with a SHA-256 request hash. A replay with the
  same key and payload returns the same order; a different payload is rejected.
- The confirmation page requires the checked-out cart id cookie
  (`bl_order_cart`); an order number alone shows nothing.
- Ceiling: same-origin cookies only — no checkout handoff/session for external
  storefronts (ARCH-7, T-19).

## D-7 — Test databases

Integration tests use `bukalaris_test` (truncated per test). Playwright uses
`bukalaris_e2e`, which `apps/web/e2e/global-setup.ts` wipes, migrates and
seeds on every run, and runs against the standalone server build. Neither
touches the dev database `bukalaris`. Guards refuse URLs without `_test` /
`_e2e` before truncating or wiping.

## D-8 — External catalog identity, URL segment and slug aliases (2026-10-07, T-14)

Decision: `product.catalog_id` and `variant.catalog_id` are `bigint NOT NULL UNIQUE`
columns defaulted from one dedicated sequence `catalog_id_seq` (START 10000) shared by
both tables, separate from the identity primary keys, backfilled for existing rows by
the `ADD COLUMN … DEFAULT nextval()` rewrite (distinct per row), and frozen by a
`BEFORE UPDATE OF catalog_id` trigger (`catalog_id_immutable`, migration 0003).
TypeScript reads the column through a `customType` as a **string**; the Storefront API,
order-line snapshot (`order_line.variant_catalog_id text`) and future feeds/events carry
it as a string too (PR-12, PR-20 content ids: variant id = item, product id = group).

Why bigint + sequence over text/random: the sequence is collision-free under concurrency
without MAX+1 or retries, is cheap to index, and the shared sequence guarantees an item id
never equals a group id. Why ≥ 10000: the memory rule asks for at least five digits with
no zero padding; starting the sequence there gives that for free and makes a numeric URL
segment unambiguous — ≥ 5 digits is a catalog id, fewer digits is a legacy database id.

URL: the canonical product path is `/products/<slug ?? catalog_id>`. The database id no
longer appears in storefront URLs; a legacy `/products/<db id>` (only ever generated
locally — nothing is deployed) still resolves and 308s to the canonical path. The seller
editor keeps `/seller/products/<db id>` (short, routine navigation) and displays the
catalog id as "ID produk" with a copy button.

Slug aliases: renaming a product's readable slug inserts the old slug into
`product_slug_alias (store_id, slug) → product_id`. An alias resolves straight to its
product, so one 308 reaches the canonical URL (no chains); a slug that is an alias of
another product cannot be taken (`slug_taken`), and a product reclaiming its own old slug
deletes the alias. Slug changes within a store are serialised with
`pg_advisory_xact_lock(store_id)` so the alias check and the unique index cannot race.

Ceilings: no alias for the numeric canonical (ids never change, so none is needed); no
feed export yet (granularity frozen as variant item / product group per Q-7); the
hand-written trigger and backfill live in `0003_catalog_guards.sql` and must be kept
verbatim when migrations are consolidated.

## D-9 — Migrations are append-only from 2026-10-07

Until wave 2a, post-M1 migrations were regenerated into one file at each merge
because nothing was deployed. `0003_catalog_guards.sql` is hand-written
(immutability trigger, backfill), so from now on migrations are append-only:
a branch's generated migrations are dropped at merge only when they contain no
hand-written SQL, and the merged schema is regenerated as the next number on
top of `main`. From the first deployment on, adding a NOT NULL column to a
populated table follows expand → backfill → contract (15-DELIVERY-MIGRATIONS
DEL-2); `0004` adds NOT NULL order columns without defaults, which is only
acceptable because no database with orders exists yet (dev DB checked: 0 orders).

## D-10 — App role may update the store-less `mail_outbox` for redaction (2026-10-07, T-43) — SUPERSEDED 2026-10-28 by T-73

Superseded: migration 0012 revokes every `bukalaris_app` privilege on `mail_outbox`; the app reaches it only through the SECURITY DEFINER functions `mail_enqueue`, `mail_privacy_export`, `mail_privacy_redact` and one more (all store-bound, registered in `DEFINER_FUNCTIONS`). The text below is the historical ceiling.

Decision (accepted ceiling): `0009_wave4_rls.sql` grants `UPDATE ON mail_outbox
TO bukalaris_app` so a seller's buyer-data redaction (`redactOrders` in
`packages/db/src/privacy.ts`) can strip the body, and for buyer copies the
address, of mails already written to the dev mail sink. `mail_outbox` has no
`store_id` and no RLS policy, so this grant is table-wide, wider than the tenant
boundary. The code only touches rows matched through the store's RLS-protected
`order_notification` records and platform-wide order ids, inside the store's
`inStore` context; no other app code updates `mail_outbox`.

Why acceptable now: `mail_outbox` is the local/dev sink (OPS-01 `/dev/outbox`),
no real mail provider exists, nothing is deployed, and redaction must reach
every copy of the buyer's contact data (SEC-19, PRIV-4).

Revisit when a real mail provider is chosen: add `store_id` + `FORCE ROW LEVEL
SECURITY` to `mail_outbox` (or its replacement), or move the body redaction to
the platform role, then revoke the table-wide app `UPDATE`.

## D-11 — COD release H+1 and M3 ledger ceilings (2026-10-27, ADR-0006)

Superseded (2026-10-27, later the same day): the H+1 release rule below is replaced by D-14 (release at delivered and reconciled). The ceilings list at the end of this entry stays valid.

Decision (owner, 2026-10-27): COD merchandise proceeds are booked `pending` when
the order reaches `completed` (delivered) and released to `available` 24 hours
later (`cod_release_delay_hours`, default 24; "H+1"). Prepaid proceeds release at
`completed`. Nothing releases at `shipped`.

Why acceptable now: the delay is a return-window buffer, not proof of remittance.
The platform still advances COD cash for the Mengantar remittance lag, and no
Mengantar COD settlement mechanism or report is verified. This stays a Q-17
legal and finance gate before the first real COD shipment, and it is sized by
`min_payout_idr` plus the delay, not by seller convenience.

Ceilings accepted for M3 (revisit when a real Mengantar booking exists):
- One booking per order (`shipment_order_uq`): rebooking after a cancelled or
  failed booking is unsupported until an immutable booking-attempt record exists;
  the ledger enforces one `shipping_debit` and one reversal per order.
- The buyer COD handling fee is OFF by default because Mengantar's COD fee is
  already inside the quoted courier cost; enabling it needs a re-pricing check.
- Provider facts in ADR-0006 decision 10 (status code mapping, COD settlement,
  COD fee floor and VAT, reference-length limits, cancellation semantics, IP
  allow-list) are unverified and gate live use only.

## D-12 — Startup posture, Owner console naming, Update Log host and issue-report button (2026-10-27, ADR-0008, ADR-0011, ADR-0012)

Decision (owner, 2026-10-27):
- **Posture.** Bukalaris is an online-store platform (Shopify-like), not a marketplace.
  Each store is run by its own seller, who handles their own taxes; affiliates handle
  tax on their own commission. Licensing and permit alignment will be adjusted later.
  For the startup phase obligations are relaxed on tax, KYC and compliance: seller
  verification is an optional record that never gates store activation, no tax gate,
  withholding or collection runs, and the Compliance center and tax liability
  machinery are dormant Phase 2 (T-64, T-67 deferred). Security, audit, masking, MFA
  and four-eyes for money are not relaxed.
- **Naming.** The platform operator surface (the **Owner console**, formerly
  "Super Admin" / "Bos"; the interim host label `berkah` was never deployed) lives at
  `owner.bukalaris.com`. Existing ids (`SA-nn`, `/admin`,
  `platform_operator`) are not renamed. The store-level role `owner` ("Pemilik toko")
  is a different thing; ADR-0011 holds the disambiguation rule.
- **Update Log host.** `logs.bukalaris.com` is the public product Update Log
  (ADR-0008), not the internal Log System (OBS-5, `/admin/logs`). `owner` (active) and
  `logs` join the reserved platform labels; `berkah` and `bos` stay reserved-unused.
- **Issue report.** A persistent "Lapor masalah" button in every Owner console page
  header files an issue report into an internal queue (DATA-14 `issue_report`,
  SA-50, T-68).

Why acceptable now: nothing is deployed and no real seller, affiliate, buyer or money
exists; the applicability of PP 80/2019, UU PDP and PSE registration is UNVERIFIED and
an advisor item, not a startup blocker; the dormant designs (ADR-0011 Phase 2,
ADR-0012) keep the later switch-on a configuration and acceptance exercise, and the
rename touches copy only.

Revisit when: licensing or permit alignment completes, or an advisor or the authority
classifies the platform as a marketplace or electronic-system operator; before the first
real seller or affiliate payout and before the first real users' personal data is
processed in production; a complaint, takedown or privacy request arrives that ordinary
cases cannot handle; the platform grows beyond what a single small operator team can
review.

## D-13 — Tax identity before the first payout becomes a policy flag (2026-10-27, ADR-0012)

Superseded rule: the earlier owner wording of the same day, "NPWP/KTP tax identity is
required before the FIRST affiliate payout" with the platform as withholding agent
(ADR-0009, BILL-8, PRIV-6, T-53).

Decision (owner, 2026-10-27): for the startup phase this is no longer a rule. It
survives only as the effective-dated policy flag `tax_identity_required_for_payout`
(default OFF) in `tax_setting` (DATA-15); `withholding_enabled` is also OFF. A payout
is not gated on tax identity, carries `tax_idr = 0` and `net = gross`, and affiliates
see earnings statements; tax identity capture is optional and voluntary once
`identity_capture_enabled` is switched ON after the PRIV-10 notice is approved. The
earlier behaviour stays fully specified as the Phase 2 mode that the platform owner activates (Tax activation), with approval by a second operator holding `tax.approve`,
under the ADR-0012 section 5 criteria.

Why acceptable now: affiliates handle their own tax, the platform is not a designated
marketplace collector (ADR-0012 F1), and no live payout exists; the statutory
treatment of commission withholding is UNVERIFIED (ADR-0012 F2, F3) and an advisor
item.

Revisit when: the owner decides to activate withholding or the payout gate; a named
tax advisor confirms the policy facts; the tax authority designates Bukalaris or
licensing alignment changes its classification (a new ADR, ADR-0012 section 6); or
payout volume makes statements alone insufficient.

## D-14 — Seller money is credited only for delivered and reconciled parcels (2026-10-27, ADR-0006)

Supersedes: the H+1 (24 hours after delivery) release rule of D-11.

Decision (owner, 2026-10-27): a sale is released to the seller's `available` balance only when the order is delivered AND the delivery is reconciled (`reconciled_at`, `reconciliation_source`). Nothing is credited for a parcel that is in transit, returned or cancelled, so there is no negative balance by construction (the earlier negative-balance question, OPEN-F1, falls away). Returns after delivery are outside the ledger scope in M3. Whether and how the provider reports delivered-and-settled status is UNVERIFIED, so until it is verified reconciliation is a batch run in the Owner console (four-eyes) against provider evidence.

Why acceptable now: no real seller or money exists and the reconciliation signal is unverified; a manual batch is the safe default.

Revisit when: the provider's settlement signal is verified and an automatic source can replace the batch (the `reconciliation_source` column already distinguishes them).

## D-15 — Unified Bukalaris-managed shipping: Partner API seller generation, shipping discounts and cashback in our hands (2026-10-27, ADR-0006, ADR-0007)

Supersedes: the interim hybrid / `own_key` / System A vs System B split drafted earlier on 2026-10-27.

Decision (owner, 2026-10-27): 100% of shipping, payments, discounts, margin, and shipping cashback are managed by Bukalaris under **one unified system**. Sellers never paste an external Mengantar API key (`own_key` is deleted) and there is no two-system split (`SA-54` is retired into `SA-07`). Instead, Bukalaris generates a new Partner-managed Mengantar seller account (`POST /api/partner/v1/sellers`, `partner_managed`) for every store — even sellers who previously had an older external Mengantar account must use the new Bukalaris-generated account (using a platform-managed store routing email or fresh email if `409 EMAIL_ALREADY_REGISTERED` occurs) — with the platform master Mengantar account (`platform_master`) as fallback. The Owner console (`SA-07`) controls courier service eligibility (`courier_service_policy`), shipping discounts, platform margin, and shipping cashback split rules (`cashback_rule`, booked as `ledger_entry.kind = 'cashback'` and released only when delivered and reconciled). COD is offered only for courier services with `cod_allowed` and `return_free` (currently SPX, data-driven, never hard-coded; UNVERIFIED live gate `OPEN-F7`). Prepaid orders always pay through our AutoLaris gateway.

Why acceptable now: keeps all money, discounts, cashback, COD reconciliation, and affiliate commissions under one unified ledger and operator control; partner settlement/cashback sweep mechanics with Mengantar are gated on `OPEN-F9` before switching live COD from `platform_master` to `partner_managed`.

Revisit when: Mengantar confirms partner settlement/cashback sweep (`OPEN-F9`) and SPX free-return terms (`OPEN-F7`) in writing/sandbox.

## D-16 — Affiliate commission only for delivered parcels across all opted-in orders, 3-day hold default (2026-10-27, ADR-0009)

Decision (owner, 2026-10-27): an order in transit, returned or cancelled earns no commission. Because all orders (prepaid and COD) run through Bukalaris's single unified system (D-15), **all opted-in seller orders are eligible for affiliate commission**. Commission is credited only when the order is delivered AND its seller sale is released (D-14), then held for `affiliate_hold_days` (decided default: **3 days**, Owner-configurable in `SA-12`). There is no `unfunded` state and no `commission_void` ledger kind: a return before delivery voids the attribution as a state change. Precedent (99ribu): commission matures after verified receipt + hold, is voided on in-transit return, and a late claim after payout is an explicit manual finance correction.

Why acceptable now: unified shipping eliminates the seller-account COD funding gap and removes exposure to in-transit returns.

Revisit when: real delivery/return rates warrant adjusting `affiliate_hold_days` in the Owner console.

## D-17 — PPN off by default and Owner-switchable (2026-10-27, ADR-0012, BILL-7)

Decision (owner, 2026-10-27): PPN is OFF by default. The Owner console can switch it with the capability `tax.manage`, a confirmation dialog and a required reason, audited and applying to new invoices only; it is not four-eyes and has no hard PKP gate. The rate is always an effective-dated `vat_output` policy value; no 11% is computed or hard-coded in the startup phase. The company (PT) legal documents are not issued yet, so no PPN invoice document or e-Faktur is produced. Readiness (PT documents, PKP status, accountant, invoice/e-Faktur export, confirmed rate policy; ADR-0012 OPEN-T20) is the deferred task T-75 and gates that task, not the switch.

Why acceptable now: Rp0 PPN on every invoice is the honest state until the entity, PKP status and an accountant exist.

Revisit when: the PT documents, PKP status and an accountant are in place (T-75 entry criteria).

## D-18 — Issue-report screenshots: none in Phase 1 (2026-10-27, UX-22)

Decision (owner, 2026-10-27): the "Lapor masalah" control stores text and captured technical context only; no screenshot attachment is built in Phase 1. The dormant attachment table stays unused.

Why acceptable now: screenshots can show revealed personal data, and scrubbing images is not specified.

Revisit when: an attachment design with size caps, re-encoding, access control and PRIV-9 purpose rules is accepted.

## D-19 — Decided payout anti-fraud controls, self-service recovery, and startup SLA/DR baseline (2026-10-27, ADR-0006, ADR-0010, ADR-0011, DR-1)

Decision (owner, 2026-10-27, "sisanya kamu sesuaikan"):
1. **Bank-destination payout controls (closes OPEN-F5):** Mandatory for all seller and affiliate payouts: step-up authentication, notification to the previous verified contact, a **72-hour hold** on any new or changed bank destination (default 72 hours, Owner-configurable; also applied after credential recovery or MFA reset), and account-holder-name check shown to the four-eyes approver.
2. **Staff ownership recovery & buyer merge disabled in Phase 1 (closes D6):** Staff-executed store-ownership recovery (`members.recover`) and staff-executed buyer merge (`merge.execute`) remain disabled (404) in Phase 1. Locked-out sellers use self-service recovery (registered email or phone OTP, MFA recovery codes); buyers merge accounts only via self-service proof of possession of both identifiers.
3. **Startup SLA/DR baseline (closes D8):** Option B with client-side encryption in `14-SLA-DISASTER-RECOVERY.md`: **99.5 % availability target** (~3.6 hours/month budget), **hourly `pg_dump -Fc` (RPO 1 hour)**, **RTO 4 hours** proven by `scripts/db-restore-rehearsal.sh` before pilot, and **client-side encrypted offsite dumps** to Cloudflare R2 before live customer or bank data is stored.

## D-20 — Owner confirmations before Chain A implementation, and the quality bar versus Tokophi (2026-10-28, ADR-0005, ADR-0006..ADR-0010, T-59, T-60, T-61, T-70)

Decision (owner, 2026-10-28, "mengikuti keputusanmu", i.e. every recommendation of the 2026-10-28 decision list is accepted):
1. **T-59 accepted** (RLS framework and narrow platform grants; amends ADR-0005, so that amendment is accepted too). Not started.
2. **T-60 accepted** (platform capability grants for the Owner console). Not started.
3. **T-61 accepted** (variant weight and parcel weight). Implemented locally 2026-10-28. Accepted behaviour change: parcel weight is quantity × variant weight rounded up to whole kg (minimum 1 kg), so two 1 kg units now quote as 2 kg. Mengantar rounding and minimum weight stay UNVERIFIED.
4. **T-70 accepted** (exact-host dispatch, per-surface sessions, reserved labels), implemented locally ahead of its T-59 dependency. Conditions that stay open: the T-59 role design for the auth tables is applied when T-59 lands, and session-bound CSRF tokens (DOM-6) are built before any non-local exposure; until then the exact-`Origin` and Fetch-Metadata checks are the only CSRF control.
5. **Existing local code is kept** (T-51, T-61, T-70). Nothing is committed or branched unless the owner asks for that specific action; a patch and tarball backup sits outside the repository.
6. **Operator identity uses separate operator tables**, not the seller account tables (closes the T-59 "operator auth instance" OPEN). Details belong to the T-59 slice that owns the auth tables.
7. **OPEN-F4 (buyer refund) decided:** refund the full `payable`, including the gateway admin fee; disburse by manual transfer to a destination the buyer supplies on the signed order-status page, verified by an operator under the refund capability. Applies before the first refund.
8. **OPEN-B1 (lapsed subscription periods) decided:** do not back-bill. Close each lapsed period `void` with reason `lapsed`, invoice the current period and keep the billing anchor.
9. **ADR-0006, ADR-0007, ADR-0008, ADR-0009 and ADR-0010 are Accepted** as decisions (not as implementation evidence; their implementation status stays in `TASKS.md`). **ADR-0011 and ADR-0012 stay Proposed** until the owner re-reads them (Owner console governance and tax workflows). ADR-0001..ADR-0003 are unchanged.
10. **Mechanical documentation update authorised:** rename `CRSEC-nn` review ids so the traceability checker no longer reads them as `SEC-nn`, repair the five malformed tables, and give each task with nested Done-when bullets a one-line summary on the `Done when:` line. No meaning changes.

Quality bar (owner, 2026-10-28: "the system we build will be better than Tokophi"): Tokophi and 99ribu are sources of proven invariants and recorded incidents, not templates. Where the research found a Tokophi weakness (callback accepted without a valid signed reference, a state machine that silently drops legal-looking transitions, ledger balances computed through joins that lose rows, gateway fee mixed into seller money, tracking-id length traps, fee bases that ignore the transaction), Bukalaris must be stricter, and each such lesson must exist as a named automated test, not only as prose. Obligation recorded here, not yet fulfilled: a lesson-to-test map (lesson, ADR/BILL id, test file and case) that the owner can read, created with the first money task (T-37 or T-49).

Why acceptable now: all live gates are unchanged (Q-17 legal review, OPEN-F8, OPEN-F9, Mengantar write test, partner secret rotation); this decision only releases local implementation against fake adapters.
Revisit when: any accepted ADR changes. (Item 9 was partly superseded the same day: ADR-0011 and ADR-0012 became Accepted under D-21.)

## D-21 — Document alignment approved, ledger shape kept, callback = verify-by-pull, ADR-0011/0012 accepted (2026-10-28, ADR-0006, ADR-0011, ADR-0012, T-37, T-49, T-74)

Decision (owner, 2026-10-28, "A-K setuju | L accept aja"), after a study of 99ribu (`/home/ongki/Projects/99ribu`, single-tenant, no RLS, Mengantar unimplemented) by four read-only surveys:
1. **A:** PR-1, PR-2, PR-4, PR-15 and PR-28 are Accepted.
2. **B, C, D, E, F, G, H, I:** stale text is aligned to existing decisions: the unified Partner Mengantar model of D-15 and D-16 replaces every active hybrid / `own_key` / System A-B / seller-account-COD-exclusion statement; T-48 is renamed "Unified Partner Mengantar shipping accounts"; the SLA baseline is the one decided in D-19; the multi-app and Astro text is marked superseded by D-2 and ADR-0008; production origins are per surface and `BETTER_AUTH_URL` is only the local one-host and development fallback; "Super Admin", "Bos" and "Tenant Admin" are replaced by "Owner console" and "Seller Admin" as active names; `mail_outbox` is documented in the data model; the context record and the `ARCH-1` review metadata are corrected.
3. **J — the ledger stays single-entry append-only (ADR-0006).** A double-entry ledger as in 99ribu is not adopted. Instead the contract gains ledger consistency invariants: balances are derived by `SUM` and never stored; a read-only `pnpm verify:ledger` command and an automated test recompute every store and prove one `sale` per order, at most one `return_reversal` per order, `available` never negative, every payout and payout reversal paired with a payout row, every released entry carrying `released_at` and `release_basis`, and no balance query joining `order`. T-37 builds the command and the test.
4. **K — AutoLaris callback = verify-by-pull.** A callback with a valid signed reference is only a trigger: it records the body digest and enqueues a verification job that calls the provider inquiry; a payment becomes `paid` only when the inquiry returns `rc` `00` and status `PAID` and the provider amount equals the attempt's `total_idr`; anything else is `unknown` or pending and never settles; a callback never moves money by itself. All existing live gates stay (settlement of live money remains operator-confirmed until the vendor status codes are observed in production). T-49 builds it.
5. **L — ADR-0011 and ADR-0012 are Accepted** as decisions, not as implementation evidence.
6. **Patterns adopted from the 99ribu study** (as acceptance criteria of the named tasks, each needing a named automated test): `unknown` outcome state for jobs and payouts with no re-dispatch before a reconciliation proves "no effect" and a `markDispatched` fence (T-74, T-37, T-49); bank-transfer evidence that cannot be reused across payouts (T-37); payout claim lease and single-use step-up proof consumed atomically in the write transaction (T-37, T-60, T-62); MFA bound to the session, last-owner protection with deterministic row locks and session revocation on role change (T-60); allowlist-based audit redaction (T-62); retention purge that is off by default, pinned to the table owner with a fixed `search_path`, with a catalog-driven check that no row referenced by a foreign key is purged (T-74); restore rehearsal that refuses to restore onto the live cluster (T-74). Not adopted: shared user table for operators and buyers, array-typed permissions, a global dedup key space, a missing `dead` status, per-process retention sweeping, hard-coded ledger account CHECKs, and the `/create_payment` endpoint (ADR-0006 keeps `/submit`).
7. **Where 99ribu has nothing,** Bukalaris must exceed it by design: row-level security with registry-driven isolation classes (T-59), asynchronous four-eyes approvals and break-glass (T-60, T-62), the 72-hour payout-destination hold (D-19), a periodic enqueuer with per-kind priority so bulk jobs cannot starve payments (T-74), per-store Partner Mengantar accounts (T-48).

Why acceptable now: this changes documents only; code is released for T-59 and T-60 by D-20.
Revisit when: any accepted ADR changes, or the first live provider test shows the verify-by-pull inquiry cannot confirm a payment within the unknown-outcome window.

## D-22 — Goal Mode defaults taken on the orchestrator's recommendation (2026-10-28, ADR-0006, T-37, T-48, T-49, T-59, T-60, T-74)

Decision (owner instruction 2026-10-28: build what needs no further owner decision, complete it on the orchestrator's recommendation, defer the rest into the task queue). These are defaults for LOCAL implementation against fake adapters. They are not owner decisions of substance and the owner may reverse any of them; reversing one is a small change because each is a named setting or a single code path.
1. **OPEN-F3:** a COD booking is allowed when the available balance cannot cover the shipping debit; the debit is inserted `pending` and settles with the delivered sale (ADR-0006 recommended default).
2. **OPEN-F6:** the carried courier debit of a prepaid parcel returned or cancelled in transit is netted against the next released sale of the same store, never taking `available` below zero; a four-eyes `adjustment` handles the unrecoverable remainder.
3. **No invented numbers:** where no owner-decided figure exists (retention periods, minimum payout, COD fee minimum, claim lease lengths beyond the 30-minute lease of the study, dunning timings) the value is a named platform setting with a conservative default and an Owner-console audit trail, never a literal in business code.
4. **Expand before contract:** database role and grant changes ship as the expand step only (D-9, ADR-0005 amendment). The contract step that revokes the old table-wide grants waits for the new web version to be deployed and for explicit owner approval.
5. **Live gates unchanged:** Q-17, OPEN-F7, OPEN-F8, OPEN-F9, the Mengantar write test, the Partner Secret rotation, AutoLaris sandbox evidence and ad-platform test events are not touched; every provider is a fake adapter and every live flag defaults to off.
6. **Retention setters (T-74, T-62):** `ops.jobs.manage` sets the period of a class through the audited owner-side `retention_set_period()`. The `audit_log` and `access_event` classes have NO setter until operator identity is restricted (T-59b) and the change needs four-eyes.
7. **Subscription (T-50):** stores that exist when the migration runs start a fresh 3-day trial; `finance.payout` is refused while the subscription is unpaid (BILL-7 read-only), and netting the debt against a payout is not built (recommended: allow payout requests, the debt is a separate receivable).
8. **Buyer identity (T-57):** an e-mail match accepts a first phone only when it is `bound` (`EMAIL_MATCH_REQUIRES_BOUND` = true); `buyer.resolve` runs at bulk priority.
9. **Account governance (T-63):** no invented break-glass duration maximum; the audit and access-event retention periods stay unset.

Why acceptable now: all of it is local, uncommitted unless the owner asks, and behind existing gates.
Revisit when: the owner reviews the Goal Mode report, or any item above blocks a live gate.
