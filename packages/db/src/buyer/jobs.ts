import { z } from "zod";
import type { Executor } from "../client.ts";
import { enqueue, registerHandler } from "../ops/jobs/jobs.ts";
import { resolveBuyerForOrder } from "./resolve.ts";

// JOB-10 (T-57): the `buyer.resolve` outbox kind. Checkout writes the order snapshot and this ID-only intent in one app-pool transaction;
// the worker consumes it on the platform pool after commit. Importing this module registers the handler and the kind's policy (side
// effect, like payments/jobs.ts): the web app imports it through checkout.ts so every process that enqueues or requeues the kind knows its policy, the worker
// imports it to run the handler. A lagging or failing resolution never fails or delays the guest order: the job stays visible in
// `jobLagByKind` and `deadLetters` (OBS-6, OBS-7) and an operator can requeue it (replay-safe).

export const BUYER_RESOLVE = "buyer.resolve";

const payload = z.object({ orderId: z.number().int().positive() });

/** Inside the order transaction of checkout. The key is the order id (unique platform-wide), so a replayed checkout never enqueues twice. */
export const enqueueBuyerResolve = (tx: Executor, storeId: number, orderId: number) =>
  enqueue(tx, { kind: BUYER_RESOLVE, storeId, key: `order:${orderId}`, payload: { orderId } });

// Bulk priority (the default class, after money and after the order e-mails): the association is not time-critical, and a flood of
// checkouts must never delay a payment instruction or a notification behind identity work. The store comes from the job row, which the
// order transaction wrote under its own store context, never from the payload. Replay-safe because the resolver is idempotent on
// `(store_id, order_id)`, so an audited requeue of a dead job cannot repeat an effect.
registerHandler(
  BUYER_RESOLVE,
  async ({ db }, j) => {
    const { orderId } = payload.parse(j.payload);
    await resolveBuyerForOrder(db, j.storeId, orderId, `job:${j.id}`);
  },
  { replaySafe: true },
);
