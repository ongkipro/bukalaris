# Track report — `notify` (M2 wave 2b: T-36 e-mail order notifications, PR-21, Q-16)

Branch `m2/notify`, worktree `~/Projects/bukalaris-wt/notify`, dev database `bukalaris_notify`
(ports 3230/3231). Local only: no deploy, no network mail (the `Mailer` is still the dev outbox
in `mail_outbox`), no provider calls. E-mail only per owner decision Q-16; WhatsApp deferred.

## What changed

### Owned files (created)

| Path | Change |
|---|---|
| `packages/db/src/notify.ts` | `enqueueOrderNotifications(tx, storeId, orderId, trigger)` (inside the caller's transaction; key `notify:<orderId>:<event>:<buyer\|seller>`; buyer only when the order has an e-mail; `pay`/`process`/`hold`/`complete` are no-ops); job kind `order.notify` + handler (renders text + HTML, records `order_notification`, sends through the Mailer in one transaction); link signing `signOrderLink` / `verifyOrderLink` / `getOrderForLink`; `BUYER_STATUS_LABEL`; `renderMail`, `escapeHtml`; `setNotifyMailer` test seam |
| `packages/db/src/schema-notify.ts` | Table `order_notification (store_id, order_id, event, recipient, to_email)` with compound FK to `order`, `UNIQUE (order_id, event, recipient, to_email)`, CHECKs on event/recipient |
| `packages/db/drizzle/0005_notify.sql` + `meta/0005_snapshot.json` | Generated with `pnpm db:generate` (renamed from `0005_fine_nighthawk`, journal tag updated); appended, nothing earlier edited (D-9). Adds `order.buyer_email`, `mail_outbox.html_body`, `order_notification` |
| `apps/web/src/app/o/layout.tsx`, `o/[token]/page.tsx`, `o/[token]/not-found.tsx` | Buyer status page behind the signed link (store name, order id, buyer-facing status, lines, totals, payment method, courier, destination area label, tracking number); 404 with the safe message "Tautan tidak berlaku" for invalid/expired/tampered tokens |
| `packages/db/test/notify.test.ts` | 6 integration tests (below) |
| `apps/web/e2e/notify.spec.ts` | 1 Playwright test × 2 projects (320 px, 1440 px), evidence `70`–`73` |
| `docs/tracks/notify.md` | This report |

### "May also edit" files (minimal)

| Path | Change |
|---|---|
| `packages/db/src/checkout.ts` | `buyerEmail` optional in `checkoutInput` (empty string = not given; trimmed, lower-cased, validated, max 254); stored on the order; **one line** `await enqueueOrderNotifications(tx, storeId, o.id, "created")` after the payment enqueue, inside the order transaction. No other logic touched |
| `packages/db/src/orders.ts` | **One line** `await enqueueOrderNotifications(tx, scope.storeId, orderId, action)` after the history insert in `transitionOrder` (maps confirm → confirmed, ship → shipped, cancel/reject → cancelled; other actions no-op) |
| `packages/db/src/accounts.ts` | `Mail.html?: string`; `dbMailer` stores it in `mail_outbox.html_body` |
| `apps/web/src/app/checkout/page.tsx`, `actions.ts` | Optional "Email (opsional)" field (`type=email`, help text) between phone and address; `buyerEmail` added to the action's field whitelist. Nothing else changed |

### Shared files edited outside the row (all minimal, please review at merge)

| Path | Change |
|---|---|
| `packages/db/src/schema.ts` | `order.buyer_email text` (nullable) + `export * from "./schema-notify.ts"` |
| `packages/db/src/schema-accounts.ts` | `mail_outbox.html_body text` (nullable) |
| `packages/db/src/index.ts` | `export * from "./notify.ts"` (the web app needs `getOrderForLink`/`BUYER_STATUS_LABEL`; the package exports map only exposes `index.ts`) |
| `packages/db/src/worker.ts` | `import "./notify.ts"` so the worker process registers the `order.notify` handler |
| `packages/db/test/jobs.test.ts` | Orders now also enqueue `order.notify` jobs, so the outbox tests scope their job/outcome assertions to non-notify kinds (`ne(job.kind, ORDER_NOTIFY)`, `payments()` filter). No assertion weakened |
| `apps/web/playwright.config.ts` | Worker `webServer` gets `BETTER_AUTH_URL=http://localhost:<E2E_PORT>` so e-mail links point at the e2e origin |
| `.env.example` | Appended `ORDER_LINK_SECRET` placeholder (one line + comment) |
| `docs/DEPLOY-COOLIFY.md` | Env table row `ORDER_LINK_SECRET` |

## Decisions and defaults

- **Events and recipients.** `created` → buyer (if e-mail) + store owners; `confirmed` → buyer; `shipped` → buyer (with tracking number); `cancelled` (seller `cancel` or COD `reject`) → buyer + owners. The seller `created` mail for a COD order is the "COD menunggu konfirmasi" mail (PR-21 "awaiting payment/confirmation" for the seller); for a transfer order it says "menunggu pembayaran". `pay`, `process`, `hold`, `complete` send nothing (hold is invisible to the buyer: the status page shows "Menunggu konfirmasi penjual" for both `awaiting_confirmation` and `on_hold`). Cancellation reasons stay internal (not mailed).
- **At most once per event and recipient.** Two layers: the job `(kind, key)` with key `notify:<orderId>:<event>:<recipient>` (a repeated action is rejected by `transitionOrder` before any enqueue anyway), and `order_notification`'s unique `(order_id, event, recipient, to_email)` row inserted in the same transaction as the outbox mail. A job re-run after a lost lease therefore skips addresses already notified; a failed send rolls both back and retries through the outbox backoff. `// lazy` ceiling: with a network provider, record and send are not atomic (at-least-once on a crash between them).
- **Seller recipients** = every `owner` member of the store (preferences out of scope, per task); staff get nothing. Addresses are lower-cased.
- **Buyer e-mail** is optional everywhere (never required for COD), validated with the same rule as invitations, lower-cased, stored on `order.buyer_email`. It is part of the idempotency request hash like every other field.
- **Link format** `/o/<orderId>.<expiry>.<hmac>`: `expiry` = unix seconds, `hmac` = base64url HMAC-SHA256 over `order-link:<orderId>.<expiry>` with `ORDER_LINK_SECRET`. TTL 30 days (`ORDER_LINK_TTL_MS`; a COD cycle can be slow, and every later mail carries a fresh link). Verification: shape regex → expiry → `timingSafeEqual` on equal-length buffers. Rotating the secret invalidates every link (tested). Fallback: when `ORDER_LINK_SECRET` is unset the domain-separated HMAC uses `BETTER_AUTH_SECRET` so a dev checkout works without a new variable; production should set it (documented).
- **Status page** reveals only that order: status, lines, totals, payment method, courier, destination area label, tracking number, timestamps. No street address, phone, e-mail, store id or other orders (`getOrderForLink` selects an explicit column list; tested). Invalid tokens → segment `not-found.tsx` (HTTP 404, "Tautan tidak berlaku…"), identical for expired, tampered and unknown.
- **Templates** (Indonesian, plain text + simple inline-styled HTML, no external assets, no images): every interpolated value passes `escapeHtml` in the HTML body; the plain text keeps values raw. Buyer mails link to `/o/<token>`, seller mails to `/seller/orders/<id>`. Base URL = `BETTER_AUTH_URL` (the public origin the app already requires), so the worker needs it too. Footer: "Email ini dikirim otomatis oleh Bukalaris. Jangan membalas email ini."

| Event | Recipient | Subject |
|---|---|---|
| created | buyer | `Pesanan #<id> di <toko> diterima` (COD / transfer lead differs) |
| created | seller (COD) | `[<toko>] Pesanan COD #<id> menunggu konfirmasi` |
| created | seller (transfer) | `[<toko>] Pesanan baru #<id> menunggu pembayaran` |
| confirmed | buyer | `Pesanan #<id> dikonfirmasi oleh <toko>` |
| shipped | buyer | `Pesanan #<id> dikirim · resi <resi>` |
| cancelled | buyer | `Pesanan #<id> dibatalkan` |
| cancelled | seller | `[<toko>] Pesanan #<id> dibatalkan` |

- **Dev outbox** keeps the text body as before and additionally stores `html_body`; `/dev/outbox` is unchanged (still hidden in production). The e2e spec reads `mail_outbox` from the e2e database like `accounts.spec.ts` does, because the suite runs the production build in which `/dev/outbox` is 404 (asserted by the accounts spec, kept).

## Commands and results (worktree root, 2026-10-07 WIB)

| Command | Result |
|---|---|
| `pnpm db:generate` | `drizzle/0005_fine_nighthawk.sql` → renamed `0005_notify.sql` (`order_notification`, `order.buyer_email`, `mail_outbox.html_body`); journal entry idx 5 |
| `pnpm db:migrate` (dev `bukalaris_notify`) | `migrations applied` |
| `pnpm lint` | pass (0 problems) |
| `pnpm typecheck` | pass (db + web, `next typegen` ok) |
| `pnpm test` | **110 passed** (104 existing + 6 in `test/notify.test.ts`), 13 files, 33 s |
| `pnpm build` | pass; `/o/[token]` dynamic |
| `pnpm e2e` | **58 passed, 2 skipped** (both pre-existing viewport-independent skips), 5.9 min, worker as second `webServer` |

`notify.test.ts` covers: checkout enqueues `created` buyer + seller jobs in the order transaction with the right keys/payloads, replay with the same idempotency key adds nothing, no buyer job without an e-mail (empty field = none), invalid e-mail rejected, failed checkout and an aborted transaction leave no job, no-op actions; worker sends exactly one mail per event and recipient — re-run is empty, a crashed worker (handler ran, lease lost) is reclaimed without a second mail (`order_notification` row count = mails), repeated action rejected, duplicate enqueue no-op; a failing mailer leaves job `pending` with a redacted error and zero mails/rows, then succeeds on retry with exactly one mail per recipient; lifecycle (confirmed → buyer, process → nothing, staff ship → buyer with tracking in subject/text/HTML, complete → nothing, staff cancel → buyer + both owners, not staff, reason not mailed, COD reject → owners, another store's owner never receives this store's mail); HTML escaping of product/variant titles and buyer name while the text stays raw, no external URLs; signed link (shape, verify, page data without address/phone/ids, link in the mail opens that order, expiry boundary, past-signed link expired, other id, pushed expiry, flipped signature, truncated, malformed, secret rotation, unknown id).

`notify.spec.ts` (320 px + desktop, evidence `70`–`73`): checkout with e-mail → two mails (buyer "diterima", owner "COD menunggu konfirmasi", HTML present, seller link to Seller Admin) → buyer link opens the status page without cookies (status, line, total Rp 106.500, courier, "Belum tersedia", area label; no phone/street) → owner confirms, processes, ships with a tracking number → buyer gets "dikonfirmasi" and "dikirim · resi …" mails, owner gets no more → same link shows "Dikirim" + tracking → flipped signature, another order id with this signature and junk are 404 with the safe message, the real token still 200.

## Open issues / not done

- **No real e-mail provider.** `Mailer` remains the seam (`dbMailer` only). Provider choice, sender domain, SPF/DKIM/DMARC, bounce handling and unsubscribe are open (Q-16 provider part). With a network provider the record-then-send step is at-least-once on a crash between the two (see decision above).
- Seller notification preferences and WhatsApp are out of scope (Q-16).
- Link revocation (PR-21 "expires or can be revoked") is expiry-only; revocation would need a per-order link version column checked in `verifyOrderLink`.
- Buyer e-mail is not shown in Seller Admin (the `ui` track owns that presentation).
- Retention of `order_notification` and `mail_outbox` rows: none yet (pair with T-33).
- `docs/DECISIONS.md` entry suggested for the orchestrator (not written here to avoid conflicts): notification events/recipients, at-most-once layers, link format and TTL, `ORDER_LINK_SECRET` fallback.
- Evidence PNGs: new `docs/evidence/m1/{mobile-320,desktop}-7[0-3]-*.png`; the 106 re-rendered existing PNGs were restored before committing.
