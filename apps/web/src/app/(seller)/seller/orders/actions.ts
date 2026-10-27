"use server";

import { sellerScope } from "@/lib/context";
import { transitionOrder, type OrderAction } from "@bukalaris/db";
import { run } from "./run";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function orderAction(orderId: number, action: OrderAction, f: FormData) {
  const scope = await sellerScope();
  const back = `/seller/orders/${orderId}`;
  await run(back, () => `${back}?saved=1`, () =>
    transitionOrder(scope, orderId, action, action === "ship" ? { trackingNumber: text(f, "trackingNumber") } : f.has("reason") ? { reason: text(f, "reason") } : {}),
  );
}
