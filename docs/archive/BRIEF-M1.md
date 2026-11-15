# Bukalaris — Milestone M1 brief (from senior reviewer)

You are the implementing developer. A senior reviewer (another Claude session)
will audit your work after each phase. Work LOCAL ONLY. Target hosting later is
a Vultr VPS running Coolify, so every runtime piece must be Docker-deployable,
but you must NOT provision, deploy, push, touch DNS, or call live providers.

## Source material
Design pack (currently canonical): ~/Documents/work/prd/bukalaris/
Read README.md, CONTEXT-RECORD.md, 02-PRD.md, 04-SYSTEM-ARCHITECTURE.md,
05-DATA-MODEL.md, 06-TENANT-ISOLATION.md, 07-IAM-RBAC-ABAC.md, TASKS.md first;
open the others only when a task needs them. Run `python3 check-spec.py`.

## Phase 0 — Repository (T-1)
- Repo root: ~/Projects/bukalaris (this folder). `git init -b main` here.
  Check `git rev-parse --show-toplevel` = this folder before any git command.
- Copy (do not move/delete) the design pack into `docs/` so the repo owns it.
  Add a short `MOVED.md` in the old folder pointing to ~/Projects/bukalaris/docs.
  From now on edit docs only inside the repo.
- Add AGENTS.md (how to run/test, rules), STATUS.md (truthful current state).
- DO NOT commit. Leave changes uncommitted; the owner approves commits.

## Phase 1 — Stack baseline (T-1, TASKS stack update 2026-09-25)
- pnpm workspace monorepo. Pin versions after checking current docs (use
  Context7 / official docs; never invent APIs).
- apps/web: Next.js (App Router) + TypeScript + Tailwind + shadcn/ui. Hosts
  Seller Admin, Super Admin and the platform-hosted /checkout for M1.
  Defer the Astro public renderer: render a minimal storefront route in Next
  for M1 and record that as a deliberate ceiling in docs (ADR or DECISIONS).
- packages/db: PostgreSQL + Drizzle schema + migrations.
- docker-compose.yml for local dev: Postgres on host port 5442 (5432/5433 are
  taken by other projects). Production Dockerfile for apps/web (standalone
  output) suitable for Coolify. .env.example only — never real secrets.

## Phase 2 — Vertical slice (PR-1..PR-3 subset)
Implement the smallest end-to-end path that proves the core invariants:
1. Tenant/store model with store-scoped data (06-TENANT-ISOLATION). Every
   store-owned query goes through a scoped data-access layer; no unscoped reads.
2. Operator auth + membership (owner/staff) — choose per 07-IAM and the auth
   decision in docs; if undecided, pick Better Auth, record an ADR.
3. Seller Admin: product + variant CRUD (price IDR integer, stock), list/detail.
4. Storefront: product list/detail for a store resolved by host/slug, cart.
5. Hosted /checkout: create order server-authoritatively (price/stock from DB,
   idempotency key, stock decrement in a transaction). Payment = manual/COD
   placeholder; Mengantar and AutoLaris are adapter interfaces with fake
   implementations only (no network calls).
6. Super Admin: list stores, suspend store (suspended store storefront 404/blocked).

## Verification (required before claiming anything)
- Vitest (or the installed runner) integration tests against the compose
  Postgres: cross-tenant read/write denial, checkout price tampering rejected,
  idempotent duplicate submit, stock never negative under concurrent checkout,
  suspended store blocked, last-owner protection.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `docker build` all pass.
- UI: run the app and capture browser evidence (Playwright) for admin product
  create, storefront → cart → checkout → confirmation at 320px and desktop.
- Update docs: TASKS.md statuses with evidence (commands + results, revision),
  04-SYSTEM-ARCHITECTURE page map with real file paths, STATUS.md, and a
  docs/DEPLOY-COOLIFY.md plan (draft, not executed).

## Working rules
- Follow ~/.claude/CLAUDE.md. Lazy senior: minimum code that holds; no
  speculative abstractions; no extra dependencies for a few lines.
- No secrets printed or written. No sudo, no global installs, no live calls,
  no deploy, no git commit/push.
- Work phase by phase. After each phase, append a short entry to
  BUILD-LOG.md (what changed, commands run, results, open issues) and print
  "PHASE <n> DONE — ready for review". Then continue to the next phase unless
  the reviewer has left notes in REVIEW.md — read REVIEW.md at the start of
  every phase and address every open item first.
- If blocked by a product decision, record it in STATUS.md, choose the safest
  reversible default, and continue.
