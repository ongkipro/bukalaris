"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";
import { sellerScope } from "@/lib/context";
import { userError, withError } from "@/lib/errors";
import { addAccessLink, removeAccessLink, reorderAccessLink, saveAccessNote } from "@bukalaris/db";
import { redirect } from "next/navigation";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");

async function run(productId: number, op: () => Promise<unknown>) {
  const back = `/seller/products/${productId}`;
  let error: string | undefined;
  try {
    await op();
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back, error) : `${back}?saved=1#akses-digital`);
}

export async function addAccessLinkAction(productId: number, f: FormData) {
  await requirePortalCsrf(f, `/seller/products/${productId}`);
  const scope = await sellerScope();
  await run(productId, () => addAccessLink(scope, productId, { label: text(f, "label"), url: text(f, "url") }));
}

export async function reorderAccessLinkAction(productId: number, itemId: number, direction: "up" | "down", f: FormData) {
  await requirePortalCsrf(f, `/seller/products/${productId}`);
  const scope = await sellerScope();
  await run(productId, () => reorderAccessLink(scope, productId, itemId, direction));
}

export async function removeAccessLinkAction(productId: number, itemId: number, f: FormData) {
  await requirePortalCsrf(f, `/seller/products/${productId}`);
  const scope = await sellerScope();
  await run(productId, () => removeAccessLink(scope, productId, itemId));
}

export async function saveAccessNoteAction(productId: number, f: FormData) {
  await requirePortalCsrf(f, `/seller/products/${productId}`);
  const scope = await sellerScope();
  await run(productId, () => saveAccessNote(scope, productId, { note: text(f, "note") }));
}
