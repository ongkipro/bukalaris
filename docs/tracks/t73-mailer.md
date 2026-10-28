# T-73 — Real mailer delivery and `mail_outbox` hardening — track report `t73`

Local, uncommitted, isolated worktree on top of the wave 1 overlay (D-20, D-21, D-22). No provider was called and none was chosen: provider, sender domain and SPF/DKIM/DMARC evidence stay OPEN under Q-16.

## What changed

| File | Change |
|---|---|
| `packages/db/src/platform/mail-transport.ts` (new) | `MailTransport` (provider-agnostic: SMTP or HTTP lives behind it), `MailEnvelope`, `MailDeliveryResult` (`accepted` / `bounced` / `failed` + opaque message id), `requireMailConfiguration(env)`, `configuredMailTransport`, `setMailTransport` (bootstrap hook for the owner-selected adapter), `FakeMailTransport` (tests only, never installed implicitly). |
| `packages/db/src/ops/jobs/mail.ts` (new) | Platform job kinds `mail.deliver` (identity priority) and `mail.purge` (every minute, JOB-21 schedule), `recordMailDeliveryResult`, `purgeExpiredMailBodies`, reconciler for `unknown` `mail.deliver` jobs. |
| `packages/db/src/platform/accounts.ts` | `Mail` gains `oneTime {purpose, expiresAt}` and `order {id, recipient}`; `dbMailer(exec)` now calls `public.mail_enqueue(...)` (no table access, throws at creation when production has no provider); `listOutbox` is local-mode only and takes the platform pool; invitations carry `oneTime`. |
| `packages/db/src/platform/schema-accounts.ts` + `drizzle/0012_gray_mother_askani.sql` | New `mail_outbox` columns `one_time_purpose`, `expires_at`, `order_id`, `recipient`, `delivery_status`, `provider`, `provider_message_id`, `delivered_at`, `bodies_purged_at`, CHECKs, index; hand-written section `===== T-73` at the end (backfill, REVOKEs, kinds, four definer functions). |
| `packages/db/src/ops/jobs/notify.ts` | Rendered mails carry `order {id, recipient}`; handler comments updated; imports `mail.ts`. |
| `packages/db/src/seller/commerce/privacy.ts` | Buyer export and redaction of mail go through `mail_privacy_export` / `mail_privacy_redact` (store-bound by `app_store_id()`); no `mail_outbox` table access remains. |
| `packages/db/src/platform/isolation-registry.ts` | `mail_outbox` app column is now `""` (platform stays `SELECT,INSERT,UPDATE`); four `DEFINER_FUNCTIONS`. |
| `packages/db/src/worker.ts` | Imports `mail.ts`; calls `configuredMailTransport(requireMailConfiguration())` before opening the pool: production without a configured and installed provider exits non-zero before claiming a job. |
| `packages/db/src/index.ts` | `export * from "./platform/mail-transport.ts"`. |
| `apps/web/src/lib/auth.ts` | Reset-password mail carries `oneTime {recovery, expiresAt = RESET_TOKEN_TTL_SEC}`. |
| `apps/web/src/app/(public-services)/dev/outbox/page.tsx` | Reads through `platformDb()` (app role cannot SELECT any more). |
| `apps/web/playwright.config.ts`, `scripts/verify-docker.sh` | `MAIL_MODE=local` for the production build used by e2e / the image smoke test (loopback origin only). |
| Tests | `test/t73-mailer.test.ts` (20 new), `test/accounts.test.ts` (platform pool reads the outbox), `test/jobs.test.ts` (ignores derived `mail.deliver`), `test/rls.test.ts` (import-boundary allow-list gains the dev outbox page, one line). |

## Design and decisions

1. **App role cannot read bodies or update rows.** Migration revokes everything on `mail_outbox` and its sequence from `bukalaris_app` (D-10 ceiling removed; the "revisit" clause of D-10 is the moved redaction). The app reaches the table only through `SECURITY DEFINER` functions owned by `bukalaris_owner`, `search_path = pg_catalog, pg_temp`, schema-qualified, no dynamic SQL, registered in `DEFINER_FUNCTIONS`: `mail_enqueue` (app + platform), `mail_privacy_export` and `mail_privacy_redact` (app + platform; both bound to the caller's `app_store_id()` through the order, so another store, or no context, gets nothing), `mail_purge_expired` (platform only). `mail_privacy_export` returns buyer order copies only, never credential-bearing mail.
2. **Order provenance is explicit.** T-43 matched mail to orders by a regex over the subject. Order mails now carry `order_id` + `recipient`; the migration backfills existing copies from `order_notification`; the redaction function matches on `order_id` (a redacted order's late notification is not enqueued: erasure wins).
3. **Intent is durable, I/O is not in a business transaction.** `Mailer.send` inserts the row and a `mail.deliver` job in one definer call. The worker performs the external call: `markDispatched` fence, per-call `AbortSignal.timeout(MAIL_TRANSPORT_TIMEOUT_MS)` (1..30000, default 30000, below the 60 s lease), idempotency key `mail:<id>`. A thrown error, timeout or malformed result is `unknown` (D-21): never re-dispatched, body kept until a result or the expiry, reconciler settles only when a result was recorded out of band, otherwise an operator resolves it. The transport's error text is never stored.
4. **Results recorded without the body.** `accepted`, `bounced`, `failed` set `delivery_status`, provider, message id, `delivered_at`; body and HTML are overwritten in the same statement (`bodies_purged_at`); a CHECK forbids a purged row that still holds text. Result recording is bound (provider and message id must match), exact replays are no-ops, `accepted` → later `bounced` is allowed (asynchronous bounce), every other transition from a final state is refused.
5. **One-time-link bodies.** Invitations and password recovery pass `oneTime`; `buyer_proof` and `support_recovery` are accepted purposes for T-58/T-63. A one-time mail must carry a future expiry (CHECK + function). Bodies are purged at delivery result or at the link's own expiry (`mail.purge` every minute through `mail_purge_expired`, database clock, batch 1..10000, status `expired` when never delivered). **No retention period was invented**: the rule is the token's lifetime. Order mail bodies (non-credential) are purged at the delivery result too; in local mode they stay until redaction, as before.
6. **Production never falls back silently.** `MAIL_MODE` defaults to `provider` when `NODE_ENV=production`, `local` otherwise. Provider mode needs `MAIL_PROVIDER` (name), `MAIL_FROM` (address) and an installed transport whose `provider` matches (`setMailTransport`, called by the owner-selected adapter's bootstrap, which does not exist until Q-16). `MAIL_MODE=local` in production is accepted only when `BETTER_AUTH_URL` is a loopback host (the e2e/smoke harness); `DEV_OUTBOX=1` never changes delivery mode. `dbMailer()` throws on creation, and the worker exits non-zero before claiming, so nothing is enqueued into or delivered from the dev sink in production.
7. **Legacy rows.** The migration wipes bodies of pre-existing rows that are not order mail (their expiry is unknown) and marks them `failed`; order mail copies keep their bodies until redaction or delivery.

## Named tests (`packages/db/test/t73-mailer.test.ts`, 20)

- app role: every direct SELECT/INSERT/UPDATE/DELETE/`nextval` on `mail_outbox` is `42501`; the export function returns nothing for credential mail; enqueue creates one platform job per mail; one-time mail without a future expiry is refused (function `22023`, CHECK `23514`); another store's context cannot enqueue, export or redact an order's mail; no context fails closed.
- T-43: redaction through the function reaches buyer and seller copies (buyer address and body overwritten, seller address kept), idempotent second run is 0; a late notification for a redacted order is never enqueued.
- purge: expiry purges body and HTML, keeps the row (`expired`), idempotent, unexpired and order mail untouched, bad batch refused, app cannot call it; the `mail.purge` schedule runs through the T-74 scheduler.
- delivery (fake transport): accepted (one send, idempotency key, body purged, message id kept, nothing re-sent), bounced, failed (body purged each time), two racing workers send once, transport error/timeout → `unknown` with credential text not stored and no second dispatch, then reconciled after an out-of-band result, malformed provider output → `unknown` and nothing stored, result binding / replay / late bounce / illegal transition, local mode never reports delivery and the viewer works only on the platform pool.
- production: missing, partial, invalid, uninstalled or mismatched provider configuration throws; `DEV_OUTBOX` alone changes nothing; local mode needs a loopback origin; the Mailer cannot be created; the worker process exits non-zero with the reason before `started`.

## Commands and observed results

- `pnpm --filter @bukalaris/db generate` — produced `0012_gray_mother_askani.sql` (structural SQL; T-73 hand-written section appended at the end).
- `pnpm lint`, `pnpm typecheck` — clean (final run).
- `pnpm --filter @bukalaris/db test` — see the final line of this section.
- `pnpm build` — compiled, 37 static pages, no route added (`pnpm map:check` not needed).
- `pnpm --filter @bukalaris/web exec playwright test e2e/accounts.spec.ts e2e/notify.spec.ts e2e/privacy.spec.ts e2e/fulfillment.spec.ts` (mobile-320 + desktop, own database `bukalaris_t73_e2e`, port 3473) — **18 passed**. The e2e specs read `mail_outbox` as the database superuser (path unchanged); the `/dev/outbox` production-hidden case still passes.

## DEFERRED (with the missing input)

- **The real provider adapter itself** (SMTP/HTTP client, credentials, sender domain, SPF/DKIM/DMARC evidence, bounce/complaint webhook intake): needs the Q-16 provider and sender-domain decision and external DNS evidence. The seam is complete: `setMailTransport(adapter)` at web/worker bootstrap, `recordMailDeliveryResult` for a later webhook bounce (the webhook route needs the provider's signature scheme).
- **Buyer-proof and support-recovery mail callers** (T-58, T-63): the purposes and purge rule exist; the callers do not.
- **Contract step**: `bukalaris_platform` keeps its expand-step table-wide `DELETE` on `mail_outbox` until the T-59 contract step (local seed/test cleanup still deletes rows).
- Retention of the non-credential delivery rows (status, address, message id): no owner period; they are kept (no purge class created) until the privacy owner decides.

## Doc changes for the conductor

- DECISIONS D-10: superseded by T-73 (app `UPDATE` revoked; redaction through `mail_privacy_redact`).
- TASKS T-73: delivered locally except the provider adapter (Q-16 OPEN); list the DEFERRED items above.
- 05-DATA-MODEL: `mail_outbox` columns/CHECKs above; ARCH-5: `mail.deliver` and `mail.purge` kinds (JOB list); IAM/SEC-24 CRSEC-04 evidence (no app SELECT, bodies purged); 13-COMPLIANCE inventory rows for `mail_outbox` (body purged at delivery result or link expiry; `order_id`/`recipient` provenance); PR-21 evidence (delivery result recorded, dev outbox only in local mode); RUNBOOK/DEPLOY env `MAIL_MODE`, `MAIL_PROVIDER`, `MAIL_FROM`, `MAIL_TRANSPORT_TIMEOUT_MS`.

## Conductor notes when folding

- Migration `0012_gray_mother_askani.sql` is one file (structure first, `===== T-73` section last); its statements are independent of the other wave 2 tracks except `platform_job_kind` (wave 1) and `app_store_id()` (0011/T-59). Fold the T-73 section after the generated statements.
- Shared files touched: `isolation-registry.ts` (one registry value, four definer entries), `index.ts` (+1 export), `worker.ts` (2 imports, 1 guard line), `rls.test.ts` (one test's allow-list), `playwright.config.ts` and `verify-docker.sh` (`MAIL_MODE=local`), `jobs.test.ts` and `accounts.test.ts` (adaptations).
- `t59-contract.sql` already grants `mail_outbox SELECT,INSERT,UPDATE` to the platform role: no change needed; `rls-contract.test.ts` passes with the new definer functions.
