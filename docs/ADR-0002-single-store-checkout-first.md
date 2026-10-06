## ADR-0002: Single-store checkout first

- **Status:** Proposed
- **Date:** 2026-09-17
- **Author:** Codex planning pass
- **Deciders:** Bukalaris product and finance owners
- **Owner:** Bukalaris finance owner
- **Supersedes:** None

## Context

Bukalaris wants a marketplace but the initial build prioritizes seller CMS and
storefront. Multi-seller checkout requires allocation, settlement, payout,
refund, COD, shipping, tax, and support rules not yet accepted.

## Decision

Every Phase 1 cart, checkout, and order belongs to exactly one store. The
marketplace begins as a curated discovery/listing channel, not a combined cart.

## Consequences

- **Positive:** clear tenant/order ownership; faster safe integration with
  payment and shipping providers.
- **Negative:** buyer cannot combine sellers in one payment.
- **Neutral:** the model keeps a parent marketplace-order seam for a later,
  explicitly financed decision.
