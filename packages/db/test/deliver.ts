import { withStore } from "../src/platform/tenant.ts";
import { applyProviderTransition } from "../src/seller/commerce/orders.ts";
import { platform } from "./helpers.ts";

/**
 * The courier's DELIVERED for an order in transit: the one writer of `completed` (a seller can never complete an order, ADR-0006 decision 4). Kept out of
 * `helpers.ts` because importing the order writer registers the notification module's schedules, which tests that only import helpers must not see.
 */
export const deliver = (storeId: number, orderId: number) => withStore(platform, storeId, (tx) => applyProviderTransition(tx, storeId, orderId, "completed", { source: "provider", note: "test" }));
