import "server-only";
import { DomainError, ownsOpenCart, type StorefrontScope } from "@bukalaris/db";
import { normalizeHostname, resolveHostSurface, surfaceOriginsFromEnv } from "@bukalaris/db/host";
import { createCookieGetter, getCookies, parseCookies } from "better-auth/cookies";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { withError } from "./errors";
import { cache } from "react";
import { authForHost, surfaceSecret } from "./auth";
import { createCsrfToken, csrfFormToken, validCsrfOrigin, validCsrfToken, type CsrfBinding } from "./auth-csrf-token.mts";
import { cartCookie } from "./storefront";

const refuse = () => new DomainError("csrf", "Sesi formulir berubah. Muat ulang halaman, lalu coba lagi.");
const duplicatedCookie = (raw: string, name: string) => raw.split(";").filter((part) => part.split("=", 1)[0]?.trim() === name).length > 1;

/** Read-only session resolution; never refresh a session merely to issue/check a token. */
export async function portalCsrfContext(h: Headers) {
  const selected = authForHost(h.get("host"));
  if (!selected) return null;
  const { surface, auth, origin } = selected;
  const pendingName = createCookieGetter(auth.options)("two_factor").name;
  const names = [getCookies(auth.options).sessionToken.name, pendingName];
  const raw = h.get("cookie") ?? "";
  const ambiguous = names.some((name) => duplicatedCookie(raw, name));
  const secret = surfaceSecret(surface, process.env) ?? "";
  if (ambiguous) return { surface, origin, secret, binding: null, ambiguous };
  const current = await auth.api.getSession({ headers: h, query: { disableCookieCache: true, disableRefresh: true } });
  // The native endpoint still authenticates/expires/consumes this challenge. Its MAC only protects the request intent.
  const pending = parseCookies(raw).get(pendingName);
  if (pending && pending.length > 4096) return { surface, origin, secret, binding: null, ambiguous: true };
  const binding: CsrfBinding | null = current
    ? { kind: "session", surface, origin, id: current.session.id }
    : pending ? { kind: "pending-mfa", surface, origin, id: pending } : null;
  return { surface, origin, secret, binding, ambiguous };
}

const requestPortalContext = cache(async () => portalCsrfContext(await headers()));

/** Only the opaque MAC crosses into rendered HTML; no session identifier or signing material does. */
export async function portalCsrfToken(): Promise<string | null> {
  const context = await requestPortalContext();
  return context?.binding?.kind === "session" ? createCsrfToken(context.binding, context.secret) : null;
}

/** Original-action check. Redirect forms may name their server-controlled internal recovery route; state actions catch the DomainError. */
export async function requirePortalCsrf(input: unknown, failurePath?: string): Promise<void> {
  const context = await requestPortalContext();
  const token = typeof input === "string" ? input : csrfFormToken(input);
  if (!context || context.ambiguous || context.binding?.kind !== "session" || !validCsrfOrigin(await headers(), context.origin) || !validCsrfToken(token, context.binding, context.secret)) {
    const error = refuse();
    if (failurePath) redirect(withError(failurePath, error.message));
    throw error;
  }
  if (input instanceof FormData) input.delete("_csrf");
}

async function cartCsrfContext(scope: StorefrontScope) {
  const h = await headers();
  const host = h.get("host");
  const surface = resolveHostSurface(host, process.env.STORE_ROOT_DOMAIN ?? "localhost");
  const origins = surfaceOriginsFromEnv();
  let origin: string;
  if (surface.kind === "local_path") origin = origins.platformOrigin;
  else if (surface.kind === "checkout") origin = origins.checkoutOrigin;
  else if (surface.kind === "store" && surface.slug === scope.storeSlug) {
    const configured = new URL(origins.platformOrigin);
    configured.hostname = `${scope.storeSlug}.${normalizeHostname(process.env.STORE_ROOT_DOMAIN ?? "localhost")}`;
    origin = configured.origin;
  } else throw refuse();
  // Configuration, never Origin/forwarded headers, selects the MAC audience. Next may render a redirect through its internal loopback host.
  const hostMatches = new URL(origin).host.toLowerCase() === host?.trim().toLowerCase();
  if (duplicatedCookie(h.get("cookie") ?? "", cartCookie(scope.storeId))) throw refuse();
  const id = (await cookies()).get(cartCookie(scope.storeId))?.value;
  const binding: CsrfBinding = { kind: "cart", surface: surface.kind, origin, storeId: scope.storeId, id: id && await ownsOpenCart(scope, id) ? id : null };
  return { binding, secret: process.env.BETTER_AUTH_SECRET ?? "", hostMatches };
}

export async function cartCsrfToken(scope: StorefrontScope): Promise<string> {
  const { binding, secret } = await cartCsrfContext(scope);
  return createCsrfToken(binding, secret);
}

export async function requireCartCsrf(scope: StorefrontScope, data: unknown): Promise<void> {
  const { binding, secret, hostMatches } = await cartCsrfContext(scope);
  // Strict request-host matching belongs to mutation enforcement, not read-only token issuance during an internal redirect render.
  if (!hostMatches || !validCsrfOrigin(await headers(), binding.origin) || !validCsrfToken(csrfFormToken(data), binding, secret)) throw refuse();
  if (data instanceof FormData) data.delete("_csrf");
}
