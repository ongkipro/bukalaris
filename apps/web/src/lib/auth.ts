import "server-only";
import { db } from "@bukalaris/db";
import { account, session, user, verification } from "@bukalaris/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";

function createAuth() {
  return betterAuth({
    database: drizzleAdapter(db(), { provider: "pg", schema: { user, session, account, verification } }),
    // Accounts are provisioned by the platform (seed / Super Admin); no public signup (IAM named boundary).
    emailAndPassword: { enabled: true, disableSignUp: true },
    telemetry: { enabled: false },
    plugins: [nextCookies()], // must stay last
  });
}

let instance: ReturnType<typeof createAuth> | undefined;
/** Lazy so `next build` needs neither DATABASE_URL nor BETTER_AUTH_SECRET. */
export const auth = () => (instance ??= createAuth());
