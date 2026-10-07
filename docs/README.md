# Bukalaris

**bukalaris.com | Buka toko langsung laris**

Development documentation for a new, independent commerce platform.

Status: Design pack owned by the Bukalaris repository (`~/Projects/bukalaris`),
copied here on 2026-10-06. Current implementation status is owned by
[`STATUS.md`](../STATUS.md), not by this README; per-task evidence lives in
[TASKS.md](TASKS.md) and implementation decisions in [DECISIONS.md](DECISIONS.md).
Owner: Bukalaris product and architecture team. Product decisions are in the
PRD; architecture proposals stay proposals until reconciled with the code.
Repository layout: `apps/web` (one Next.js app: Seller Admin `/seller`, Super
Admin `/admin`, storefront `/s/<slug>` or `<slug>.<STORE_ROOT_DOMAIN>`, hosted
`/checkout`, buyer order status `/o/<token>`, Storefront API `/api/storefront/v1`)
and `packages/db` (PostgreSQL/Drizzle schema, append-only SQL migrations, RLS
roles, store-scoped services, the outbox worker `src/worker.ts`, the maintenance
command `src/cleanup.ts`, integration tests). How to run and test:
[`AGENTS.md`](../AGENTS.md) and [`RUNBOOK.md`](RUNBOOK.md). Astro storefront
is deferred ([DECISIONS D-2](DECISIONS.md)). Nothing is deployed
([DEPLOY-COOLIFY.md](DEPLOY-COOLIFY.md) is a draft).

## Start here

The [PRD](02-PRD.md) owns product identity and scope. The
[design system](10-DESIGN-SYSTEM-WHITELABEL.md) and
[UX contracts](17-UX-FLOWS-SCREEN-CONTRACTS.md) define Bukalaris presentation
and workflows; which screens exist on `main` is recorded in the UX document's
"Implemented screens" table and in the page map.

1. Read [`STATUS.md`](../STATUS.md) for what works on `main`, then the
   [PRD](02-PRD.md) for scope and unresolved decisions (Q-*).
2. Find a page, handler or job in the
   [page map](04-SYSTEM-ARCHITECTURE.md#arch-5--canonical-system-and-page-map):
   one row per route with entry files, service functions, tables, capability,
   tests, task and status (Implemented / Pending / Planned / Retired).
3. Read its [UX contract](17-UX-FLOWS-SCREEN-CONTRACTS.md), [design boundary](10-DESIGN-SYSTEM-WHITELABEL.md),
   [data owner](05-DATA-MODEL.md), and [permissions](07-IAM-RBAC-ABAC.md).
4. Use [OpenAPI](openapi.yaml) for HTTP schemas: operations marked
   `x-implemented` exist (Storefront API v1 under `/api/storefront/v1`), the
   rest are proposals; [API notes](09-API-SPECIFICATION.md) list implemented
   versus proposed and the provider gaps. No endpoint is deployed anywhere.
5. Select the corresponding task in [TASKS.md](TASKS.md) (every task has a
   `Status:` line); per-track evidence is in `tracks/*.md`. Record real code,
   tests and runtime evidence from this repository; never infer them.

## Initial product boundary

- Seller Admin: catalog, variants/stock, content, orders, settings, two themes,
  domains, and scoped headless storefront channels.
- Storefront: responsive default theme and max-480px alternative; independently
  hosted storefronts use API and server-side tokens.
- Super Admin: tenant lifecycle, platform operations, restricted Log System.
- Hosted checkout: Bukalaris-owned /checkout and confirmation, independent of
  storefront themes/origins, with server-authoritative transaction processing.
- Later: independent mobile-first LP builder and MCP, marketplace discovery,
  buyer accounts, affiliate; settlement/payout scope requires new decisions.

## Document ownership

| Document | Owns |
|---|---|
| CONTEXT-RECORD.md / context.json | Context, applicability and staging inputs |
| 02-PRD.md | Requirements, phases, decisions and release scope |
| 03-TECHNICAL-DESIGN.md | Component flows, builder research, trade-offs |
| 04-SYSTEM-ARCHITECTURE.md | Modules, headless/checkout boundary and page/code map |
| 05-DATA-MODEL.md | Logical entities, identity, constraints and transactions |
| 06-TENANT-ISOLATION.md | Store/tenant isolation across entry points |
| 07-IAM-RBAC-ABAC.md | Roles, membership, service/channel capabilities |
| 08-DOMAIN-ROUTING.md | Native domains, external origins, checkout routing |
| 09-API-SPECIFICATION.md / openapi.yaml | API rationale/gaps and machine-readable contract |
| 10-DESIGN-SYSTEM-WHITELABEL.md | Theme, independent LP and checkout presentation |
| 11-BILLING-PAYMENTS.md | Money/provider/COD and financial policy boundary |
| 12-SECURITY-ARCHITECTURE.md | Threats, controls and security proof |
| 13-COMPLIANCE-PRIVACY.md | Data lifecycle and unresolved applicability |
| 14-SLA-DISASTER-RECOVERY.md | Reliability objectives and recovery rehearsal |
| 15-DELIVERY-MIGRATIONS.md | Delivery, migration, verification and release gates |
| 16-OBSERVABILITY-RATE-LIMITING.md | Signals, Log System and query/abuse controls |
| 17-UX-FLOWS-SCREEN-CONTRACTS.md | Initial screen workflows, states and acceptance |
| ADR-0001 through ADR-0005 | Architecture decisions (0001–0003 proposed; 0004 accepted for local M1; 0005 accepted, implemented) |
| DECISIONS.md | Implementation decisions and deliberate ceilings (D-1..D-9) |
| TASKS.md | Only execution queue; planning versus verified status |
| DEPLOY-COOLIFY.md / RUNBOOK.md | Deployment draft (unexecuted) / local operations and release gates |
| tracks/*.md | Per-track implementation reports (what changed, commands, open issues); read-only history |
| evidence/ | Playwright screenshots re-rendered by every e2e run |

## Headless integration contract

Developer registers a channel in Seller Admin → places its private token in
Cloudflare/backend secrets → uses Bukalaris catalog/cart API → requests a fresh
checkout_url → buyer navigates to platform checkout → returns to registered
store origin after a truthful outcome. Shopify Hydrogen/Oxygen is a reference
pattern, not the commerce backend or a required deployment platform.

OpenAPI is a reviewable initial contract. Auth-adapter login/recovery/invitation,
media upload, address lookup, provider callbacks/signatures, and exact financial
policies remain explicit implementation gates. Future LP/MCP APIs are not part
of the initial HTTP surface. Full development documentation does not mean all
business choices, provider contracts or runtime behavior are already verified.

## Skill ownership used in this pass

Development kit/spec suite and PRD taskbreaker organize scope; OpenAPI owns HTTP
contracts; admin-product-ux/storefront-ux/design-taste own experience direction;
application-security and testing-engineering inform security and verification;
observability-engineering owns signals; Cloudflare and headless-shopify provide
current provider/reference boundaries. Native-first/full-stack-development and
postgres-drizzle inform dependency, delivery and data invariants. Next.js, Astro
and shadcn guidance informs the selected rendering boundaries. Provider
integration contracts still require verification before implementation.

## Validation and readiness

Run structural pack validation with the installed development-spec-suite checker
and OpenAPI validation with Redocly CLI. Documentation validation is not browser,
provider, security, database or deployment proof. See the final validation record
below for this pass. Before coding: establish the repository and pinned stack, validate operator auth,
financial/provider ownership and policy, domain provisioning, and catalog
granularity. LP-specific form decisions only block the later LP milestone.

Promote this staged pack through project-init only once development is explicitly
authorized. The repository copy then owns truth; do not keep editing a rival
staged copy. Page locators become real repository links in each delivery task.

### Documentation checks executed on 2026-09-18

- `python3 check-spec.py`: PASS — 50 proposed paths / 63 operations; local
  references, operation IDs, path parameters, privileged/checkout auth boundaries
  and Markdown file links. Requires Python with PyYAML (6.0.1 used in this pass).
- Installed development-spec-suite `check-traceability.py` against this directory:
  PASS — 22 checked files, 173 declarations, 19 tasks, zero findings at validation.
- Redocly CLI `lint openapi.yaml`: PASS, one warning that API license metadata
  has not been selected. No license was invented to suppress the warning.

The executable check is documentation-only and intentionally does not claim
concurrency, database policy, browser behavior or provider acceptance. Complete
runtime proof follows 15-DELIVERY-MIGRATIONS.md after implementation.

### Documentation scan on 2026-10-07 (`docs-scan`, main at `13f388f`)

- `python3 check-spec.py`: PASS — 50 paths / 63 operations; refs, auth
  boundaries and local file links.
- `check-traceability.py docs`: PASS — files=42 declarations=218 tasks=43 findings=0.
- The page map (ARCH-5) was rebuilt from `apps/web/src/app/**` and
  `packages/db/src/*.ts`; every path and exported function named there was
  checked to exist. Runtime evidence stays with `STATUS.md`, `BUILD-LOG.md`
  and the task statuses.

### Independent product identity on 2026-09-25

Decision: Product name is Bukalaris, primary domain is `bukalaris.com`, and the
exact tagline is "Buka toko langsung laris". Product, design and UX documents
form a standalone planning pack. External project snapshots and their adoption
map have been removed. Application implementation and domain deployment remain
unverified.

Evidence, 2026-09-25: A case-insensitive content and filename scan across the
Bukalaris planning and notes directories found no previous project name.
Context JSON parses successfully, and the brand identity is present in README,
PRD and Design System. The API/local-link check passes. The four prior traceability findings are resolved by the MCP API contract,
review journey and primary task. Current check: 22 files, 182 declarations,
20 tasks, zero findings. This is specification validation, not runtime proof.

### Stack and storefront evaluation — 2026-09-25

Decision: Bos (`bos.bukalaris.com`) and Tenant Admin (`app.bukalaris.com`) use
Next.js, TypeScript, shadcn/ui and Tailwind CSS. Recommendation: Astro for the
public site and tenant storefronts, Next.js for hosted checkout, and
PostgreSQL/Drizzle for the shared core. Read the
[Astro versus Next.js evaluation](04-SYSTEM-ARCHITECTURE.md#storefront-evaluation-astro-versus-nextjs)
for the workload comparison, maintenance trade-off and executable acceptance
plan. No framework performance result or production deployment is claimed.

### Development map and Log System — 2026-09-25

Proposal: The [development function map](04-SYSTEM-ARCHITECTURE.md#development-function-map)
connects page IDs, app routes, declared API operations, core/data owners,
permissions, proof scenarios and implementation tasks. Source-file/function
locators remain pending until the application exists.

The [Log System interaction contract](17-UX-FLOWS-SCREEN-CONTRACTS.md#log-system-button-and-navigation-detail)
defines the Bos button, filters, list/detail/back behavior and failure states.
OpenAPI includes environment filtering, function/release attribution and
partial/stale source status; privileged log reads require `logs.read`.

Evidence: `python3 check-spec.py` passes for 50 paths / 63 operations, including
restricted log capability, attribution and source-state checks. The suite
traceability checker passes: 22 files, 182 declarations, 20 tasks, zero findings.
This validates the specification only; no Log System button, sink, query service
or development-map UI has been implemented or browser-tested.
