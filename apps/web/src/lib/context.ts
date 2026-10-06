import "server-only";
import { db, operatorScope, platformDb, sellerContext } from "@bukalaris/db";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "./auth";

export const STORE_COOKIE = "bl_store";

export const currentUser = cache(async () => {
  // headers() first: it marks the route dynamic before auth() needs runtime env (DATABASE_URL).
  const h = await headers();
  const s = await auth().api.getSession({ headers: h });
  return s?.user ?? null;
});

/** Seller context from the session; the store cookie is only a membership-checked preference. */
export const seller = cache(async () => {
  const u = await currentUser();
  if (!u) redirect("/login?next=/seller");
  const pref = Number((await cookies()).get(STORE_COOKIE)?.value) || undefined;
  return { user: u, ctx: await sellerContext(db(), u.id, pref) };
});

/** Seller scope for mutations: denies (throws) when there is no active membership. */
export async function sellerScope() {
  const { ctx } = await seller();
  if (!ctx.ok) redirect("/seller");
  return ctx.scope;
}

/** Platform operator check for pages outside /admin (e.g. account security). */
export const isOperator = (userId: string) => operatorScope(platformDb(), userId).then((op) => op !== null);

export const operator = cache(async () => {
  const u = await currentUser();
  if (!u) redirect("/login?next=/admin");
  // Super Admin reads across stores: the privileged pool (ADR-0005); the app pool cannot even see platform_operator.
  const op = await operatorScope(platformDb(), u.id);
  // IAM-9: platform access requires MFA. `twoFactorEnabled` is only set after a verified TOTP enrolment (accounts track).
  if (op && !u.twoFactorEnabled) redirect("/account/security?next=/admin");
  return { user: u, op };
});

export async function operatorOrDeny() {
  const { op } = await operator();
  if (!op) redirect("/admin");
  return op;
}
