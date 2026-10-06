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

| ID | Dimension | Statement | Status | Confidence | Evidence | Owner | Recheck trigger |
|---|---|---|---|---|---|---|---|
| CTX-1 | Product surface | Bukalaris is a proposed public multi-tenant commerce platform with a super-admin console, Seller CMS, tenant storefronts, and a future Bukalaris marketplace. | Proposal | High | Product direction provided by Paduka Ongki on 2026-09-17. | Bukalaris product owner | Product scope, channel, or actor changes |
| CTX-2 | Market and locale | The initial target market is Indonesia; product UI and customer-facing operational content need id-ID support and IDR money handling. | Decision | High | Product direction provided by Paduka Ongki on 2026-09-17. | Bukalaris product owner | New country, currency, or locale launch |
| CTX-3 | External integrations | The intended Indonesian provider integrations are Mengantar for shipping and AutoLaris H2H for payment instructions and reconciliation. | Decision | High | Product direction provided by Paduka Ongki on 2026-09-17. | Bukalaris product owner | Provider contract, account model, or integration strategy changes |
| CTX-4 | Data and tenancy | Seller commerce data must be centrally modeled by Bukalaris with tenant isolation; arbitrary direct access to seller-owned databases is not an accepted integration model. | Proposal | High | Architecture recommendation derived from CTX-1 and the need for a future managed marketplace. | Bukalaris architecture owner | Accepted tenancy or external seller-data decision |
| CTX-5 | Repository evidence | No local Bukalaris application repository has been established. This is an independent staged specification, not Bukalaris runtime evidence. | Observed | High | Local repository inventory inspected during planning; independent product direction confirmed on 2026-09-25. | Bukalaris architecture owner | Bukalaris repository path or remote is supplied |
| CTX-6 | Capability decision | The context input activated capability 'persistence'; repository evidence must be confirmed before approval. | Decision | Medium | Context-file capabilities.persistence | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-7 | Explicit specification override | The operator explicitly activated 'multi-tenant'; underlying applicability still requires repository review. | Decision | Medium | CLI --overlay multi-tenant | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-8 | Explicit specification override | The operator explicitly activated 'public-api'; underlying applicability still requires repository review. | Decision | Medium | CLI --overlay public-api | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-9 | Explicit specification override | The operator explicitly activated 'custom-domain'; underlying applicability still requires repository review. | Decision | Medium | CLI --overlay custom-domain | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-10 | Explicit specification override | The operator explicitly activated 'product-ui'; underlying applicability still requires repository review. | Decision | Medium | CLI --overlay product-ui | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-11 | Explicit specification override | The operator explicitly activated 'commerce'; underlying applicability still requires repository review. | Decision | Medium | CLI --overlay commerce | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-12 | Explicit specification override | The operator explicitly activated 'personal-data'; underlying applicability still requires repository review. | Decision | Medium | CLI --overlay personal-data | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-13 | Candidate jurisdiction | The operator requested engineering assessment for Indonesia. | Decision | Medium | CLI --jurisdiction ID | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-14 | Candidate sector | The operator selected 'ecommerce' for engineering applicability review. | Decision | Medium | CLI --sector ecommerce | Bukalaris product owner | When repository evidence or operating scope changes |
| CTX-15 | Locale contract candidate | The context input records locale 'id-ID'. | Decision | Medium | Context-file locales[0] | Bukalaris design owner | When repository evidence or operating scope changes |
| CTX-16 | Stack and platform domains | Bukalaris uses bukalaris.com with tagline Buka toko langsung laris; Bos at bos.bukalaris.com and Tenant Admin at app.bukalaris.com use Next.js, TypeScript, shadcn/ui and Tailwind CSS. | Decision | High | Explicit user direction on 2026-09-25. | Bukalaris architecture owner | Product or stack direction changes |
| CTX-17 | Public rendering and persistence | Recommend Astro for marketing and on-demand tenant storefronts, Next.js checkout, and PostgreSQL/Drizzle with a shared commerce core. No implementation or performance benchmark exists. | Proposal | Medium | Architecture fit assessment and official Next.js/Astro documentation reviewed on 2026-09-25. | Bukalaris architecture owner | Prototype evidence or interaction complexity changes |

## Overlay and Capability Decisions

| ID | Capability/overlay | Status | Trigger facts | Selected artifacts | Owner | Reason | Review gate |
|---|---|---|---|---|---|---|---|
| OVR-1 | commerce | Active | CTX-11 | commerce, privacy, security | Bukalaris product owner | Explicit operator override | Confirm against repository evidence before approval |
| OVR-2 | custom-domain | Active | CTX-9 | custom-domain, security | Bukalaris product owner | Explicit operator override | Confirm against repository evidence before approval |
| OVR-3 | identity | Active | CTX-1 | iam, security | Bukalaris security owner | Super admins, sellers, buyers, affiliates, and service identities require separate authorization boundaries. | IAM approval |
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
Super Admin), external storefront API/token access, and independent Bukalaris
hosted checkout. Requirements PR-14 and PR-16 own this scope. LP/MCP and later
marketplace/account/affiliate work remain phased under the PRD.

Observed: The pack now includes proposed OpenAPI plus recovery and delivery
contracts. No application, credentials, deployment or production mutation is
established by these files. Source dates in older provider/jurisdiction records
are historical and must be reverified at their gates; this update does not
renew their factual currentness. README.md provides the document entrypoint.
