import "server-only";
import { createHmac } from "node:crypto";
import { db, dbMailer, platformDb } from "@bukalaris/db";
import { resolveHostSurface, surfaceCookieNames, surfaceOriginsFromEnv } from "@bukalaris/db/host";
import { account, auditLog, session, twoFactor, user, verification } from "@bukalaris/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor as twoFactorPlugin } from "better-auth/plugins/two-factor";

export const RESET_TOKEN_TTL_SEC = 60 * 60;

/**
 * One Better Auth instance per surface (T-70 slice 3, ADR-0008 §1, DOM-6): the Owner console, Seller Admin,
 * Affiliate portal and Buyer portal each have their own origin, secret and host-only `__Host-` cookie names,
 * chosen from the request HOST (never from a header, query or body value the browser sends). `local` is the
 * one-host path mode used on plain `localhost` (development, tests, M1 single-host deployment) and keeps the
 * legacy cookie names. A cookie from one surface is signed with another surface's secret and under another
 * name, so it can never open a session on a different surface.
 */
export type AuthSurface = "local" | "owner" | "seller" | "affiliate" | "buyer";
const SURFACES: readonly AuthSurface[] = ["local", "owner", "seller", "affiliate", "buyer"];

/** Auth surface served by `host`, or null when the host serves no sign-in surface (checkout, storefront, logs, apex, unknown). */
export function authSurfaceForHost(host: string | null, env: NodeJS.ProcessEnv = process.env): AuthSurface | null {
  const s = resolveHostSurface(host, env.STORE_ROOT_DOMAIN ?? "localhost");
  switch (s.kind) {
    case "local_path":
      return "local";
    case "owner":
    case "seller":
    case "affiliate":
    case "buyer":
      return s.kind;
    default:
      return null;
  }
}

/** Origin of a surface: the only origin its auth instance accepts for cookie-authenticated writes. */
export function authOrigin(surface: AuthSurface, env: NodeJS.ProcessEnv = process.env): string {
  const o = surfaceOriginsFromEnv(env);
  return { local: o.platformOrigin, owner: o.ownerOrigin, seller: o.appOrigin, affiliate: o.affiliateOrigin, buyer: o.buyerOrigin }[surface];
}

const ORIGIN_ENV: Record<Exclude<AuthSurface, "local">, string> = { owner: "OWNER_ORIGIN", seller: "APP_ORIGIN", affiliate: "AFFILIATE_ORIGIN", buyer: "BUYER_ORIGIN" };

/** Distinct secret per surface: an explicit `AUTH_SECRET_<SURFACE>`, else derived from the base secret by domain separation. */
function surfaceSecret(surface: AuthSurface, env: NodeJS.ProcessEnv): string | undefined {
  const base = env.BETTER_AUTH_SECRET;
  if (surface === "local") return base;
  const explicit = env[`AUTH_SECRET_${surface.toUpperCase()}`];
  if (explicit) return explicit;
  return base ? createHmac("sha256", base).update(`bukalaris-auth-surface:${surface}`).digest("hex") : undefined;
}

/** Cookie names for a surface (`__Host-` in production, plain names over local HTTP). Secondary cookies share the surface name. */
function surfaceCookies(surface: Exclude<AuthSurface, "local">, prod: boolean) {
  const names = surfaceCookieNames(prod);
  const session = { owner: names.ownerSession, seller: names.sellerSession, affiliate: names.affiliateSession, buyer: names.buyerSession }[surface];
  const prefix = prod ? "__Host-" : "";
  const attributes = { secure: prod, path: "/" };
  const named = (suffix: string) => ({ name: `${prefix}bl_${surface}_${suffix}`, attributes });
  return {
    session_token: { name: session, attributes },
    session_data: named("sd"),
    account_data: named("ad"),
    dont_remember: named("dr"),
    two_factor: named("2fa"),
    trust_device: named("td"),
  };
}

function createAuth(surface: AuthSurface) {
  const mailer = dbMailer(db());
  const env = process.env;
  const prod = env.NODE_ENV === "production";
  // Fail closed: in production a host-mode surface needs its own configured origin. Falling back to another surface's
  // origin would make its sign-in accept the wrong Origin and build links on the wrong host (DEPLOY-COOLIFY, DOM-5).
  if (prod && surface !== "local" && !env[ORIGIN_ENV[surface]]) throw new Error(`${ORIGIN_ENV[surface]} is required in production for the ${surface} surface`);
  const origin = authOrigin(surface, env);
  return betterAuth({
    appName: "Bukalaris",
    baseURL: origin,
    secret: surfaceSecret(surface, env),
    // An allowlist of exactly this surface's origin (never a wildcard): Better Auth refuses a cookie-authenticated
    // write whose Origin is anything else. The route handler adds the Sec-Fetch-Site and no-Origin checks.
    trustedOrigins: [origin],
    database: drizzleAdapter(db(), { provider: "pg", schema: { user, session, account, verification, twoFactor } }),
    // `__Host-` needs Secure + no Domain + Path=/. Better Auth would prepend `__Secure-` itself, so the prefix is
    // written into each explicit cookie name instead (production only; plain names over local HTTP).
    ...(surface === "local" ? {} : { advanced: { useSecureCookies: false, cookies: surfaceCookies(surface, prod) } }),
    emailAndPassword: {
      enabled: true,
      // Accounts are provisioned by the platform (seed / invitation); no public signup (IAM named boundary).
      disableSignUp: true,
      // AU-02 recovery: the HTTP route answers identically for unknown e-mails (verified in 1.7.7 password.mjs).
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SEC,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user: u, url }) => {
        await mailer.send({
          to: u.email,
          subject: "Atur ulang kata sandi Bukalaris",
          text: [
            `Halo ${u.name},`,
            `Buka tautan berikut untuk mengatur ulang kata sandi Anda (berlaku ${RESET_TOKEN_TTL_SEC / 60} menit, sekali pakai):`,
            url,
            "Abaikan email ini jika Anda tidak memintanya.",
          ].join("\n"),
        });
      },
      onPasswordReset: async ({ user: u }) => {
        // Account-level audit row (no store): only the platform pool may write audit_log outside a store context.
        await platformDb().insert(auditLog).values({ actorUserId: u.id, action: "password.reset" });
      },
    },
    telemetry: { enabled: false },
    plugins: [
      // IAM-9: platform operators must verify TOTP before /admin (enforced in lib/context.ts).
      twoFactorPlugin({ issuer: "Bukalaris" }),
      nextCookies(), // must stay last
    ],
  });
}

const instances: Partial<Record<AuthSurface, ReturnType<typeof createAuth>>> = {};
/** Lazy so `next build` needs neither DATABASE_URL nor BETTER_AUTH_SECRET. */
export function auth(surface: AuthSurface) {
  if (!SURFACES.includes(surface)) throw new Error(`unknown auth surface: ${surface}`);
  return (instances[surface] ??= createAuth(surface));
}

/** Auth instance for the request's host, or null when this host serves no sign-in surface. */
export function authForHost(host: string | null) {
  const surface = authSurfaceForHost(host);
  return surface ? { surface, auth: auth(surface), origin: authOrigin(surface) } : null;
}
