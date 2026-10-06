# Bukalaris Privacy and Compliance Applicability

This is an engineering applicability map, not legal, tax, payment, or privacy
advice. `JUR-ID-1` is a candidate Indonesia review based on the official UU
27/2022 entry recorded in `CONTEXT-RECORD.md`. A qualified privacy/legal owner
must decide applicability before launch.

## PRIV-1 — Data inventory before implementation

- Owner: Bukalaris privacy owner

| Data class | Purpose | Access | Status |
|---|---|---|---|
| Seller identity/contact | Onboarding, support, membership | Seller + limited platform roles | Proposed |
| Buyer contact/address | Checkout, delivery, support | Relevant store + limited platform roles | Proposed |
| Order/payment references | Reconciliation, service, audit | Restricted finance/operations roles | Proposed |
| Affiliate attribution | Commission eligibility later | Affiliate aggregate only; platform controls | Proposed |
| Diagnostics/audit | Security and operations | Restricted operators | Proposed |

Retention, deletion, rights request, legal basis, processor list, storage,
backup, support-access locations, and cross-border transfer status are Unknown.
They must be recorded before production data processing; absent evidence is not
permission to keep data indefinitely.

## PRIV-2 — Buyer and affiliate boundary

- Owner: Bukalaris privacy owner

Affiliate tracking uses the minimum reference necessary for a future approved
commission policy. An affiliate dashboard must not reveal buyer identity,
address, payment information, or individual order data unless a qualified owner
accepts a documented purpose and control. Buyer-account linking must be
verifiable and auditable.

## PRIV-3 — Provider and telemetry minimization

- Owner: Bukalaris privacy owner

Only data necessary for Mengantar/AutoLaris transaction processing is sent to
each provider under a reviewed contract. Telemetry receives no raw request body,
payment credential, token, or unnecessary delivery address. Provider terms and
data locations require current review before implementation.

## PRIV-4 — Data lifecycle and access requests

- Status: Proposed
- Owner: Bukalaris privacy owner
- Source: PR-2, PR-4, PR-7; PRIV-1, PRIV-2, PRIV-3.
- Statement: Before processing production personal data, approve a record for
  each class covering purpose, fields, accountable owner, lawful-basis review,
  access roles, storage/processor locations, retention trigger and duration,
  deletion/anonymization behavior, backup handling, and holds/exceptions.
- Acceptance: A verified request can be located across live data, exports,
  processors, caches, and backups without disclosing another person's records.
  Deletion and financial-record retention conflicts are escalated to the
  qualified owner rather than resolved by an engineer's legal assumption.

Store closure and buyer requests are separate workflows. Do not cascade-delete
paid orders merely because a seller account closes. Restrict stale exports and
expire download access. Restores must reapply deletion/restriction records so
previously removed personal data is not silently reintroduced.

## PRIV-5 — Analytics, notices, and incident ownership

- Status: Proposed
- Owner: Bukalaris privacy owner
- Source: PR-12, PR-13, NFR-4; PRIV-1, SEC-11.
- Statement: Keep functional checkout processing distinct from optional
  advertising/analytics disclosure. Document enabled trackers, event fields,
  destinations, retention, seller/platform responsibilities, and consent/notice
  requirements following qualified applicability review. A product content ID
  is not permission to transmit buyer identity or contact information.
- Acceptance: Where consent is required by the accepted policy, browser and
  server events honor that same state; absence/revocation suppresses optional
  disclosure. URL/query strings, logs, and ad payloads do not acquire unapproved
  order/contact data. Domain/theme/LP changes preserve the applicable policy.

Before launch, name an incident coordinator and privacy escalation contact.
Determine notification decisions and deadlines through qualified legal review;
this document sets no statutory deadline or jurisdiction conclusion. The
operational incident process lives in 14-SLA-DISASTER-RECOVERY.md.
