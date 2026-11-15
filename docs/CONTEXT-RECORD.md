# Context Record

> This record captures engineering context and candidate applicability. It is not a legal, tax, privacy, security, audit, or certification conclusion.

## Document Control

| Field | Value |
|---|---|
| Owner | Bukalaris product owner |
| Status | Draft |
| Reviewed | 2026-09-25 |
| Depth profile | platform |
| Decision approvers | [TBD owner=Product and architecture approvers; due=before approval] |

## Context Facts

| ID | Dimension | Statement | Status | Confidence | Evidence kind | Source | Source locator | Source excerpt | Owner | Recheck trigger |
|---|---|---|---|---|---|---|---|---|---|---|
| CTX-1 | Product surface | Bukalaris is a proposed public multi-tenant commerce platform with an operator console (originally "super-admin"; the Owner console since 2026-10-27, ADR-0011), Seller CMS, tenant storefronts, and a future Bukalaris marketplace. | Proposal | High | inference | Product direction provided by Paduka Ongki on 2026-09-17. | n/a (not a direct observation) | n/a | Bukalaris product owner | Product scope, channel, or actor changes |
| CTX-2 | Market and locale | The initial target market is Indonesia; product UI and customer-facing operational content need id-ID support and IDR money handling. | Decision | High | human-policy | Product direction provided by Paduka Ongki on 2026-09-17. | n/a (not a direct observation) | n/a | Bukalaris product owner | New country, currency, or locale launch |
| CTX-3 | External integrations | The intended Indonesian provider integrations are Mengantar for shipping and AutoLaris H2H for payment instructions and reconciliation. | Decision | High | human-policy | Product direction provided by Paduka Ongki on 2026-09-17. | n/a (not a direct observation) | n/a | Bukalaris product owner | Provider contract, account model, or integration strategy changes |
| CTX-4 | Data and tenancy | Seller commerce data must be centrally modeled by Bukalaris with tenant isolation; arbitrary direct access to seller-owned databases is not an accepted integration model. | Proposal | High | inference | Architecture recommendation derived from CTX-1 and the need for a future managed marketplace. | n/a (not a direct observation) | n/a | Bukalaris architecture owner | Accepted tenancy or external seller-data decision |
| CTX-5 | Repository evidence | A Bukalaris application repository exists at `~/Projects/bukalaris` with code, append-only migrations, Vitest and Playwright suites and this documentation. M2 is complete locally; M3 Chain A has T-51, T-61 and T-70 implemented locally (uncommitted). Nothing is deployed and no live provider call has been made. The staged pack at `~/Documents/work/prd/` is no longer the only source: the repository copy is canonical. | Observed | High | direct-observation | Repository inspected on 2026-10-28 (`git log`, `pnpm lint`, `pnpm typecheck`, DB suite 232 tests, Playwright 101 passed) and recorded in `BUILD-LOG.md`. | `BUILD-LOG.md` entries dated 2026-10-07 and 2026-10-28; `git log` of `~/Projects/bukalaris` | "Results on `main` (`c1adf27` + docs): `pnpm verify` exit 0" (BUILD-LOG.md, wave 4 integration entry) | Bukalaris architecture owner | Repository path, remote or deployment status changes |
| CTX-6 | Capability decision | The context input activated capability 'persistence'; repository evidence must be confirmed before approval. | Decision | Medium | human-policy | Context-file capabilities.persistence | n/a (not a direct observation) | n/a | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-7 | Explicit specification override | The operator explicitly activated 'multi-tenant'; underlying applicability still requires repository review. | Decision | Medium | human-policy | CLI --overlay multi-tenant | n/a (not a direct observation) | n/a | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-8 | Explicit specification override | The operator explicitly activated 'public-api'; underlying applicability still requires repository review. | Decision | Medium | human-policy | CLI --overlay public-api | n/a (not a direct observation) | n/a | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-9 | Explicit specification override | The operator explicitly activated 'custom-domain'; underlying applicability still requires repository review. | Decision | Medium | human-policy | CLI --overlay custom-domain | n/a (not a direct observation) | n/a | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-10 | Explicit specification override | The operator explicitly activated 'product-ui'; underlying applicability still requires repository review. | Decision | Medium | human-policy | CLI --overlay product-ui | n/a (not a direct observation) | n/a | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-11 | Explicit specification override | The operator explicitly activated 'commerce'; underlying applicability still requires repository review. | Decision | Medium | human-policy | CLI --overlay commerce | n/a (not a direct observation) | n/a | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-12 | Explicit specification override | The operator explicitly activated 'personal-data'; underlying applicability still requires repository review. | Decision | Medium | human-policy | CLI --overlay personal-data | n/a (not a direct observation) | n/a | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-13 | Candidate jurisdiction | The operator requested engineering assessment for Indonesia. | Decision | Medium | human-policy | CLI --jurisdiction ID | n/a (not a direct observation) | n/a | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-14 | Candidate sector | The operator selected 'ecommerce' for engineering applicability review. | Decision | Medium | human-policy | CLI --sector ecommerce | n/a (not a direct observation) | n/a | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-15 | Locale contract candidate | The context input records locale 'id-ID'. | Decision | Medium | human-policy | Context-file locales[0] | n/a (not a direct observation) | n/a | Bukalaris design owner | When repository evidence or operating scope changes |
| CTX-16 | Stack and platform domains | Bukalaris uses bukalaris.com with tagline Buka toko langsung laris; the operator console (recorded as Bos at bos.bukalaris.com on 2026-09-25, since renamed the Owner console at owner.bukalaris.com, ADR-0008/ADR-0011) and Seller Admin at app.bukalaris.com use Next.js, TypeScript, shadcn/ui and Tailwind CSS. | Decision | High | human-policy | Explicit user direction on 2026-09-25, host and name updated by owner decision on 2026-10-27. | n/a (not a direct observation) | n/a | Bukalaris architecture owner | Product or stack direction changes |
| CTX-17 | Public rendering and persistence | Superseded by ADR-0008 and DECISIONS D-2 (2026-10-27/28): one Next.js application (`apps/web`) serves the Owner console, Seller Admin, storefronts and checkout through route groups; PostgreSQL/Drizzle with a shared commerce core is unchanged. The earlier recommendation of Astro for marketing and storefronts and a separate checkout app is kept only as history. | Proposal | Medium | inference | Architecture fit assessment and official Next.js/Astro documentation reviewed on 2026-09-25. | n/a (not a direct observation) | n/a | Bukalaris architecture owner | Prototype evidence or interaction complexity changes |

## Overlay and Capability Decisions

| ID | Capability/overlay | Status | Trigger facts | Selected artifacts | Owner | Reason | Review gate |
|---|---|---|---|---|---|---|---|
| OVR-1 | commerce | Active | CTX-11 | commerce, privacy, security | Bukalaris product owner | Explicit operator override | Confirm against repository evidence before approval |
| OVR-2 | custom-domain | Active | CTX-9 | custom-domain, security | Bukalaris product owner | Explicit operator override | Confirm against repository evidence before approval |
| OVR-3 | identity | Active | CTX-1 | iam, security | Bukalaris security owner | Owner console staff, sellers, buyers, affiliates, and service identities require separate authorization boundaries. | IAM approval |
| OVR-4 | localized-ui | Active | CTX-15 | localized-ui | Bukalaris product owner | Structured locale contract | Localization and accessibility acceptance |
| OVR-5 | multi-tenant | Active | CTX-7 | multi-tenant, observability, security | Bukalaris product owner | Explicit operator override | Confirm against repository evidence before approval |
| OVR-6 | persistence | Active | CTX-6 | data-model | Bukalaris product owner | Context-file decision | When the triggering facts change |
| OVR-7 | personal-data | Active | CTX-12 | privacy, security | Bukalaris product owner | Explicit operator override | Confirm against repository evidence before approval |
| OVR-8 | product-ui | Active | CTX-10 | localized-ui, ux-flows | Bukalaris product owner | Explicit operator override | Confirm against repository evidence before approval |
| OVR-9 | production-service | Active | CTX-1 | observability | Bukalaris operations owner | The platform must be observable and operable as a public commerce service. | Operations acceptance |
| OVR-10 | public-api | Active | CTX-8 | architecture, observability, public-api, security | Bukalaris product owner | Explicit operator override | Confirm against repository evidence before approval |
| OVR-11 | shared-ui | Active | CTX-1, CTX-2 | localized-ui | Bukalaris design owner | The console, Seller CMS, buyer account, and storefront need reusable accessible UI behavior. | UX and design-system acceptance |

## Artifact Selection

| Artifact | Decision | Reason | Owner | Review gate |
|---|---|---|---|---|
| brd | Not applicable for current evidence | No active trigger | Bukalaris product owner | Activate when the document-map trigger is observed |
| prd | Selected | required baseline for platform profile | Bukalaris product owner | Re-run selection when context changes |
| technical-design | Selected | platform profile implies material component boundaries | Bukalaris product owner | Re-run selection when context changes |
| architecture | Selected | platform profile implies multiple runtime or trust boundaries; active capability/overlay: public-api | Bukalaris product owner | Re-run selection when context changes |
| data-model | Selected | active capability/overlay: persistence | Bukalaris product owner | Re-run selection when context changes |
| multi-tenant | Selected | active capability/overlay: multi-tenant | Bukalaris product owner | Re-run selection when context changes |
| iam | Selected | active capability/overlay: identity | Bukalaris product owner | Re-run selection when context changes |
| custom-domain | Selected | active capability/overlay: custom-domain | Bukalaris product owner | Re-run selection when context changes |
| public-api | Selected | active capability/overlay: public-api | Bukalaris product owner | Re-run selection when context changes |
| localized-ui | Selected | active capability/overlay: shared-ui; active capability/overlay: product-ui; active capability/overlay: localized-ui; locale contract exists | Bukalaris product owner | Re-run selection when context changes |
| commerce | Selected | active capability/overlay: commerce | Bukalaris product owner | Re-run selection when context changes |
| security | Selected | active capability/overlay: identity; active capability/overlay: multi-tenant; active capability/overlay: public-api; active capability/overlay: custom-domain; active capability/overlay: commerce; active capability/overlay: personal-data; candidate jurisdiction requires applicability and control review | Bukalaris product owner | Re-run selection when context changes |
| privacy | Selected | active capability/overlay: commerce; active capability/overlay: personal-data; candidate jurisdiction requires applicability and control review | Bukalaris product owner | Re-run selection when context changes |
| high-availability | Selected | Recovery contract for commerce; no HA or SLA promise | Bukalaris operations owner | Resolve RPO/RTO before pilot |
| delivery | Selected | Maintained application delivery, migration and release proof requested | Bukalaris delivery owner | Repository and deployment baseline |
| observability | Selected | active capability/overlay: multi-tenant; active capability/overlay: public-api; active capability/overlay: production-service | Bukalaris product owner | Re-run selection when context changes |
| ux-flows | Selected | active capability/overlay: product-ui | Bukalaris product owner | Re-run selection when context changes |

## Jurisdiction Decisions

| ID | Territory | Trigger facts | Authority/source | Source status | Publication date | Effective date | Retrieved date | Decision | Qualified owner | Engineering impact | Next review |
|---|---|---|---|---|---|---|---|---|---|---|---|
| JUR-ID-1 | Indonesia | CTX-2 | Badan Pemeriksa Keuangan — official legislation database: https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022 | in-force | 2022-10-17 | 2022-10-17 | 2026-09-17 | Unknown | Bukalaris privacy owner | PRIV-*, SEC-*, LOC-* as applicable | Before applicability approval or source-status change |
| JUR-ID-2 | Indonesia | CTX-13 | Badan Pemeriksa Keuangan — official legislation database: https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022 | unknown | Unknown | Unknown | 2026-09-17 | Unknown | Bukalaris product owner | PRIV-*, SEC-*, LOC-* as applicable | Before applicability approval or source-status change |

## Sector Decisions

| ID | Sector | Trigger facts | Decision | Qualified owner | Official source/status | Next review |
|---|---|---|---|---|---|---|
| JUR-SECTOR-1 | ecommerce | CTX-1, CTX-3 | Unknown | Bukalaris product owner | Qualified sector owner must add an official source; status=unknown | Before sector applicability approval |
| JUR-SECTOR-2 | ecommerce | CTX-14 | Unknown | Bukalaris product owner | Qualified sector owner must add an official source; status=unknown | Before sector applicability approval |

## Cross-Border Transfer Records

| ID | Trigger facts | Exporter role/location | Importer role/location | Data subjects/categories | Purpose | Storage/remote access | Mechanism review | Safeguards | Onward transfers | Retention/deletion | Evidence | Owner | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| XFER-0 | None | Unknown | Unknown | Unknown | Unknown | Unknown | Not assessed | Unknown | Unknown | Unknown | Not recorded | Bukalaris product owner | Unknown |

## Locale Contracts

| ID | Locale | Fallback | Regional rules | Accessibility | Test evidence | Owner | Status |
|---|---|---|---|---|---|---|---|
| LOC-1 | id-ID | en | IDR uses integer rupiah; date, number, and address formatting must use locale-aware platform APIs. | WCAG scope is Unknown pending owner decision. | TEST-LOC-1 | Bukalaris design owner | Proposal |

## Approval Gate

- [ ] Repository and runtime facts are verified.
- [ ] Unknowns have an owner and a concrete recheck trigger.
- [ ] Active overlays have non-unknown triggering `CTX-*` facts.
- [ ] Jurisdiction and sector candidates have qualified review.
- [ ] Transfer and locale records have downstream requirements and tests.
- [ ] Selected and omitted artifacts have been reviewed.

## Development-document update — 2026-09-18

Decision: Paduka Ongki confirms three initial surfaces (Seller Admin, Storefront,
Owner console, called Super Admin at the time), external storefront API/token access, and independent Bukalaris
hosted checkout. Requirements PR-14 and PR-16 own this scope. LP/MCP and later
marketplace/account/affiliate work remain phased under the PRD.

Observed: The pack now includes proposed OpenAPI plus recovery and delivery
contracts. No application, credentials, deployment or production mutation is
established by these files. Source dates in older provider/jurisdiction records
are historical and must be reverified at their gates; this update does not
renew their factual currentness. README.md provides the document entrypoint.

## Development-document update — 2026-10-27

Decision: the platform operator surface is renamed the Owner console, formerly Super
Admin / Bos (host `owner.bukalaris.com`, ADR-0011; the interim host label `berkah` was never deployed; existing ids such as `SA-nn`, `/admin` and
`platform_operator` are not renamed). Bukalaris is an online-store platform
(Shopify-like), not a marketplace: sellers run their own stores and handle their
own taxes. Licensing and permit alignment will be adjusted later, and the startup
phase is relaxed on tax, KYC and compliance (ADR-0011, ADR-0012). The
jurisdiction and sector rows above stay Unknown and are advisor items, not
startup blockers. `logs.bukalaris.com` is reserved for the public Update Log
(ADR-0008).

## Development-document update — 2026-11-14 (D-27 to D-31)

Decision (owner, 2026-11-14; accepted as decisions, not implementation evidence):
four direction changes are recorded in DECISIONS D-27 to D-30, and D-31 accepts
the recommended defaults for their open items. The code still implements the
earlier model on fake adapters; nothing is deployed. Tasks T-102 to T-113 carry
the work. Earlier rows and sections of this record are not rewritten; the notes
below say how to read them.

| Decision | What changes | Record | Tasks |
|---|---|---|---|
| D-27 | Each store connects its own Mengantar and AutoLaris account; buyer money and COD cash go to the seller; Bukalaris holds no order money and earns the subscription only | [ADR-0013](adr/ADR-0013-seller-owned-shipping-and-payment-accounts.md) | T-104 to T-107 |
| D-28 | Platform on `bukalaris.com`; storefronts on `<store-slug>.bukalaris.id`; custom domains CNAME to `cname.bukalaris.id`; checkout on the store host | [ADR-0014](adr/ADR-0014-two-registrable-domains-and-custom-domain-target.md) | T-102, T-103 |
| D-29 | Affiliate programme run by the seller: one platform affiliate account, membership per store, commission owed and paid by the seller and recorded | [ADR-0015](adr/ADR-0015-seller-run-store-affiliate-programme.md) | T-108 to T-110 |
| D-30 | Digital products beside physical ones: prepaid only, no shipment, access links granted on payment, no file stored on the platform | [ADR-0016](adr/ADR-0016-digital-products.md) | T-111, T-112 |
| D-31 | Owner accepted the defaults for the open items of the four ADRs; seller bank transfer added (ADR-0013 section 10) | DECISIONS D-31 | T-113 |

### Status notes on context facts (rows above are unchanged)

| ID | Status note, 2026-11-14 |
|---|---|
| CTX-3 | Still Mengantar for shipping and AutoLaris for payment. The account model changed: the store's own accounts, not platform-managed ones (D-27). The platform's own AutoLaris account is used for subscription invoices only |
| CTX-5 | Repository evidence is unchanged by these decisions: they are documents only, and the code runs the platform-managed model |
| CTX-16 | `bukalaris.com` now carries platform surfaces only; native storefronts move to `bukalaris.id` (D-28). Both domains are registered per owner statement of 2026-11-14 (D-31; not checked by an agent); no DNS record exists |

### Status notes on Q-items (the table lives in 02-PRD.md)

| ID | Status note, 2026-11-14 |
|---|---|
| Q-1 | Superseded for buyer payments: they run on the store's own AutoLaris key (D-27), so a commercial platform account no longer gates a `seller_owned` store. The platform account is still needed for subscription invoices (PR-18, T-50). The payment-only profile is requested from AutoLaris by hand for each seller and confirmed per store (D-31, ADR-0013 decision 13) |
| Q-2 | Superseded by D-27 for `seller_owned` stores, the only mode in the first release (D-31): the seller's own Mengantar key replaces the Partner-provisioned account. The cashback mechanics no longer gate such a store |
| Q-8 | Partly decided by D-28 and D-31: two registrable domains, one CNAME target `cname.bukalaris.id`, custom domains as subdomains only until T-15 verifies apex support. The provider, quotas and cost stay open (T-15) |
| Q-12 | Subscription plan unchanged. Superseded part: there is no Bukalaris shipping margin, payment-fee margin, cashback share or affiliate platform fee; the subscription is the only platform revenue (D-27; D-31, former OPEN-P6 and OPEN-A3) |
| Q-17 | No longer gates a `seller_owned` store: COD cash is remitted by the provider to the seller's own account, and Bukalaris holds no seller funds (ADR-0013 section 8). It stays relevant only if a platform-held account returns |
| Other Q-items | Not changed by D-27 to D-31 |

### Status notes on OPEN items of ADR-0006 (no longer gating a `seller_owned` store)

| ID | Status note, 2026-11-14 |
|---|---|
| OPEN-F3 | Not applicable: no shipping debit is written against a seller balance for a `seller_owned` store |
| OPEN-F6 | Not applicable: no courier debit is carried in a seller ledger for a `seller_owned` store; the parcel runs on the seller's own courier account |
| OPEN-F7 | No longer a gate: the return-free restriction protected a platform ledger; COD is allowed on any courier the seller enabled for COD (ADR-0013 decision 32) |
| OPEN-F8 | No longer a gate: no reconciliation batch releases money for a `seller_owned` store |
| OPEN-F9 | No longer a gate: Partner settlement and cashback sweep are unused for a `seller_owned` store |

These five items and Q-17 are not closed as questions: they stay UNVERIFIED and
apply again to any money Bukalaris holds if a platform-held mode returns
(ADR-0013 section 8, D-31).

### Former open items decided by D-31

Each ID keeps its meaning; the decision text is in the table "Owner decisions on
the former open items (2026-11-14, D-31)" of the named ADR. Decided, not
implemented.

| IDs | Topic | Decided in |
|---|---|---|
| OPEN-P1 to OPEN-P6 | Single `seller_owned` mode, seller bank transfer, no waiting period after a key change, COD-blocked province suggestion, no per-courier province exclusion, no per-order platform charge | ADR-0013 |
| OPEN-P7 | Sandbox origins for Mengantar and AutoLaris: not an owner choice; UNVERIFIED until read from each provider's official documentation in T-105 and T-106 | ADR-0013 |
| OPEN-D1 to OPEN-D3 | Affiliate storefront host deferred with T-54/T-55; custom domains subdomain only until T-15; `bukalaris.id` registered per owner statement, no DNS record yet | ADR-0014 |
| OPEN-A1 to OPEN-A5 | Rate bounds 100 to 5000 bps, attribution window 7 days, no platform fee on commission, affiliate bank details shown only to the paying store's finance role, auto-approval off by default | ADR-0015 |
| OPEN-G1 to OPEN-G8 | Access-link caps, no platform file storage, digital products excluded from catalog feeds, no default grant expiry, no upload scanning, no licence-key pools, member-area direction, fixed embed allow-list | ADR-0016 |

### Owner answers recorded with D-31 (2026-11-14)

- The Mengantar Partner Secret pasted in chat on 2026-10-27 is not rotated; the
  owner accepts the exposure. No `seller_owned` store uses it, and the T-48 entry
  gate in the code still refuses the Partner path without rotation evidence.
- The GitHub repository stays public for now; the question is asked again before
  any production secret, customer data or deployment configuration is added.
- `bukalaris.com` and `bukalaris.id` are registered (owner statement; not checked
  by an agent). No DNS record is created until the deployment work.
- The AutoLaris payment-only profile is requested by hand from AutoLaris for each
  seller; Bukalaris automates no part of that request.
