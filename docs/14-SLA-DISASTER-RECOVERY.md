# Bukalaris Reliability and Recovery

Status: Decision (owner D-19, 2026-10-27) for the startup baseline below; the
scripts and rehearsals that prove it are not yet run on production data. Scope:
every surface of the one Next.js application (Owner console,
Seller Admin, storefronts, hosted checkout and the planned Affiliate, Buyer and
Update Log surfaces, ADR-0008) plus the worker and cleanup processes. Owner:
Bukalaris operations owner. Source: PR-14, PR-16, NFR-2, NFR-5, D-19. The
availability and recovery numbers are internal operating targets (99.5 %
availability, RPO 1 hour, RTO 4 hours); no SLA is promised to sellers unless the
owner publishes one.

## DR-1 — Recovery objectives and proof
- Owner: Bukalaris operations owner
- Statement: Define RPO/RTO, backup retention, restoration authority, and payment
  reconciliation window before pilot. Under owner decision D8 / D-19 (2026-10-27),
  Option B with client-side encryption is the **decided startup baseline**
  (adjustable by the Owner as traffic and revenue grow).
- Acceptance: Restore a backup to an isolated environment, prove tenant and order
  consistency, and reconcile pending provider outcomes without resubmitting money.
  A backup file or provider badge alone is not restore evidence.
- **Decided startup baseline (owner decision D8 / D-19, 2026-10-27):** Option B
  with client-side encryption, **99.5 % availability target** (~3.6 hours/month
  budget), **RPO 1 hour** (hourly `pg_dump -Fc`), **RTO 4 hours** proven by
  `scripts/db-restore-rehearsal.sh` before pilot, and **client-side encrypted
  offsite dumps** to Cloudflare R2 before live customer or bank data is stored.
  The comparison below is retained so the Owner can scale to Option C/D/E when
  volume justifies the cost.

  **The four questions**

  1. **Availability: how much of the month may the application be unreachable?**
     Per 30-day month, 99 % allows about 7.2 hours of downtime, **99.5 % about 3.6
     hours**, **99.9 % about 43 minutes** and 99.95 % about 22 minutes. Planned
     deploys count unless they are zero-downtime. A single server cannot honestly
     promise more than about 99.5 %, because a host reboot, a provider incident or a
     bad release already uses most of that budget.
  2. **RPO (recovery point objective): after a failure, how much recent data may be
     lost?** With a database dump every 6 hours (the current plan), a failure just
     before the next dump loses up to **6 hours of everything written**: orders,
     payments recorded, payout requests, bank-transfer evidence. Lost orders can be
     rebuilt from provider and bank evidence, but only by hand and with risk of a
     wrong or doubled payout, which is why every restore freezes payouts first (restore
     rules below). Options: hourly dumps (up to 1 hour lost), or continuous
     write-ahead-log (WAL) archiving to the offsite bucket (typically minutes lost,
     with restore to a chosen minute).
  3. **RTO (recovery time objective): how long until the service is back?** It is the
     time to provision a replacement host, restore the dump, check isolation and
     reconcile money. The only honest number is the measured duration of the restore
     rehearsal on the target database; until it has been run on real data volume the
     figure is a guess. Money reconciliation after the restore can take longer than
     the technical restore and is not counted inside the target.
  4. **Encrypted offsite copies: why?** The offsite bucket holds every seller and
     buyer record, including bank account numbers and buyer phone numbers. If an
     access key leaks or the provider account is compromised, an unencrypted dump
     exposes all of it. Encrypting each dump on our server before upload (client-side)
     means the bucket holds unreadable files. The cost is key handling: the
     encryption key must be stored separately from the server, be backed up, and be
     rehearsed, because a lost key makes every encrypted backup useless.

  **Options and trade-offs**

  | Option | Availability | Data lost (RPO) | Time back (RTO) | Operations load | Money cost (relative, UNVERIFIED) |
  |---|---|---|---|---|---|
  | A. Single server, dumps every 6 h, offsite daily or hourly | about 99.5 % | up to 6 h | hours (manual rebuild) | lowest: the current scripts | lowest |
  | B. As A, with hourly dumps | about 99.5 % | up to 1 h | hours | low: one schedule change, more storage | slightly above A |
  | C. As B plus WAL archiving to the offsite bucket | about 99.5 % | minutes | hours, restore to a chosen minute | medium: a new component to monitor and rehearse | storage plus some operator time |
  | D. As C plus a standby database on a second server (replica, manual or automatic switch-over) | 99.9 % is plausible | seconds to minutes | minutes to tens of minutes | highest: replication health, switch-over drills, split-brain risk | roughly one more server of the same size, plus the monitoring time |
  | E. Two web replicas behind the proxy | removes web downtime on deploys and host faults | not applicable (no data) | minutes | medium; needs shared media storage first (media is local disk today) | one more web server plus object storage |

  Offsite encryption (question 4) applies to every option and is recommended in all of them.

  **Decided startup baseline (D-19): option B with
  client-side encryption, availability target 99.5 %, RPO 1 hour, RTO 4 hours, and a
  restore rehearsal recorded before the pilot.** Reasons: it is inexpensive and uses
  tools that already exist; an hour of lost orders can be reconstructed from
  provider and bank evidence; and a standby (option D) adds operational risk that a
  small team may not be able to run safely. Revisit option C or D when real volume
  or a real incident shows the cost of losing an hour. The baseline is decided
  (D-19) and the Owner may change it; the 6-hour interval in the current script text
  is the starting state and must become hourly to meet the RPO.
  Capacity note: one web replica serves every host while media lives on local disk;
  option E waits for object-storage media (DEPLOY-COOLIFY).

| Incident | First containment | Recovery proof |
|---|---|---|
| Database unavailable | Stop mutations; show truthful unavailable/pending state | Restore connection and invariants; reconcile pending work |
| Incorrect release | Stop rollout; revert compatible application artifact | Critical buyer/operator journeys on known revision |
| Data corruption | Freeze affected writes; preserve evidence and recovery point | Isolated restore and business consistency checks before cutover |
| Payment provider outage | Keep pending instruction/outcome; bounded retry | Account-approved settlement reconciliation without duplicates |
| Domain/TLS failure | Keep valid routing; expose status and platform-origin fallback links | Ownership/TLS/readiness and cross-tenant routing checks |
| Log sink unavailable | Preserve commerce; bounded diagnostic failure | Sink resumes and synthetic correlation appears |
| Credential exposure | Revoke/replace scoped grant; rotate through the key ring (DEPLOY-COOLIFY), contain affected capability | Old credential rejected; authorized path restored; sealed credentials re-sealed under the new key id (JOB-23) |
| Restore to an earlier point | Freeze payout, billing and provider-write jobs; no seller or affiliate payout is marked paid until step 3 of the restore rules | Bank and provider evidence reconciled against the restored ledger before unfreezing |
| Secret or sealing-key loss | Stop the provider calls that need the lost key; restore the key set from the secret backup | Every sealed credential decrypts under its key id, or the affected sellers re-enter their keys; shipping resumes after reconciliation |
| Host replaced (new egress IP) | Partner calls come from the new IP and are refused until the provider's allow-list lists it; keep the old IP or have the new one allowed before cutover | A bounded read-only partner call succeeds from the new IP (egress IP recorded in DEPLOY-COOLIFY) |

## DR-2 — User-journey reliability
- Owner: Bukalaris operations owner
- Statement: Measure seller publication, catalog availability, cart/checkout
  completion, provider pending age, and privileged operator access separately.
- Acceptance: Each released journey has a defined good event, eligible population,
  latency/freshness window, source, owner, and actionable failure procedure.
  Numeric targets and alert thresholds require traffic/capacity evidence.

Operators must distinguish expected buyer validation from outages and provider
pending from failure. Alerts route to a named role with safe triage steps,
rollback/mitigation boundary, escalation and recovery checks. Do not page for
unactionable metrics. Customer notification policy and incident severity ownership
must be selected before live operation; no legal notification deadline is assumed.

Recovery rehearsal records environment, code/schema revision, backup timestamp,
steps, observed duration/loss, integrity queries, provider reconciliation results,
and limitations. Production restore and destructive rollback need explicit action
authorization. Never restore production personal data into an unsecured test env.

### Backup, restore rules and probe baseline (adopted from Etalashop, 2026-10-26; corrected 2026-10-27)

1. **Two-tier PostgreSQL backup (on-box + Cloudflare R2 offsite):**
   - On-box: `scripts/db-backup.sh` (`pg_dump -Fc`, **owners and ACLs kept**: the grants to `bukalaris_app` and `bukalaris_platform` and the `bukalaris_owner` ownership are part of tenant isolation, ADR-0005) currently every 6 hours into a local volume with 14-day retention (the D-19 baseline requires hourly dumps for RPO 1 hour). A dump taken with `--no-owner --no-acl` is not acceptable for this database: it restores without grants.
   - Offsite: a dedicated `backup-offsite` job mirrors custom-format dumps hourly via `rclone` to a dedicated Cloudflare R2 bucket (30-day remote retention). **Decided (D8 / D-19):** encrypt each dump on the host before upload with a key held outside the server and backed up separately (client-side), because the bucket otherwise holds personal data in the clear; this must be in place before live customer or bank data is stored. Roles are cluster-level and are not in the dump; they are created from the role SQL in DEPLOY-COOLIFY before any restore.
   - Offsite backup is considered verified only after an isolated restore from R2 passes every check in the restore rules below.
2. **Restore rules (every restore, rehearsal or real):**
   1. Restore with owners and ACLs, into a database owned by `bukalaris_owner`, on a cluster where the roles already exist (including any NOLOGIN roles added by T-59).
   2. Reapply and verify isolation: the grant registry of T-59 (role grants, function `EXECUTE` grants, table owners, row-level policies) matches the registry, and the app role still sees nothing without a store context. Reapply every erasure and restriction record that postdates the dump: `order_redaction` replay (PRIV-4), buyer erasure, click purges and tax crypto-erasure. Erased key material or content must not come back.
   3. Freeze before unfreezing: after any restore to a point before the present, keep payout, billing and provider-write jobs frozen. Reconcile every `requested`, `processing` and `paid` payout (seller and affiliate), subscription invoice and refund against bank and provider evidence; a payout that shows `requested` but whose transfer happened must not be paid again. Only then unfreeze.
   4. The rehearsal (`scripts/db-restore-rehearsal.sh`) records: row counts, `rls_ok=yes`, orphan check, **grants asserted per role** (expected grant list for each of the three roles and the NOLOGIN roles equals the registry), erasure replay counts (records replayed equals records expected) and a count per table class of the registry (platform-owned tables included, not only store-owned ones). T-59 extends the script and the `verify:docker` policy count together with the role SQL.
3. **Secrets and keys backup:** secrets live only in the secret store. Keep an offline encrypted copy of the three database passwords, every key id still referenced by a sealed credential (`INTEGRATION_TOKEN_KEY` key ring and its purpose-separated siblings), the per-surface session secrets, the Mengantar partner and webhook secrets and the backup encryption key. Two named people hold the access, and the copy is rehearsed: restore a dump on a clean host with only that set and confirm that one sealed credential decrypts. Losing a sealing key without a copy makes the sealed credentials of that key id unrecoverable; sellers and the platform then re-enter them.
4. **Off-box HTTP readiness and smoke probe (`scripts/bukalaris-probe.sh`):**
   - Until T-70 (path mode, one host): `/api/health` (200), `/api/ready` (200, DB + roles ready), `/login` (200), `/admin` (redirects unauthenticated/non-MFA to login) and a known demo store `/s/<slug>` (200).
   - After T-70 (host mode) the probe is host-aware and is the one defined by OBS-6 in 16-OBSERVABILITY-RATE-LIMITING: `/` on the apex, `/login` on the Owner console, Seller Admin, Affiliate and Buyer hosts, `/` on the Update Log host and on a sample storefront, `/api/health` and `/api/ready` on every routed host, an assertion that `/checkout` and a foreign-surface prefix (and `/admin` on the apex) are 404 on the Owner console, Seller Admin and apex hosts (the retirement rule, 08 DOM-5), and the TLS expiry of every host certificate including the `*.affiliate` one. Post-deploy verification must run this probe before a release is marked verified.
