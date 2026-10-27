# Bukalaris Privacy and Compliance Applicability

This is an engineering applicability map, not legal, tax, payment, or privacy
advice. `JUR-ID-1` is a candidate Indonesia review based on the official UU
27/2022 entry recorded in `CONTEXT-RECORD.md`. A qualified privacy/legal owner
decides applicability. Bukalaris is an online-store platform whose sellers run
their own stores; for the startup phase the applicability of UU PDP, PP 80/2019
and PSE registration stays UNVERIFIED and is an advisor item, not a startup
blocker (ADR-0011, ADR-0012). Privacy engineering controls in this document
(masking, audit, access purpose) are not relaxed.

## PRIV-1 — Data inventory before implementation

- Owner: Bukalaris privacy owner

| Data class | Purpose | Access | Status |
|---|---|---|---|
| Seller identity/contact | Onboarding, support, membership | Seller + limited platform roles | Proposed |
| Buyer contact/address | Checkout, delivery, support | Relevant store + limited platform roles | Proposed |
| Global buyer profile/identifiers/address book | Cross-seller buyer association and verified self-service | Platform-controlled; authenticated buyer only through own scope; seller cannot browse global profile | Proposed (PRIV-8, ADR-0010) |
| Order/payment references | Reconciliation, service, audit | Restricted finance/operations roles | Proposed |
| Affiliate account/contact | Platform affiliate approval and service | Own affiliate + restricted platform roles; never seller-owned | Proposed |
| Affiliate click/attribution | Referral evidence and seller-funded commission | Platform processing; affiliate aggregate outcomes only | Proposed |
| Affiliate tax/bank identity, payout and earnings statements | Bank transfer audit; optional voluntary tax identity (startup), tax gate and withholding evidence (Phase 2, PRIV-10); earnings statements | Own submission/masked view + dedicated platform finance/tax roles | Proposed |
| Diagnostics/audit | Security and operations | Restricted operators | Proposed |
| Owner console records (DATA-14: cases and notes, support actions, status history, approvals, `personal_data_access_event`, break-glass grants, verification records, operator grant history) | Support, governance, audit | Owner console staff by capability only; no seller, affiliate or buyer access | Proposed (PRIV-9) |
| Issue reports and captured context (`issue_report`, "Lapor masalah") | Platform operations, function health | `ops.issues.manage`; scrubbed text and allowlisted technical context only; **no screenshots or attachments in Phase 1 (decided)**; a Phase 2 attachment option needs the PRIV-9 purpose rules, a PII warning, caps, scrubbing, finite retention and its own capability (UX-22) | Proposed |
| Buyer identity columns (`buyer_identifier.canonical_value`, `buyer_address.recipient_name`, `buyer_address.phone_canonical`, `buyer_address.address_text`) | Identity resolution, address book | Platform services and the own buyer only; never browsed by sellers or support | Proposed (PRIV-8) |
| Affiliate storefront profile (`affiliate_storefront` presentation fields) | Public promotion page | Own affiliate edits; public when published; suspension unpublishes (IAM-13) | Proposed |
| Shipping-account consent evidence (`shipping_account_consent.email_shown`) | Evidence of the registration text shown | Seller owner and audited operator | Proposed |
| Public report reporter contact (Phase 2, SF-13) | Report follow-up | Restricted; optional; finite retention OPEN; never fetched or shown to the reported seller by default (12-SECURITY SEC-21) | Proposed |

Retention, deletion, rights request, legal basis, processor list, storage,
backup, support-access locations, and cross-border transfer status are Unknown.
They must be recorded before production data processing; absent evidence is not
permission to keep data indefinitely.

Classification rule: the inventory and the export/redaction scans are driven by
the table registry of the ADR-0005 amendment with an explicit class per column
(`email`, `name`, `phone`, `address`, `bank`, `tax_identity`, `network`,
`free_text`, or none), not by column-name heuristics, which miss
`canonical_value` and `recipient_name`. A table or column without a declared
class fails the test. `personal_data_access_event.field_class` includes `email`
and `name` (DATA-14).

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
| Audit reason | `audit_log.reason` | redaction/export audit (`privacy.redact`, `privacy.export`) | Owner console | indefinite | holds order ids, counts and a hashed lookup key only; never the raw phone/e-mail |
| Seller account e-mail | `user.email`, `user.email_verified` | seller/operator sign-in | Seller members, Owner console | account lifetime | seller data, outside buyer redaction |
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
privacy track follow-up, T-47), a redaction leaves shipment rows untouched; the buyer
link `/o/<token>` shows only status, resi and the timeline text.

Planned inventory additions (2026-10-26 specification pass):
- `shipment.tracking_history`, `shipment.provider_status`, `shipment.last_error` (T-47): export includes shipment status/timeline; redaction strips free-text provider descriptions in `tracking_history` and `last_error` to status codes + timestamps only while keeping resi, courier, and amounts intact.
- `checkout_session.{buyer_name,buyer_phone,buyer_email,shipping_address}` (PR-25, T-45): included in `BUYER_DATA_INVENTORY`, exported by phone/e-mail match, overwritten with `[dihapus]` / `NULL` on manual redaction, and automatically purged by `cleanup.ts` after 30 days.
- `payout.{bank_code,bank_account_number,bank_account_holder}` (PR-23, T-37): seller financial data (like `store_pickup_area`), retained as part of the platform financial audit record and excluded from buyer redaction.

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

- Status: Proposed (refined by owner decision 2026-10-27)
- Owner: Bukalaris privacy owner
- Source: PR-7, PR-28, PR-29; IAM-3, IAM-13; ADR-0009.
- Statement: Affiliate tracking uses a first-party opaque click reference and
  only the fields necessary to apply the approved attribution/commission policy.
  Affiliate accounts and tracking are platform-owned, not seller-owned.
  Affiliate reports expose own aggregate counts and commission amounts only,
  never buyer name, phone, email, address, payment information, order id/number,
  individual order history, raw clicks or cross-affiliate private data.
- Acceptance: An affiliate can see its own aggregate outcomes across opted-in
  stores and its own wallet/payout history without access to underlying orders.
  Buyer PII and order identifiers are absent from HTML, RSC/API responses and
  exports, not merely hidden by UI masking. A seller's own order operations
  retain their existing store scope; affiliate reporting adds no cross-store
  buyer access. Automatic buyer association under ADR-0010 grants no affiliate
  access and no buyer session; private history requires verified account binding.
- Constraints: PRIV-1, PRIV-4, PRIV-5, PRIV-6, PRIV-7, DATA-11, BILL-8.

Self-referral compares canonical buyer/affiliate phone values server-side via
the ADR-0010 buyer-identity contract (or canonical submitted order phone while
automatic identity sync is pending). It silently suppresses commission, never
rejects the order or reveals buyer/affiliate identity. Referral URLs and
handoff payloads contain no buyer profile, private order data, tax/bank details
or portal credentials. Role-based bank/phone masking occurs
in the data layer before serialization, including exports. Own wallet entries
may expose financial references to the affiliate's own payouts, but never their
underlying buyer order identifiers. Aggregate views must not provide drill-down
or raw exports that reconstruct an individual buyer/order; grouping granularity
and small-count disclosure controls require privacy-owner approval.

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
previously removed personal data is not silently reintroduced: after a restore,
reapply the grant registry and every erasure and restriction record (order
redactions, buyer erasure, click purges, tax crypto-erasure) and verify both
before service resumes (12-SECURITY SEC-23).

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
Determine notification decisions and deadlines through qualified legal review
(an advisor item, not a startup blocker);
this document sets no statutory deadline or jurisdiction conclusion. The
operational incident process lives in 14-SLA-DISASTER-RECOVERY.md.

## PRIV-6 — Affiliate tax identity and platform withholding

- Status: Proposed (refined 2026-10-27: policy-controlled, startup-phase relaxation)
- Owner: Bukalaris finance owner with qualified tax/privacy advisors
- Source: Owner decisions 2026-10-27; PR-28, PR-31, BILL-8, BILL-9, DATA-11, DATA-15, ADR-0009, ADR-0012.
- Statement: Tax identity collection and tax withholding are policy-controlled by
  `tax_setting` (DATA-15). Startup defaults: no tax identity is required for a
  payout (`tax_identity_required_for_payout` OFF), nothing is withheld
  (`withholding_enabled` OFF), and capture is voluntary, offered only when
  `identity_capture_enabled` is switched ON after the PRIV-10 notice is approved.
  The earlier owner wording (collect the applicable NPWP/KTP before the first
  payout; the platform acts as withholding agent; payout blocked until identity
  and an advisor-confirmed, versioned policy exist) is **superseded for the
  startup phase** and remains the Phase 2 behaviour that the platform owner (Owner console staff holding the tax activation capability) activates under
  the ADR-0012 criteria. Identity is never a condition of public catalog
  discovery. Sellers do not pay affiliates off-platform or obtain their tax
  identity through seller administration.
- Acceptance: With defaults, a payout without any tax identity proceeds with
  tax 0 and writes no tax computation. With `tax_identity_required_for_payout` ON,
  missing or unreviewed identity creates no payout debit or transfer. With
  withholding activated, missing identity, unconfirmed policy or policy/identity
  mismatch creates no payout debit or transfer, and every accepted payout
  preserves gross commission, taxable base, policy version/effective date,
  identity category, withholding amount and net transfer as an immutable
  `tax_computation` snapshot. Later identity, flag or policy edits cannot
  rewrite history.
- Constraints: IAM-13, PRIV-1, PRIV-4, PRIV-10, BILL-8, BILL-9, DATA-15,
  ADR-0012; tax-policy, notice and retention approval are launch gates for the
  corresponding mode, not implementation or statutory-compliance evidence.

Candidate tax treatment is UNVERIFIED against primary regulation: secondary web
summaries suggest PPh 21 for individual non-employees and PPh 23 (approximately
2%) for entities. Neither classification nor rate is an accepted computation
rule. A qualified tax advisor must confirm applicability, bases, rates,
thresholds, rounding, effective dates, proof-of-withholding requirements and
reporting/remittance responsibilities. Do not hard-code a rate, infer exemption
from missing identity, or use this document as legal advice.

Tax identity and bank fields use restricted storage and purpose-bound access;
ordinary account/profile/catalog responses carry no raw tax identifier.
Only the affiliate's own protected submission flow and separately authorized
finance/tax review can handle full values. Logs, audit reasons, analytics,
fixtures and support screens never contain raw identity documents or account
numbers. Document images are not collected unless qualified review establishes
their necessity and a separate storage/access/retention policy.

Financial, tax and payout records are distinct from buyer tracking data.
Approved statutory retention periods, legal holds, lawful basis, processor and
storage locations are OPEN/UNVERIFIED until advisor/privacy review; no duration
is asserted here. Identity correction/erasure requests restrict or redact what
is permitted while retaining only required financial evidence under PRIV-4.
Account closure and buyer redaction must not cascade-delete wallet/payout
records or silently alter tax snapshots.

Decided (D5): minimal non-KYC fraud controls on payout destinations stay
mandatory under the relaxed startup posture. In plain terms: Bukalaris manages
100% of order payments and shipping under one unified system (AutoLaris prepaid
payments and Bukalaris-generated Mengantar Partner seller accounts with platform
master account fallback; there is no seller-pasted external Mengantar key or
two-system split), so Bukalaris holds all seller and affiliate balances before
payout, and a thief who takes over a login could swap the bank account and
withdraw before the owner notices. Controls (decided, apply to all seller and
affiliate payouts): (1) the bank account holder name is compared with the
registered holder or payee name before a payout (mismatch holds it for review);
(2) a new or changed bank destination is held for **72 hours** by default
(configurable in the Owner console) with the previous contact notified; and (3)
bank changes and payout requests need fresh step-up proof (IAM-9). These use
only the bank snapshot already stored; they add no tax, licence or
identity-document data (ADR-0011 §5).

## PRIV-7 — Affiliate click retention and minimization

- Status: Proposed
- Owner: Bukalaris privacy owner
- Source: PR-7, PR-28, DATA-11, ADR-0009; PRIV-1, PRIV-4, PRIV-5.
- Statement: Before collecting production referral clicks, approve a bounded
  retention policy with a numeric raw-click duration, trigger, cleanup cadence,
  aggregate retention and legal-hold exception. Attribution-window length is a
  separate product setting, not permission to retain raw tracking forever.
  Both the attribution window and raw-click retention duration remain OPEN;
  no Tokophi/Shopify default is imported.
- Acceptance: Under an approved synthetic clock, expired raw click rows and
  browser references are purged/anonymized within the approved cadence, while
  financial attribution/ledger evidence and non-identifying aggregate counts
  remain consistent. Deleting a click does not void an earned commission or
  break payout audit. Restore procedures reapply erasure/restriction records.
- Constraints: T-52, T-53; retention/notice approval gates production click
  collection, independently of whether the code has been implemented.

Planned DATA-11 inventory (not additions already present in the implemented
buyer inventory above):

| Data class | Minimum fields / purpose | Access and lifecycle |
|---|---|---|
| Referral click | Opaque click id, affiliate/link, target store/offer, server capture/expiry timestamps, minimal first-party continuity reference | Restricted platform resolver; delete raw row under approved click retention, leave only unlinkable aggregates |
| Attribution evidence | Internal order/store/affiliate references, selected method, capture/decision time, frozen rate/base/policy and commission | Platform finance; store funding projection and affiliate aggregate projection only; detach expired raw click reference without deleting financial evidence |
| Abuse counters | Bounded operation-scoped counters, not copied buyer profiles | Existing restricted abuse controls; network/browser detail only when separately approved with its own short retention |
| Affiliate identity and bank | Contact for account/self-referral; applicable tax identity and transfer destination | Own protected operations and restricted platform review; data-layer masking; PRIV-6 retention/legal holds |
| Wallet/payout/tax snapshot | Signed amounts, reason/reference, policy version, withholding and net transfer | Own financial history without buyer order references; restricted finance/tax audit retention |

No full referrer URL/query, arbitrary page URL, raw IP, user agent or fingerprint
is required in the default click model. Any additional fraud signal requires a
documented purpose, access and finite retention approval first. A first-party
click reference is still pseudonymous tracking data, not automatically anonymous.
PRIV-5 notice/consent applicability must be resolved for referral capture and
cross-origin handoff; optional advertising pixels receive no affiliate portal,
tax, bank or raw click data.

## PRIV-8 — Global buyer profile and rights

- Status: Proposed (owner decision 2026-10-27)
- Owner: Bukalaris privacy owner with qualified legal/security review
- Source: PR-7, DATA-4, DATA-12, IAM-4, IAM-14, ADR-0010; T-57, T-58.
- Statement: Bukalaris takes controller responsibility for the platform-owned
  cross-seller buyer identity/profile, identifiers, address book and order links.
  Checkout automatically associates an order using canonical phone first,
  otherwise email, otherwise silently creates a provisional buyer. A buyer has one
  live canonical phone: a different phone/email account match goes to the phone
  buyer without automatic merge, and an email match to a buyer that already has a
  different phone creates a new buyer (ADR-0010 §4).
  This processing is not proof of possession, account authentication, optional
  marketing consent or permission to disclose stored profile/order data.
- Acceptance: Before possession proof and authorized account/link binding,
  checkout and sign-in requests reveal no stored name/address/history, existing
  account signal or cross-seller activity. The verified buyer reads only its own
  authorized global profile and confirmed order links. Seller A sees only A's
  existing order snapshots and cannot infer another seller relationship;
  affiliates never receive buyer identity/profile/history (PRIV-2).
- Constraints: PRIV-1, PRIV-2, PRIV-4, PRIV-5, IAM-14, ADR-0005, ADR-0010.
  UU PDP legal basis/notice/consent applicability is UNVERIFIED until qualified
  review; no production-compliance claim or statutory retention period is made.

### Notice, consent and account-access separation

The reviewed checkout notice must explain automatic global association, purposes,
controller/contact, seller/platform responsibilities, affected identifiers and
order links, retention, rights, and how to access the buyer portal. Determine
whether consent or another lawful basis applies through qualified UU PDP review;
the owner's zero-friction product decision does not itself establish that basis.
Optional marketing consent stays separate. If applicable law requires affirmative
consent, resolve its lawful checkout interaction before launch rather than
recording silent consent or bypassing a required notice.

`verified_at` records possession proof, not historic ownership of every order.
An observed alias is not trusted for login/recovery until separately account-bound.
A checkout using a victim phone and an attacker email must not permit that email's
magic link to reveal the victim's orders. A later holder of a recycled/shared
number does not automatically receive a prior holder's history. Shared/recycled
phone/email, disputed identifiers and historical-link confirmation need an
accepted policy before production history release; do not resolve them by
automatic account merge or unrestricted contact-based order search.

### Global rights versus store redaction

| Operation | Proposed boundary |
|---|---|
| Buyer global export | Require verified own-account/session and confirmed link access; include own profile, applicable identifiers/address book and authorized linked-order projection. No other buyer's records or raw identity-conflict counterpart IDs. Generate no-store, short-lived/download-controlled output and audit without raw contact/token payloads |
| Seller T-43 export/redaction | Retains its existing own-store scope and snapshot lookup. It cannot query/export/delete the global profile or another seller's order. A store's redaction is reflected in portal/history/export DTOs and invalidates affected caches; never reconstruct redacted snapshots from profile/address data |
| Global profile correction | Buyer-authenticated profile/address edits do not rewrite immutable per-store order contact/delivery snapshots. New trusted identifiers require fresh possession/account-binding checks; merging existing accounts requires proof of both |
| Global closure/deletion request | OPEN semantics: decide erasure/restriction of profile, identifiers, address book, links, conflict/audit records, re-registration and re-checkout behavior. Review seller financial retention/holds and processor/backup obligations. Never cascade-delete seller orders, affiliate commissions or payout evidence; never equate a store redaction with platform-wide erasure |
| Existing T-36 signed link | Remains one-order access, not global identity proof, merge consent or portal login. Current link expiry/revocation limitations stay separately visible; global deletion policy must decide their treatment |

Only the buyer may ordinarily read the global profile. Restricted platform
identity/privacy services process the minimum needed for explicit resolution,
recovery or rights operations; support/admin status alone gives no profile
browsing entitlement. Conflicts use restricted internal IDs and safe audit
metadata, not raw contact values in logs. Profile/address data is never silently
overwritten or saved from an unverified checkout.

### Retention and migration gates

Before production processing, approve finite duration/trigger/cleanup and
legal-hold rules separately for provisional accounts, observed/bound/revoked
identifiers, addresses, profile, order links, conflicts/audits, challenges,
sessions and global exports. Financial-order retention does not justify keeping
all identity/address data forever. Define processor delivery logs, storage/
cross-border locations, backup/restore reapplication and deletion receipts.
Production cleanup must respect restrictions and cannot automatically reattach
erased/revoked keys or resurrect historical data on the next checkout.

No production data exists according to the owner context; existing M2 snapshots
and synthetic fixtures are not evidence of a production backfill. T-57 must
decide whether/how to backfill, collision-review canonical phone/email forms,
preserve redaction records and leave retrospective associations unverified until
authorized proof. Do not infer ownership from an old signed link or notification
recipient. Number recycling, global deletion, minors, merge UX, channel/provider,
delivery costs/availability and authenticated prefill remain explicit OPEN gates
in ADR-0010; statutory interpretations remain UNVERIFIED.

## PRIV-9 — Owner console access to personal data

- Status: Proposed (owner decisions 2026-10-27; startup-phase relaxation applies)
- Owner: Bukalaris privacy owner with the security owner
- Source: PR-30; IAM-10, IAM-15; ADR-0011; PRIV-1, PRIV-2, PRIV-4, PRIV-8; DATA-14.
- Statement: Owner console staff reach personal data of sellers, affiliates and
  buyers only for a recorded purpose, through masked read-only projections, and
  every disclosure of a protected value is logged. This is a platform control
  and applies in the startup phase; it does not depend on the optional
  Compliance center. UU PDP 27/2022 applicability and detail remain UNVERIFIED
  and an advisor item, not a startup blocker; no statutory duty is asserted here.
- Acceptance: With synthetic accounts of every kind, (a) default account, store,
  payout and diagnostic views return masked phone/email/bank/address values in
  HTML, RSC, JSON and exports, not merely hidden by the UI; (b) a reveal request
  without an open case and a purpose code is refused with no side effect; (c) a
  granted reveal returns exactly the requested field for the requested target,
  writes one `personal_data_access_event` (actor, target, field class, purpose
  code, case, reason, expiry) in the same transaction, and a repeat read after
  expiry is masked again; (d) an operator without the reveal capability, with a
  foreign target or with an expired grant gets no value and a denial audit row;
  (e) no password, session token, recovery link, OTP, API key or raw tax
  identifier is ever rendered, returned, logged or placed in an audit reason;
  (f) free-text case notes and audit reasons are scrubbed of phone, email and
  URL shapes before storage; (g) break-glass access expires automatically,
  needs a second approver and triggers a review record (see below); (h)
  break-glass confers only allowlisted read and reveal capabilities and never
  satisfies a four-eyes approval; (i) a buyer search without an open case and a
  purpose returns no buyer hits, and the per-store breakdown of a buyer's linked
  orders is refused without them; (j) an identity with a `platform_operator` row
  is never a reveal or account-support target.
- Constraints: IAM-5, IAM-10, IAM-15, SEC-11, PRIV-2, PRIV-8, DATA-14. Numeric
  reveal window, break-glass duration, review deadline and any retention period
  are OPEN and set by the privacy owner; tests use the configured value.

### Purpose catalogue and default exposure

A **purpose code** is required on every reveal and is stored with it. Proposed
codes (a fixed list, not free text): `support_case`, `verification_review`
(optional startup flow), `fraud_or_abuse_review`, `finance_reconciliation`,
`payout_review`, `legal_request` (Phase 2 or advisor-directed), `privacy_request`
(Phase 2), `incident_response` (Phase 2), `tax_identity_review` (Phase 2) and
`tax_filing_export` (Phase 2). Each console capability maps to the
purposes it may use; a purpose outside that map is refused.

| Data class | Default in console | Reveal | Never shown |
|---|---|---|---|
| Seller team member contact | Masked email and phone; role, status, last sign-in time, MFA yes/no | Field-level reveal with `support_case` or `verification_review` | Password, session or recovery material |
| Buyer identity (ADR-0010) | Internal buyer reference, status, masked identifiers, **total** count of linked orders (no per-store breakdown: it would reveal the buyer's relationships across sellers) | Field-level reveal only with a case; the per-store breakdown of linked orders is a reveal (field class `buyer_store_links`) needing a case and a purpose; the platform identity services stay the only resolvers | Conflict-counterpart identifiers, other buyers' data, OTP/magic-link material |
| Buyer order content | Store name, order reference, status, payment state, dates, totals | Delivery address or phone of one order with `support_case`, one order at a time | Order lines of unrelated stores; payment credentials |
| Affiliate contact and bank | Masked phone, bank name and last digits | Full bank value only inside the payout processing flow that needs it (BILL-8), logged | Tax identity values outside the tax capabilities (PRIV-6, PRIV-10) |
| Store owner/business identity (optional verification record) | Status, type, reviewer, dates | Field reveal for the reviewer with `verification_review` | Document images unless a separate storage and retention policy is accepted (PRIV-6) |
| Diagnostics and audit | Allowlisted structured fields only (OBS-5) | Not revealable | Raw request bodies, payment data, tokens |

### Rules

- **Masking is a data-layer function.** DTOs are produced masked by the owning
  service before serialization; page code never masks a raw value. An export
  carries the same masking unless a four-eyes approved export names fields.
- **No bulk personal-data export** of accounts exists in the Owner console. A
  per-subject privacy export (Phase 2) needs a verified request, a second
  approver and a short-lived no-store download.
- **Search** by phone or email uses the canonical form (ADR-0010) and returns
  only masked hits and internal references; the query string is never written to
  logs or audit (a keyed fingerprint may be). Buyer-kind hits are returned only
  when the search carries an open case and a purpose code; without them the
  search returns seller and affiliate hits only and says that buyer results need
  a case and purpose, whether or not any buyer matches.
- **Break-glass** is an approved, time-boxed elevation for an incident, legal
  request or lock-out where normal grants do not suffice. A different staff
  member with the approver capability approves; it expires automatically; every
  use is an access event; all audit-capability holders are notified at grant;
  a review record is completed after expiry (deadline OPEN). A one-person team
  cannot approve its own break-glass; the fallback is OPEN. Its capability list
  is an allowlist of read and reveal capabilities only (`accounts.read`,
  `accounts.reveal`, `finance.read`, `tax.read`; enforced by a database CHECK,
  DATA-14); it never confers `staff.*`, `break_glass.*`, `audit.*`,
  `ledger.adjust` or any write capability, and an active break-glass grant never
  counts as holding a capability when approving a four-eyes action (IAM-15).
- **Scrubbing classes.** The shared text scrubber (`scrubText`: Log System, case
  notes, audit reasons, issue reports) removes URLs (query strings dropped),
  e-mail and phone shapes, bearer and token shapes, and, added by this pass, NIK
  (16 digits), NPWP (15 or 16 digits, with or without separators) and bank
  account numbers (digit runs of 8 to 20, with or without spaces or hyphens).
  Placeholders replace matches; a scrubbed field is flagged. Synthetic canaries of
  each class are part of the test (T-62, T-68).
- **Credential-bearing mail.** Support-issued recovery links and buyer magic links
  stay disabled until the `mail_outbox` fix (`CRSEC-04`, T-73) lands: real
  mailer, bodies purged after delivery, no app-role `SELECT` (12-SECURITY SEC-24).
- **Recovery and merge (decided, D6: disabled in Phase 1).** Store-ownership
  recovery and buyer merge execution by staff would change who owns a store or
  join two buyers' histories; the abuse scenario is a staff member socially
  engineered into handing a store, its payouts or a buyer's order history to the
  wrong person. Both staff-executed actions are **decided disabled in Phase 1**
  (routes return not-found). Locked-out sellers use **self-service recovery
  only** (registered email or phone OTP, MFA recovery codes) and buyers merge
  only via **self-service proof of both identifiers** (phone and email). If a
  future phase ever enables a staff-executed path, it must first record an
  evidence standard with notice to the verified contact, a cooling-off period,
  and a freeze on bank changes and payouts afterwards.
- **Issue-report attachments (decided).** Phase 1 issue reports carry no
  screenshot or attachment, so no image of revealed personal data can be stored.
  A Phase 2 option requires a PII warning, the purpose rules above (opening needs
  a purpose code, a case and an access event), byte and pixel caps checked before
  decoding, re-encoding that strips metadata, scrubbing, a finite retention
  (PRIV-4) and a dedicated capability (`ops.issues.attachments`).
- **Purpose limitation.** Data revealed for one case is not copied into another
  case, note or export; notes hold references and non-identifying facts.
- **Contractor and staff off-boarding** revokes grants and sessions in the same
  transaction; the access events remain for the retention period approved under
  PRIV-4.
- **Data subject requests** (access, correction, erasure, consent withdrawal) are
  tracked as cases in Phase 1 and by the Phase 2 privacy-request queue when the
  Compliance center is active. Response periods, erasure scope and retention
  conflicts with financial records follow PRIV-4 and PRIV-8 and are advisor
  decisions; statutory periods are UNVERIFIED and not hard-coded.
- **Incidents** involving personal data follow PRIV-5 and DR-1; the Phase 2
  register records the awareness timestamp and tracks whatever notification
  period the advisor confirms. A 3x24-hour notification duty is reported in
  secondary sources and is UNVERIFIED.

## PRIV-10 — Tax identity and tax evidence data handling

- Status: Proposed (2026-10-27; startup voluntary capture, Phase 2 dormant)
- Owner: Bukalaris privacy owner with the finance owner and qualified tax/privacy advisors
- Source: PR-31, PRIV-6, PRIV-9, BILL-9, DATA-15, ADR-0012.
- Statement: Tax identity values (NPWP/NIK, registered name), the platform's own
  taxpayer profile, earnings statements, tax evidence documents and filing
  exports are restricted data classes with purpose-bound access. In startup mode
  only voluntary affiliate identity capture and earnings statements exist; the
  evidence and filing classes are specified for Phase 2 and collect nothing until
  activation. Capture is offered only after the privacy owner approves the notice
  (OPEN-T9) and the platform owner (Owner console staff holding the tax settings capability) switches `identity_capture_enabled` ON.
- Acceptance: No log line, audit reason, analytics event, fixture, ordinary DTO,
  statement or support screen contains a full tax identifier; a payee sees only
  the last four characters of their own stored identifier and replaces rather
  than reads back a value; a full-value read or filing export cannot return data
  unless its `personal_data_access_event` row committed first (PRIV-9); a
  withdrawn, unreferenced voluntary identity is crypto-erased (sealed columns
  and fingerprint removed) and no payout, statement or invoice depends on it;
  Owner `tax.read` without a reveal grant never receives an unsealed value.
- Constraints: PRIV-1, PRIV-4, PRIV-6, PRIV-9, IAM-13, IAM-15, DATA-14, DATA-15,
  ADR-0012. Not legal advice; every legal basis, retention duration and notice
  wording below is OPEN or UNVERIFIED until the privacy owner and advisors decide.

| Data class | Phase | Minimum fields | Storage and masking | Who reads | Lifecycle |
|---|---|---|---|---|---|
| Payee tax identity | S voluntary; D reviewed | Class (individual/entity), id kind, identifier, registered name | Sealed (AES-256-GCM, AAD bound to subject, version and kind; key outside the database), keyed fingerprint for duplicate detection, last four characters for masking | Own affiliate (masked); Owner `tax.identity.review` (masked, D); full value only by PRIV-9 break-glass or the export service | Immutable versions; withdrawal erases if unreferenced; referenced versions follow the tax-record retention below |
| Seller PKP/tax profile | D only, when `pkp_gate_enabled` | PKP status, since date, evidence reference, identifier as above | Same | Own store owner (masked); Owner tax roles | Same; no seller tax KYC exists in startup mode |
| Platform taxpayer profile | D prerequisite | Legal name, entity label, NPWP, PKP status, accountant label, access-confirmation timestamps, deposit-account label | NPWP sealed; account numbers and credentials never stored (label only) | Owner `tax.read`/`tax.manage` | Versioned, confirmed rows immutable |
| Earnings statement | S | Amount totals per period from the affiliate ledger | Frozen payload and hash; PDF/CSV are renders; no identifier beyond the optional last four, no buyer, order, click or bank number | Own affiliate; Owner `tax.read` (audited export) | Financial record retention under PRIV-4; replaced, never edited |
| Tax evidence document and filing pack | D | Slip/invoice fields, computation figures, identity reference | Payload holds an identity reference, not the value; unsealing only in the export service; downloads are no-store, short-lived and hashed in `tax_export_run` | Owner `tax.documents.issue`/`tax.read` with a purpose; payee gets own slips | Statutory retention (below) |
| Ledger, remittance and evidence references | D | Amounts, billing code and receipt number as opaque text, evidence reference | No account numbers, credentials or document images stored | Owner `tax.read`, `tax.remit` | Statutory retention (below) |

### Notice for voluntary capture (startup)

Before the switch is ON the notice states: the purpose (preparing the affiliate's
own statements and readiness for a possible later tax mode, nothing else); that it
is optional and no payout, statement or access depends on it; what is stored and
how it is masked; who can see it and that every full-value access is logged;
how to withdraw; and the retention approach. Notice text, lawful-basis review and
any consent mechanics are OPEN-T9, decided by the privacy owner. If the privacy
owner prefers not to collect anything until Phase 2, `identity_capture_enabled`
stays OFF and the capture screens stay hidden with no other change.

### Access and purpose

- Two purposes are requested as additions to the PRIV-9 list (Phase 2):
  `tax_identity_review` and `tax_filing_export`. A reveal or export without one
  of them and a case is refused.
- The data-layer DTO for every role is masked before serialization; the filing
  export names its identity columns in the export template and still requires the
  purpose record, and four-eyes approval (`approval_request`) when it contains
  unsealed identifiers.
- Test fixtures use synthetic, deliberately invalid identifiers; real values never
  enter fixtures, screenshots, bug reports ("Lapor masalah" scrubs identifier
  shapes and, in Phase 1, accepts no screenshot or attachment, PRIV-9) or evidence folders.

### Retention versus erasure

Tax records and evidence may carry a statutory retention that overrides an
erasure request. The duration and the scope are UNVERIFIED and no value is
asserted here (OPEN-T18); a qualified advisor and the privacy owner must decide.
Until decided: referenced identity versions, computations, ledger rows, issued
documents and exports are retained, not erased, and the conflict is escalated to
the qualified owner under PRIV-4 rather than resolved by an engineer. Account
closure and buyer redaction never cascade into tax or statement records; a
restore reapplies erasure and restriction records; unreferenced voluntary
identities are erased on withdrawal as above.
