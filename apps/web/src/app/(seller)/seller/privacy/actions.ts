"use server";

import { redactCheckoutSessions, redactOrders } from "@bukalaris/db";
import { sellerScope } from "@/lib/context";
import { run, text } from "../_run";

const PAGE = "/seller/privacy";

/** Redact the checked orders; the result page keeps the search so the owner sees the rows marked. */
export async function redactAction(f: FormData) {
  const scope = await sellerScope();
  const q = text(f, "q");
  const back = `${PAGE}?q=${encodeURIComponent(q)}`;
  await run(
    back,
    (r) => `${back}&saved=${(r as { orders: number }).orders}`,
    () => redactOrders(scope, { orderIds: f.getAll("orderId").map(String), override: f.get("override") === "on", reason: text(f, "reason") }),
  );
}

/** T-45: redact the typed contact of this buyer's abandoned checkout sessions (a buyer who never ordered has no order to select). */
export async function redactSessionsAction(f: FormData) {
  const scope = await sellerScope();
  const q = text(f, "q");
  const back = `${PAGE}?q=${encodeURIComponent(q)}`;
  let redacted = 0;
  await run(
    back,
    () => `${back}&saved=${redacted}&sessions=1`,
    async () => {
      redacted = (await redactCheckoutSessions(scope, q)).checkoutSessions;
    },
  );
}
