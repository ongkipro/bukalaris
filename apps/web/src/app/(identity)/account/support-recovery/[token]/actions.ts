"use server";

import { authForHost } from "@/lib/auth";
import { db, redeemSupportRecovery } from "@bukalaris/db";
import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

/** Lifetime of the reset session minted from a redeemed support link: the visitor must finish setting a password in this window. */
const RESET_WINDOW_MS = 15 * 60 * 1000;

/**
 * Redeem a support recovery link (T-63, IAM-15): `support_recovery_redeem` consumes the single-use token (never again, never after
 * expiry, never for a suspended or staff identity) and returns the user id once. The visitor then continues on the ordinary reset
 * screen with a fresh Better Auth reset token, so the password is only ever typed by its owner; staff never see or set it.
 */
export async function redeemSupportRecoveryAction(token: string) {
  const h = await headers();
  const instance = authForHost(h.get("host"));
  let target = "/account/support-recovery/invalid";
  if (instance && /^[A-Za-z0-9_-]{20,200}$/.test(token)) {
    const userId = await redeemSupportRecovery(db(), token);
    if (userId) {
      const resetToken = randomBytes(24).toString("base64url");
      const ctx = await instance.auth.$context;
      await ctx.internalAdapter.createVerificationValue({ identifier: `reset-password:${resetToken}`, value: userId, expiresAt: new Date(Date.now() + RESET_WINDOW_MS) });
      target = `/account/recovery/reset?token=${resetToken}`;
    }
  }
  redirect(target);
}
