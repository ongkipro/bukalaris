"use server";

import { STORE_COOKIE, currentUser } from "@/lib/context";
import { userError } from "@/lib/errors";
import { acceptInvitation, db } from "@bukalaris/db";
import { hashPassword } from "better-auth/crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const tokenOk = (t: string) => /^[A-Za-z0-9_-]{16,128}$/.test(t);

async function rememberStore(storeId: number) {
  (await cookies()).set(STORE_COOKIE, String(storeId), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
}

/** Signed-in user with the invited e-mail joins the store. */
export async function acceptAsCurrentUser(token: string) {
  const u = await currentUser();
  if (!u || !tokenOk(token)) redirect(`/invite/${encodeURIComponent(token)}`);
  let error: string | undefined;
  let storeId: number | undefined;
  try {
    storeId = (await acceptInvitation(db(), token, { kind: "existing", userId: u.id })).storeId;
  } catch (err) {
    error = userError(err);
  }
  if (error || !storeId) redirect(`/invite/${encodeURIComponent(token)}?error=${encodeURIComponent(error ?? "Gagal.")}`);
  await rememberStore(storeId);
  redirect("/seller/products?saved=1");
}

export type NewAccountResult = { ok: true; email: string } | { ok: false; error: string };

/**
 * No account yet: create it with the chosen password while consuming the invitation
 * (one transaction in packages/db). The browser then signs in through the HTTP route.
 */
export async function acceptAsNewAccount(token: string, f: FormData): Promise<NewAccountResult> {
  if (!tokenOk(token)) return { ok: false, error: "Undangan tidak ditemukan." };
  const password = String(f.get("password") ?? "");
  if (password.length < 8) return { ok: false, error: "Kata sandi minimal 8 karakter." };
  if (password.length > 128) return { ok: false, error: "Kata sandi terlalu panjang." };
  if (password !== f.get("confirm")) return { ok: false, error: "Konfirmasi kata sandi tidak sama." };
  try {
    const r = await acceptInvitation(db(), token, { kind: "new", name: String(f.get("name") ?? ""), passwordHash: await hashPassword(password) });
    await rememberStore(r.storeId);
    return { ok: true, email: r.email };
  } catch (err) {
    return { ok: false, error: userError(err) };
  }
}
