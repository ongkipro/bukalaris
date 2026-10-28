import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { ShippingAccountView } from "./accounts.ts";
import { MengantarError } from "./mengantar/client.ts";

export const SHIPPING_DISPATCH_LEASE_MS = 60_000;
/** A durable per-provider-account lease, not an open database transaction around remote I/O. Master bindings share ONE key. */
export async function withShippingDispatch<T>(db: Db, account: ShippingAccountView, call: () => Promise<T>): Promise<T> {
  const key = account.kind === "platform_master" ? "platform_master" : `partner:${account.id}`;
  const token = randomUUID();
  const won = await db.execute(sql`insert into public.shipping_dispatch_lease (key, token, expires_at) values (${key}, ${token}, now() + ${SHIPPING_DISPATCH_LEASE_MS} * interval '1 millisecond')
    on conflict (key) do update set token = excluded.token, expires_at = excluded.expires_at where public.shipping_dispatch_lease.expires_at <= now() returning key`);
  if (!won.length) throw new MengantarError("http", "Bukalaris Kirim: account dispatch busy", 409);
  try { return await call(); }
  finally { await db.execute(sql`update public.shipping_dispatch_lease set expires_at = now() where key = ${key} and token = ${token}`); }
}
