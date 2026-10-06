## ADR-0001: Canonical multi-tenant commerce core

- **Status:** Proposed
- **Date:** 2026-09-17
- **Author:** Codex planning pass
- **Deciders:** Bukalaris product and architecture owners
- **Owner:** Bukalaris architecture owner
- **Supersedes:** None

## Context

Bukalaris needs independent seller storefronts now and a managed marketplace
later. Direct access to arbitrary seller databases would make isolation,
marketplace inventory, order history, audit, and future settlement inconsistent.

## Decision

Bukalaris will own a canonical multi-tenant commerce model and expose bounded
connector/import contracts for external seller systems. Shared runtime/data is
allowed only with explicit tenant scoping and database enforcement.

## Consequences

- **Positive:** one operational model for Super Admin, Seller CMS, storefront,
  marketplace projection, reporting, and provider orchestration.
- **Negative:** tenant-isolation and migration quality are release-critical;
  legacy data connectors need explicit conflict/deletion policy.
- **Neutral:** dedicated tenant storage remains an unaccepted future escape
  hatch for demonstrated isolation/commercial needs.
