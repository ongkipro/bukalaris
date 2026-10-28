import "server-only";
import { bindSession, db, DomainError, operatorCapabilities, operatorScope, platformDb, sellerContext, sessionMfaVerified } from "@bukalaris/db";
import { surfaceCookieNames } from "@bukalaris/db/host";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { authForHost } from "./auth";

/** Store-switch preference cookie: `__Host-bl_store` in production (DOM-6), `bl_store` over local HTTP. */
export const STORE_COOKIE = surfaceCookieNames().sellerStore;

const currentSession = cache(async () => {
  // headers() first: it marks the route dynamic before auth needs runtime env (DATABASE_URL).
  const h = await headers();
  // The session is read by the instance of the request's host surface only (T-70): a host that serves no sign-in surface has no user.
  const surface = authForHost(h.get("host"));
  return surface ? await surface.auth.api.getSession({ headers: h }) : null;
});

export const currentUser = cache(async () => (await currentSession())?.user ?? null);
const currentSessionId = cache(async () => (await currentSession())?.session.id ?? null);

/** Seller context from the session; the store cookie is only a membership-checked preference. */
export const seller = cache(async () => {
  const u = await currentUser();
  if (!u) redirect("/login?next=/seller");
  const pref = Number((await cookies()).get(STORE_COOKIE)?.value) || undefined;
  const ctx = await sellerContext(db(), u.id, pref);
  // The money step-up binds to the server-side session of THIS request (T-37 review P3-8), never to a form value.
  const sid = await currentSessionId();
  return { user: u, ctx: ctx.ok && sid ? { ...ctx, scope: bindSession(ctx.scope, sid) } : ctx };
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
  const s = await currentSession();
  if (!s) redirect("/login?next=/admin");
  const u = s.user;
  // The Owner console reads across stores: the privileged pool (ADR-0005); the app pool cannot even see platform_operator.
  const op = await operatorScope(platformDb(), u.id);
  if (op) {
    // IAM-9: platform access requires MFA. `twoFactorEnabled` is only set after a verified TOTP enrolment (accounts track).
    if (!u.twoFactorEnabled) redirect("/account/security?next=/admin");
    // D-21: the account flag is not enough. This session itself must have verified a second-factor code (written by the
    // verification hook in lib/auth.ts); a session from before enrolment, or a stolen one, signs in again instead.
    if (!(await sessionMfaVerified(platformDb(), s.session.id, u.id))) redirect("/login?next=/admin");
  }
  // Capabilities are re-read on every request (IAM-15); they only decide what the navigation shows, each operation checks its own.
  return { user: u, op, sessionId: s.session.id, caps: op ? await operatorCapabilities(platformDb(), u.id) : [] };
});

/** Resolve a capability-checked load for a page: a refusal becomes `undefined` so the page renders the denied state; other errors propagate. */
export async function allowed<T>(load: Promise<T>): Promise<T | undefined> {
  try {
    return await load;
  } catch (err) {
    if (err instanceof DomainError && err.code === "forbidden") return undefined;
    throw err;
  }
}
