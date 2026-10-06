import "server-only";
import { db, dbMailer, platformDb } from "@bukalaris/db";
import { account, auditLog, session, twoFactor, user, verification } from "@bukalaris/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor as twoFactorPlugin } from "better-auth/plugins/two-factor";

export const RESET_TOKEN_TTL_SEC = 60 * 60;

function createAuth() {
  const mailer = dbMailer(db());
  return betterAuth({
    appName: "Bukalaris",
    database: drizzleAdapter(db(), { provider: "pg", schema: { user, session, account, verification, twoFactor } }),
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

let instance: ReturnType<typeof createAuth> | undefined;
/** Lazy so `next build` needs neither DATABASE_URL nor BETTER_AUTH_SECRET. */
export const auth = () => (instance ??= createAuth());
