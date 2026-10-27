## ADR-0012: Platform tax workflows — startup-off defaults, earnings statements and a dormant tax policy engine

- **Status:** Accepted (owner, 2026-10-28, D-21; accepted as a decision, not implementation evidence). Earlier text: Proposed (owner direction 2026-10-27, revised the same day: startup phase relaxed; not implementation evidence)
- **Date:** 2026-10-27
- **Author:** Architecture + finance planning
- **Deciders:** Paduka Ongki (product + finance owner)
- **Owner:** Bukalaris finance owner with qualified tax/privacy advisors (advisors not yet named, OPEN)
- **Related:** ADR-0005 (and amendment), ADR-0006, ADR-0008, ADR-0009, ADR-0011; PR-18, PR-28, PR-31; BILL-7, BILL-8, BILL-9; DATA-10, DATA-11, DATA-15; PRIV-6, PRIV-10; IAM-15; UX-23; T-53, T-65, T-66, T-67, T-71
- **Amends:** the tax passages of ADR-0009 (sections 2, 3, 7 and the open-decision table), BILL-8, DATA-11 and PRIV-6. They become *policy-controlled* by the settings in section 1 below. Statement of intent, not a rewrite of history: the earlier owner wording "NPWP/KTP before the first payout" and "platform withholds" remains the **Phase 2** behaviour, selected only by a recorded activation approved by a second operator holding `tax.approve` (section 5).

## Context

Two owner decisions of 2026-10-27 meet here.

1. Earlier the same day: tax on commissions and related items is handled "by us"; the platform acts as the withholding/collecting party and produces the tax workflows.
2. Later direction (this ADR's driver): Bukalaris is an **online-store platform** (Shopify-like). Each store is run by its own seller, who is responsible for their own sales taxes. Licensing and permit alignment will be adjusted later. For the startup phase the owner wants things relaxed ("kita bebaskan dulu"): no withholding, no collection, no tax gate on payouts, no PKP/e-Faktur requirement, no seller tax KYC. Affiliates handle tax on their own commission.

The relaxation must not throw away the design work. The tax workflows stay fully specified as a **dormant capability** that the platform owner activates later, after advisor confirmation, through the recorded and approved activation of section 5.

### Facts used (status matters; none is a hard-coded rule)

| # | Fact | Status | Effect on this design |
|---|---|---|---|
| F1 | DJP press release SP-23/2026 (https://www.pajak.go.id/id/siaran-pers/pemungutan-pph-pasal-22-melalui-marketplace-mulai-dilaksanakan-1-oktober-2026): under PMK 37/2025 designated marketplaces collect PPh Pasal 22 at 0.5% of gross turnover excluding PPN/PPnBM from domestic merchants from 1 Oct 2026; four operators were designated by a DJP decision of 24 Sep 2026 (Shopee, Blibli/Global Digital Niaga, Tokopedia, Lazada/Ecart); individual taxpayers with turnover up to Rp500 million per year are not collected if they submitted the required statement; the collected amount is a credit for annual tax or settlement of final tax | **VERIFIED** as the content of the official release | Bukalaris is **not** among the designated operators. Marketplace collection is **out of scope** (section 6). No code, table or flag is built for it |
| F2 | PMK 168/2023 (secondary summaries): affiliate commissions are income of a non-employee; the payer withholds using 50% of gross as the tax base times Article 17 progressive rates, without TER; evidence through e-Bupot 21/26 (form 1721-VI); deposit by the 10th and report by the 20th of the following month; no extra 20% when a valid NIK/NPWP is given; entities (badan) are subject to PPh 23 at about 2% with e-Bupot Unifikasi | **UNVERIFIED** (secondary) | Only the *shape* of the dormant engine follows from it (base fraction, bracket table, cumulative true-up, monthly masa, deadline settings). No rate, base or deadline is adopted |
| F3 | Subscription, commission and platform fees are taxable services (JKP); VAT base is the consideration (nilai penggantian); the rate comes from policy; e-Faktur for PKP counterparties and a "document equivalent to a tax invoice" for non-PKP; the platform must be PKP to collect | **UNVERIFIED** (secondary) | Shapes the Phase 2 VAT documents and the deferred T-75 readiness criteria (section 9); it does not gate the PPN toggle (owner decision). The already-decided PPN toggle (BILL-7, default OFF) is unchanged |

A qualified tax advisor must confirm F2 and F3 and everything derived from them before Phase 2. Nothing in this ADR is legal or tax advice.

## Decision

### 1. Startup defaults and one effective-dated switchboard

One append-only, effective-dated `tax_setting` series (DATA-15) holds every tax mode flag. Defaults for the startup phase:

| Flag | Default | Meaning |
|---|---|---|
| `statements_enabled` | ON | Platform produces earnings statements and invoice-register exports (section 2) |
| `identity_capture_enabled` | OFF | Affiliates may *voluntarily* submit a tax identity. Switched ON by a `tax.manage` holder once the PRIV-10 notice is approved; never required |
| `tax_identity_required_for_payout` | OFF | Earlier rule "NPWP/KTP before the FIRST payout" (ADR-0009 section 7, BILL-8, PRIV-6, T-53) is **superseded for the startup phase** and survives only as this flag |
| `withholding_enabled` | OFF | No tax is withheld from commission payouts. Payout `tax_idr = 0`, `net = gross` |
| `pkp_gate_enabled` | OFF | Dormant flag for Phase 2 e-Faktur/VAT-document requirements only; it never gates the PPN toggle. PPN stays the BILL-7 subscription toggle (default OFF, no hard PKP gate, section 9) |

Rules: a change creates a new version with an `effective_from` in the future (prospective only; payouts requested earlier keep their snapshot), a reason and the actor, and is audited. `withholding_enabled` implies `tax_identity_required_for_payout` (database CHECK) and requires an activation reference and a confirmed platform tax-entity profile. The Owner console shows these as read-mostly switches on TX-01 (UX-23); activation is the checklist in section 5, not a toggle without evidence.

### 2. What the platform provides in startup mode

- **Earnings statements** (`tax_document.kind = earnings_statement`): per affiliate and per calendar month (Asia/Jakarta) plus one annual statement, rendered as PDF and CSV from one frozen payload. They state gross commission credited, payouts (gross, tax withheld = 0 in this mode, net transferred), rejected/released payouts, adjustments, closing available balance and, as information only, the pending amount outside the wallet. They are **not** tax invoices or withholding slips and say so. They carry no buyer PII and no order identifier (PRIV-2).
- **Subscription invoice exports**: a seller's own invoice register (CSV) and an Owner platform invoice register by month, showing the stored DPP/PPN/total snapshots only (BILL-7; PPN default OFF).
- **Optional voluntary tax identity capture** (W1), sealed and masked; no review is required for anything to proceed.
- **No** withholding, remittance, tax ledger, slips, filing pack or period close runs in startup mode.

### 3. The dormant tax policy engine (Phase 2, fully specified)

All of the following is specified in BILL-9 (workflows W1 to W12) and DATA-15, built in two steps and activated only through section 5:

1. **Policy engine** (T-65, the tax foundation, builds the pure function, the `tax_policy_version` table and the payout hook, and lands before T-50 and T-53; no policy rows exist in startup mode except an optional owner-confirmed `vat_output` version feeding the PPN toggle): versioned, effective-dated, advisor-confirmed policies; no rate anywhere in code or seeds; integer-IDR arithmetic with one final rounding.
2. **Liability machinery** (T-67, deferred): withheld-tax liability ledger by tax period, remittance batches with opaque payment evidence, tax evidence documents, monthly filing pack, reconciliation and period close.

Two tax types exist in this ADR: `commission_withholding` (categories `individual`, `entity`) and `vat_output` (category = revenue line: `subscription`, `cod_fee`; any other line needs an ADR amendment and stays unclassified until then, BILL-9 W8). The COD handling fee's VAT (ADR-0006 decision 2) is read from a `vat_output` version for `cod_fee` and is `0` while no effective confirmed version exists. Adding a type needs an ADR amendment. Type labels such as a form name are free text on the policy, flagged UNVERIFIED until the advisor confirms.

### 4. One tax model (reconciles ADR-0009/DATA-11 with this ADR)

ADR-0009 section 2 and DATA-11 named `affiliate_tax_identity` and `tax_policy`, and put gross/tax/net and `tax_policy_id` on `affiliate_payout`. That would have made two tax models. Cutover:

- `affiliate_tax_identity` is replaced by `tax_identity` (DATA-15, `subject_kind = affiliate`; sellers only in Phase 2).
- `tax_policy` is replaced by `tax_policy_version` (DATA-15).
- `affiliate_payout` keeps `gross_idr`, `tax_idr`, `net_idr` and its bank snapshot, adds `tax_setting_version_id` (always) and `tax_computation_id` (set only when withholding applied). A composite foreign key makes the payout's amounts equal the computation's, so they cannot diverge; with no computation `tax_idr = 0 AND net_idr = gross_idr` by CHECK.
- The authoritative snapshot is `tax_computation`. DATA-11 is edited accordingly; the ADR-0009 text is amended to point here.

### 5. Activation criteria for Phase 2 (all required, recorded in the setting version)

1. Owner decision reference recorded (`activation_ref`).
2. Platform tax-entity profile confirmed: legal entity type, NPWP (sealed), PKP status/date. All OPEN, supplied by the owner.
3. A named tax advisor and an accountant; for each policy version, an advisor confirmation reference. Policy versions of type `commission_withholding` may not use owner-decision confirmation.
4. e-Bupot / e-Faktur access evidence (timestamps recorded by a `tax.manage` holder; no credentials stored) and a deposit-account label for remittances (no account number stored).
5. T-67 accepted with its Vitest, real-PostgreSQL and Playwright evidence exercised (ledger, remittance, documents, filing pack, close).
6. PRIV-10 notice and retention approved; payee notice period before the first withholding defined by the owner (length OPEN).
7. A withholding preview (TX-05) run over the last months of statement data, without writes, and reviewed by the accountant.
8. `effective_from` strictly in the future; first withholding applies only to payouts requested after it.

### 6. Not in scope

**Marketplace collection (PMK 37/2025)**: the platform is not a designated marketplace collector (F1: four named operators, not Bukalaris). Revisit only if the tax authority designates Bukalaris or licensing/permit alignment changes the platform's classification; that would need a new ADR. Workflow id W9 is intentionally retired; no hook, flag, turnover-statement or SKB capture is built. Seller sales taxes (goods PPN included/added in `order_financials`, income tax of the seller) remain the seller's responsibility and unchanged (BILL-4).

### 7. State machines (summary; detail in BILL-9)

| Aggregate | Transitions |
|---|---|
| `tax_setting` | append-only versions; current = latest with `effective_from <= now()`; no update, no delete |
| `tax_identity` | `submitted -> in_review -> approved` or `rejected`; `approved -> superseded` or `revoked`; `submitted -> withdrawn` (payee). One `approved` per subject. Startup mode uses `submitted`/`withdrawn`/`superseded` only |
| `tax_policy_version` | `draft -> submitted -> confirmed` or `rejected`; `confirmed -> retired`. "Active" is derived from `confirmed` plus effective range, never stored. A confirmed version is immutable; rollback is a new version |
| `tax_computation` | `computed -> recognized`; `computed -> void`; corrections are new rows (`kind = correction`) |
| `tax_document` | `issued -> replaced` or `cancelled`; payload immutable |
| `tax_period` (T-67) | `open -> closed`; `closed -> open` only by audited four-eyes reopen with `revision + 1` |
| `tax_remittance` (T-67) | `draft -> approved -> paid`; `draft` or `approved -> void`; `paid -> void` only by a reversal entry |

Each aggregate has one transition service; same-state events are no-ops; rejected/stale transitions return a recorded outcome (the ADR-0006/0009 rule).

### 8. Authorization and data placement

- Capabilities (IAM-15 lists them, dormant ones hidden in startup mode): `tax.read`, `tax.manage`, `tax.approve`, `tax.remit`, `tax.documents.issue`, `tax.identity.review`, `tax.period.close`; full-value identity reveal only through the PRIV-9 break-glass. `payouts.process` never implies any `tax.*` capability.
- All tax tables are platform-owned (T-59 class `platform`), not seller tenant tables. `bukalaris_app` receives only own-subject payee access through `app.affiliate_id` RLS on `tax_identity` (safe columns; sealed columns are not granted) and `tax_document` (own statements); no seller or store context reads tax tables. Writes go through named platform functions with per-table, per-operation grants (the ADR-0005 amendment); no DELETE grant exists on any tax table.
- Sealed identity values use the existing sealed-token pattern (AES-256-GCM, subject/version-bound AAD, runtime key custody; key never in the database). Keys are purpose-separated: identity sealing uses its own keyring (`tax_identity`) with a `key_id` stored beside every sealed value (rotation by re-seal, never a data-losing key change), and the duplicate-detection fingerprint uses a distinct HMAC key (`identity_fingerprint`), never the same secret as sealing or sessions. Masking is applied in the data layer on every DTO and export (PRIV-10).

### 9. PPN switch and activation readiness (owner decision 2026-10-27, closes OPEN-T19)

- PPN stays OFF by default. The Owner console switches it ON with the `tax.manage` capability (IAM-15; not four-eyes) through a confirmation dialog stating that legal and tax documents and PKP status are the Owner's responsibility, plus a reason and an audit entry. There is **no hard PKP gate**.
- The rate is a policy value entered, with an effective date, when PPN is switched ON (a `vat_output` version for the `subscription` line, owner-decision basis, shown as "not advisor-confirmed"). It is never a constant or default in code or seeds, and **no 11% (or any other) VAT computation exists in the startup phase** while PPN is OFF. The switch affects only NEW invoices. The same mechanism supplies the `cod_fee` line's VAT (ADR-0006), which is 0 while PPN is OFF.
- The company (PT) legal documents are not yet issued, so tax-invoice and e-Faktur readiness is deferred to the future task T-75 "PPN activation readiness". Entry criteria: PT legal documents issued, PKP status confirmed, an accountant named, an invoice/e-Faktur export built and verified, and the rate policy confirmed by the accountant or advisor (OPEN-T20).

## Alternatives considered

- **Treat Bukalaris as a marketplace collector now:** rejected. Not designated (F1); the owner direction is online-store platform. Revisit under section 6.
- **Delete the tax design for startup:** rejected by the owner; the work is kept dormant with explicit activation criteria.
- **Hard-code rates or deadlines as defaults:** rejected. Every figure comes from an effective-dated, advisor-confirmed policy; documentation examples are labelled illustrative.
- **Mutable per-payee cumulative counters for the progressive base:** rejected; year-to-date values are derived from snapshots under the per-affiliate lock (BILL-9 W3).
- **A separate tax model per workflow (payout tax vs VAT):** rejected; one policy table, one computation table, one ledger (T-67).
- **Withholding recognised at commission credit instead of payout paid:** not chosen; recognition event is a policy field limited to values the advisor confirms (OPEN-T13).

## Consequences

- **Positive:** the startup phase ships transparent statements without tax risk or onboarding friction; the later switch is a configuration and acceptance exercise, not a redesign; one tax model; replay-safe, append-only ledger parity with ADR-0006/0009.
- **Negative:** some Phase 2 structure (policy table, computation table, payout hook) ships in startup and stays unused until activation; the statement wording needs owner/advisor approval; Phase 2 depends on facts the owner has not yet supplied (below).
- **Neutral:** affiliates and sellers are responsible for their own tax in startup mode; the platform gives them records, not tax determinations.

## Confirmation

T-65 (tax foundation), T-71 (earnings statements, seller invoice register and Owner invoice register), T-66 (screens) and T-67 (dormant withholding and liability machinery, deferred) define independently executable slices and future evidence, not checks already run. Use Vitest for the pure engine with advisor-style fixture policies (arbitrary test numbers, never asserting statutory rates), integer arithmetic boundaries, rounding modes and replay determinism; real-PostgreSQL integration for partial unique indexes, the exclusion constraint on policy ranges, append-only privileges, column-level grants, RLS context failures and the payout composite foreign key; Playwright for the statement download, the settings off-state, and (T-67) the full tax center journey including cross-role masking. No build, test or production write was performed for this ADR.

## Open decisions and entry gates

| ID | OPEN item | Owner / gate |
|---|---|---|
| OPEN-T1 | Platform legal entity type | Owner, before activation |
| OPEN-T2 | Platform NPWP | Owner, before activation |
| OPEN-T3 | Platform PKP status and date | Owner + advisor, before `pkp_gate_enabled` (Phase 2 document requirements) and T-75 |
| OPEN-T4 | Named tax advisor and accountant | Owner, before activation |
| OPEN-T5 | e-Bupot and e-Faktur access (evidence only, no credentials) | Owner, before activation |
| OPEN-T6 | Deposit procedure: bank account(s) and billing-code process for tax deposits | Owner + accountant, before activation |
| OPEN-T7 | Designation expectation: whether the owner plans to seek or expects marketplace designation (not assumed; Bukalaris not designated per F1) | Owner; only revisited under section 6 |
| OPEN-T8 | Whether and when to activate withholding (Phase 2) and the payee notice period | Owner |
| OPEN-T9 | Notice text for voluntary identity capture and statements; `identity_capture_enabled` switch-on | Privacy owner + owner |
| OPEN-T10 | Earnings statement disclaimer wording and generation timing after month end | Owner + advisor |
| OPEN-T11 | Withholding party named on evidence (platform as payer vs seller as principal with platform as paying agent) | Advisor, before activation |
| OPEN-T12 | Platform fee on commission and its effect on the tax base | Owner + advisor (also PR-28/BILL-8) |
| OPEN-T13 | Recognition event and period for each tax type (payout paid vs other) | Advisor, per policy version |
| OPEN-T14 | Deadline holiday shifts and e-Bupot import format | Advisor/accountant |
| OPEN-T15 | Treatment of returns/chargebacks/fraud clawbacks after withholding | Advisor, per policy version |
| OPEN-T16 | Tax treatment of shipping margin, payment-fee margin, COD fee and its VAT component already snapshotted in DATA-7 (policy-derived, `0` while no effective `cod_fee` version exists), cashback share, affiliate platform fee | Advisor; not decided here (BILL-9 W8) |
| OPEN-T17 | Subscription refund policy (needed before credit notes) | Owner (BILL-7) |
| OPEN-T18 | Statutory retention period for tax records (UNVERIFIED; no duration asserted) | Advisor + privacy owner (PRIV-10) |
| OPEN-T20 | PPN activation readiness (T-75) entry criteria met: PT legal documents, PKP status, accountant, invoice/e-Faktur export, rate policy confirmed | Owner + accountant, before T-75 starts; the PPN switch itself needs none of them (section 9) |

## More information

- [BILL-9 — Platform tax workflows](11-BILLING-PAYMENTS.md#bill-9--platform-tax-workflows)
- [DATA-15 — Tax domain](05-DATA-MODEL.md#data-15--tax-domain)
- [PRIV-6 and PRIV-10](13-COMPLIANCE-PRIVACY.md#priv-6--affiliate-tax-identity-and-platform-withholding)
- [ADR-0009 — Platform-owned affiliate programme](ADR-0009-platform-owned-affiliate-programme.md)
- [ADR-0005 — Tenant isolation and RLS (amendment)](ADR-0005-database-tenant-isolation-rls.md)

## Change history

- 2026-10-27 documentation audit pass: audit FIN-09 (COD-fee VAT from policy), FIN-25, TRC-18 (named capabilities instead of "an Owner activates") and OPS-04 data part (purpose-separated keys with `key_id`) applied here. Owner decision of the same day: PPN has no hard PKP gate (section 9, OPEN-T19 closed, OPEN-T20 added).
