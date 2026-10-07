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

### Buyer personal-data inventory (implemented, T-43 / SEC-19)

Engineering inventory of every column that holds or can hold buyer personal
data, as of M2 wave 4. It is mirrored by `BUYER_DATA_INVENTORY` in
`packages/db/src/privacy.ts`; `packages/db/test/privacy.test.ts` scans the
Drizzle schema for columns named like phone/email/address/ip/user-agent/click
ids and fails when one is missing from the code inventory or from this table.
"Redaction" is the owner action on `/seller/privacy` (capability
`privacy.manage`, owners only) and the retention job in `cleanup.ts`
(`BUYER_DATA_RETENTION_DAYS`, unset = disabled). Redaction writes the fixed
placeholder `[dihapus]`, never deletes an order, and leaves amounts, lines,
statuses, courier/route and catalog snapshots intact (financial record). This
is a mechanism, not a statement of UU PDP compliance; the privacy owner decides
retention periods (Q-11) and when a request is honoured.

| Field | Table.column | Purpose | Where shown | Retention today | Redaction behaviour |
|---|---|---|---|---|---|
| Buyer name | `order.buyer_name` | delivery label, seller contact, mail salutation | Seller orders list + detail, buyer status page `/o/<token>`, order mails | indefinite | overwritten with `[dihapus]` |
| Buyer phone | `order.buyer_phone` | COD confirmation call, courier contact, repeat-buyer risk signal | Seller order detail (`tel:` link) | indefinite | overwritten with `[dihapus]`; no longer matches any risk/lookup query |
| Buyer e-mail | `order.buyer_email` | optional order notifications (T-36) | Seller order detail; mail recipient | indefinite | set to NULL |
| Shipping address | `order.shipping_address` | delivery, address-completeness risk signal | Seller order detail, buyer status page | indefinite | overwritten with `[dihapus]` |
| Meta click ids | `order_signal_context.fbp`, `order_signal_context.fbc` | match a delayed (prepaid) Purchase signal | never shown | 30 days (cleanup `purgeSignalContext`) | row deleted |
| TikTok click ids | `order_signal_context.ttclid`, `order_signal_context.ttp` | same | never shown | 30 days | row deleted |
| Google click ids | `order_signal_context.gclid`, `order_signal_context.gbraid`, `order_signal_context.wbraid` | same | never shown | 30 days | row deleted |
| UTM parameters | `order_signal_context.utm` | attribution context | never shown | 30 days | row deleted |
| Client IP, user agent | `order_signal_context.client_ip`, `order_signal_context.user_agent` | signal matching quality | never shown | 30 days | row deleted |
| Signal event user block | `signal_event.payload` (`user`: hashed phone/name, raw click ids, IP, UA) | server-side ad conversion delivery | never shown (health counts only) | `user` stripped after 30 days | `user` key removed for the order's events; value/contents stay |
| Notification recipient | `order_notification.to_email` | at-most-once mail per order/event/address | never shown | indefinite | buyer rows overwritten with `[dihapus]`; seller (owner) rows kept |
| Mail recipient | `mail_outbox.to_email` | dev-only mail sink (no provider yet) | dev outbox viewer | indefinite | buyer copies overwritten with `[dihapus]`; owner copies keep their address |
| Mail bodies | `mail_outbox.text_body`, `mail_outbox.html_body` | rendered order mail (names the buyer, lists the order) | dev outbox viewer | indefinite | body replaced by `[dihapus]`, HTML set to NULL, for every copy about the order |
| Rate-limit key | `rate_limit.key` (`order:phone:<phone>`, `order:ip:<ip>`) | checkout abuse counters (T-30) | never shown | windows swept after 1 day by cleanup | not touched (expires) |
| Status note | `order_status_history.note` | tracking number / seller reason | Seller order detail | indefinite | not touched — free text; sellers must not type buyer data into reasons |
| Stock reason | `stock_adjustment.reason` | restock/adjustment reason (`… #<order>: <reason>`) | Seller inventory | indefinite | not touched — same rule |
| Audit reason | `audit_log.reason` | redaction/export audit (`privacy.redact`, `privacy.export`) | Super Admin | indefinite | holds order ids, counts and a hashed lookup key only; never the raw phone/e-mail |
| Seller account e-mail | `user.email`, `user.email_verified` | seller/operator sign-in | Seller members, Super Admin | account lifetime | seller data, outside buyer redaction |
| Seller session IP/UA | `session.ip_address`, `session.user_agent` | Better Auth sessions | account security page | session lifetime | seller data |
| Store WhatsApp | `store.whatsapp` | storefront contact | storefront | store lifetime | seller data |
| Invitation e-mail | `store_invitation.email` | member invitation | Seller members | invitation lifetime | seller data |
| Pickup address | `store_pickup_area.address_text` | courier pickup | Seller shipping | store lifetime | seller data |

Not in the table because they hold no personal data by construction: `job.payload`
(ids only, T-32), `system_log.fields` (allowlisted keys, T-23), `cart`/`cart_line`
(no buyer fields), `order_line` (catalog snapshot and amounts).

Known gap (2026-10-07, after the wave 4 merge): the `shipment` table from T-39
(`packages/db/src/schema-fulfillment.ts`) is not yet in this table, in
`BUYER_DATA_INVENTORY`, in the export or in redaction. No column name matches
the schema scan (it stores area ids, courier, resi and amounts), but
`shipment.tracking_history` (jsonb, last 50 provider lines) and
`shipment.provider_status` / `shipment.last_error` hold provider text that may
include receiver names or address fragments, and the booking payload sent to
Mengantar carries the buyer's name, phone and address. Until it is added (owner:
privacy track follow-up), a redaction leaves shipment rows untouched; the buyer
link `/o/<token>` shows only status, resi and the timeline text.

Redaction record: each redacted order gets one `order_redaction` row (store,
order, actor, `seller`/`retention`, override flag + reason) and each batch one
`audit_log` row `privacy.redact` with the counts; both are append-only for the
app role. Orders not yet completed/cancelled are refused unless the owner
confirms an override with a reason. Exports (`/seller/privacy/export`) are
generated on request, downloaded with `Content-Disposition: attachment` and
`Cache-Control: no-store`, never stored, and audited as `privacy.export` with a
hashed key. Backups taken before a redaction still contain the data: a restore
must re-apply `order_redaction` (PRIV-4), which is not automated yet.

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
