**Verdict: CHANGES REQUIRED.** I found two wrong claims and one weakly supported claim. The rest checked out against the code.

| file:line | problem | evidence | fix |
|---|---|---|---|
| `BUILD-LOG.md` (2026-11-01 entry, "Checked by reading code") and `docs/research/2026-11-portfolio-scan/README.md:37` | "All 129 schema tables are in the isolation registry" is wrong. | The drizzle snapshot `0016_snapshot.json` has 130 tables. `ISOLATION_REGISTRY` has 131 keys (counted by importing it). `rls.test.ts:60` asserts equality in both directions. `TASKS.md` T-2 says 79, which is older still. | State the number the registry test checks, which is 131. Or say "every table", with no count. |
| `docs/02-PRD.md` Q-10 row | It cites "ADR-0006 decision 9" for late payment and the refund obligation. Decision 9 is "Ledger reads and verification". | ADR-0006 decision 8 ("Order-status and payment-callback invariants") has the Q-10 quarantine and the buyer refund obligation. | Change "decision 9" to "decision 8". |
| `docs/11-BILLING-PAYMENTS.md` BILL-2 anomaly rule | "An amount or environment mismatch ... Today these are recorded as events (`payments/attempts.ts`, `billing/attempts.ts`)" is only partly true. | `billing/attempts.ts:212-216` records `payment_on_void_invoice` and `payment_on_covered_invoice`. In `payments/attempts.ts` a late payment goes to `latePaymentObligation`. An amount mismatch in `payments/callback.ts:52` throws `PaymentContractError`, so it is a refusal with no recorded event. I found no environment check in `payments/`. | Split the sentence. Void, covered and terminal-order payments are recorded. An amount mismatch is refused with an error. An environment mismatch has no handling yet, so call it a requirement. |

Everything else I checked held up:
- **SEC-25:** `createDb` has no URL fallback, and `_registry.sh` checks role attributes offline.
- **`/api/ready`:** it runs only `select 1`, and the probe script does not exist.
- **Migrator and journal:** there is no journal check in `scripts/`, and the current journal is strictly increasing.
- **QRIS:** both screens render the payload in a `<textarea>`.
- **Mengantar timeout:** `AbortSignal.timeout` is used in `shipping/mengantar/client.ts`.
- **`/data/media`:** it is set in the Dockerfile.
- **Task and requirement IDs:** T-74 to T-79, DEL-1/2, DR-1/2, OBS-6, BILL-7, UI-10, NFR-3, D-19/D-23 and SC-28/SF-08 all exist.
- **Done-when lines:** T-76 to T-79 use runnable commands (`pnpm verify`, `pnpm --filter @bukalaris/db test`, `pnpm --filter @bukalaris/web e2e`), and T-79 marks its production half as unticked until executed.

I did not run anything beyond reading and import counts.

## Resolution (orchestrator, 2026-11-01)

All three findings accepted and fixed: the registry count is no longer stated (the test asserts both directions),
Q-10 now cites ADR-0006 decision 8, and the BILL-2 anomaly sentence separates recorded events, the refund
obligation, the refused amount mismatch and the missing environment check.
