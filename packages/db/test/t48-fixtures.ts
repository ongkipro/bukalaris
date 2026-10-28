import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../src/client.ts";
import { decideApproval } from "../src/ops/capabilities-approvals.ts";
import { PartnerClient, FakePartnerTransport } from "../src/shipping/mengantar/partner.ts";
import { provisionShippingAccount, setPartnerTransport } from "../src/shipping/accounts.ts";
import { applyShippingSettings, requestMarginRule, requestShippingSettings } from "../src/shipping/policy.ts";
import { setMarginRule } from "../src/shipping/shipping.ts";
import { order, orderFinancials } from "../src/schema.ts";
import { storeShippingAccount } from "../src/shipping/schema-accounts.ts";
import type { OperatorScope } from "../src/platform/scoped.ts";
import { admin, makeOperator, platform } from "./helpers.ts";

/** The real margin flow (request, second operator approves, requester applies). */
export async function setMargin(op: OperatorScope, rule: { fixedIdr: number | string; percentBps: number; roundTo: number | string }) {
  const { approvalId } = await requestMarginRule(op, rule);
  await decideApproval(await makeOperator(["shipping.manage"]), approvalId, "approve");
  return setMarginRule(op, rule, approvalId);
}

export async function setSettings(op: OperatorScope, input: { preferPartner: boolean; discountIdr: number; discountBps: number }, reason = "pengaturan uji") {
  const [row] = await platform.execute<{ revision: number }>(sql`select revision from shipping_control where key = 'default'`);
  const body = { ...input, revision: Number(row!.revision), reason };
  const { approvalId } = await requestShippingSettings(op, body);
  await decideApproval(await makeOperator(["shipping.manage"]), approvalId, "approve");
  await applyShippingSettings(op, approvalId, body);
}

export const KNOWN_SECRET_CANARY = "sk-canary-partner-key-0123456789";
export function fakeTransport() {
  const transport = new FakePartnerTransport();
  setPartnerTransport(transport);
  return { transport, client: (db: Db = platform) => new PartnerClient(db, transport) };
}
export async function provision(storeId: number, db: Db = platform) {
  const { client } = fakeTransport();
  return provisionShippingAccount(db, storeId, client(db));
}
export async function accountsOf(storeId: number) {
  return platform.select().from(storeShippingAccount).where(eq(storeShippingAccount.storeId, storeId)).orderBy(storeShippingAccount.id);
}
export async function orderAccount(orderId: number) {
  const [o] = await platform.select({ id: order.shippingAccountId, kind: order.shippingAccountKind }).from(order).where(eq(order.id, orderId));
  const [f] = await platform.select({ id: orderFinancials.shippingAccountId, kind: orderFinancials.shippingAccountKind }).from(orderFinancials).where(eq(orderFinancials.orderId, orderId));
  return { order: o!, financials: f! };
}
export const newToken = () => randomUUID();
export { admin };
