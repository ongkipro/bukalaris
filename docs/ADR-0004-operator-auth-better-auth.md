## ADR-0004: Operator authentication with Better Auth (M1)

- **Status:** Accepted for M1 (local); re-review before any non-local exposure
- **Date:** 2026-10-06
- **Author:** M1 implementing developer
- **Deciders:** Bukalaris architecture owner (pending confirmation)
- **Owner:** Bukalaris security owner
- **Supersedes:** None

## Context

PRD Q-6 leaves the auth provider open; IAM-6/IAM-9 require a maintained
implementation compatible with Next.js, no custom password cryptography, and a
path to invitations, recovery, session revocation and MFA. The M1 brief says to
pick Better Auth if undecided.

## Decision

Use Better Auth 1.7.7 (email + password, database sessions in PostgreSQL via
the Drizzle adapter) in `apps/web/src/lib/auth.ts`, mounted at
`/api/auth/[...all]`. Public sign-up is disabled (`disableSignUp: true`):
operator and seller accounts are provisioned by the platform. Bukalaris
authorization stays in Bukalaris tables: `platform_operator` (Super Admin) and
`membership(store_id, user_id, role)` (owner/staff); Better Auth only proves
identity. The login form posts to the HTTP endpoint so Better Auth's origin
check and sign-in rate limit apply (a Server Action calling `auth.api`
directly bypasses the rate limiter — verified in the 1.7.7 router source).
Telemetry is disabled.

## Consequences

- **Positive:** maintained hashing/session code; sessions are revocable rows;
  plugins exist for two-factor, organization and admin when needed.
- **Negative:** one cookie namespace for Seller Admin and Super Admin in M1
  (single app, DECISIONS D-2); IAM's separate admin origins are not met yet.
  No recovery, invitation, email verification or MFA flows exist in M1.
  Rate-limit storage is in memory (per process); multi-instance needs DB/Redis storage.
- **Neutral:** Better Auth's `user`/`session`/`account`/`verification` tables
  live in the same schema; user ids are text.
