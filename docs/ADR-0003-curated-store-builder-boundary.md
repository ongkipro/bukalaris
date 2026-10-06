## ADR-0003: Curated seller content and builder boundary

- **Status:** Proposed
- **Date:** 2026-09-17
- **Author:** Codex planning pass
- **Deciders:** Bukalaris product and design owners
- **Owner:** Bukalaris product owner
- **Supersedes:** None

## Context

Sellers need familiar CMS and navigation control. Free-form theme code and
checkout editing increase security, accessibility, rendering, and conversion
risk before the platform has a verified implementation base.

## Decision

Phase 1 provides catalog, CMS pages, menus, store settings, and approved brand
tokens. Update from Paduka Ongki on 2026-09-18: future landing pages have
independent, freely composable layouts and styling; predefined sections are
optional starting points. The planned lock concerns the platform form, with
its exact customization boundary to be specified in T-11. Backend checkout
validation remains platform controlled. This replaces the earlier proposal
that curated sections define the ceiling of landing-page design.

## Consequences

- **Positive:** fast seller autonomy without an open plugin/theme surface.
- **Negative:** broader layout freedom requires stronger responsive editing
  and rendering verification.
- **Neutral:** component compatibility and protected form contracts are platform work.
