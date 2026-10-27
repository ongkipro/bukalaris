"use server";

import { sellerScope } from "@/lib/context";
import { adjustStock } from "@bukalaris/db";
import { run } from "../orders/run";

export async function adjustStockAction(variantId: number, f: FormData) {
  const scope = await sellerScope();
  await run("/seller/inventory", () => "/seller/inventory?saved=1", () =>
    adjustStock(scope, variantId, { delta: String(f.get("delta") ?? ""), reason: String(f.get("reason") ?? "") }),
  );
}
