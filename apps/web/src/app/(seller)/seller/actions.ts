"use server";

import {
  addVariant,
  changeMember,
  createInvitation,
  createProduct,
  db,
  dbMailer,
  revokeInvitation,
  updateProduct,
  updateVariant,
} from "@bukalaris/db";
import { surfaceOriginsFromEnv } from "@bukalaris/db/host";
import { sellerScope, STORE_COOKIE } from "@/lib/context";
import { userError, withError } from "@/lib/errors";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const productFields = (f: FormData) => ({
  title: text(f, "title"),
  description: text(f, "description"),
  status: text(f, "status"),
  slug: text(f, "slug"),
});
const variantFields = (f: FormData, prefix = "") => ({
  title: text(f, `${prefix}title`),
  sku: text(f, `${prefix}sku`),
  price: text(f, `${prefix}price`),
  stock: text(f, `${prefix}stock`),
  weightGrams: text(f, `${prefix}weightGrams`),
});

/** Run a mutation; on an expected failure go back with a message, otherwise to `done`. */
async function run(back: string, done: (result: unknown) => string, op: () => Promise<unknown>) {
  let result: unknown;
  let error: string | undefined;
  try {
    result = await op();
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back, error) : done(result));
}

export async function switchStore(f: FormData) {
  // Only a preference: sellerContext() honours it only with membership.
  (await cookies()).set(STORE_COOKIE, text(f, "storeId"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  redirect("/seller/products");
}

export async function createProductAction(f: FormData) {
  const scope = await sellerScope();
  await run("/seller/products/new", (id) => `/seller/products/${id}?saved=1`, () =>
    createProduct(scope, { ...productFields(f), variant: variantFields(f, "variant_") }),
  );
}

export async function updateProductAction(productId: number, f: FormData) {
  const scope = await sellerScope();
  const back = `/seller/products/${productId}`;
  await run(back, () => `${back}?saved=1`, () => updateProduct(scope, productId, productFields(f)));
}

export async function addVariantAction(productId: number, f: FormData) {
  const scope = await sellerScope();
  const back = `/seller/products/${productId}`;
  await run(back, () => `${back}?saved=1`, () => addVariant(scope, productId, variantFields(f, "new_")));
}

export async function updateVariantAction(productId: number, variantId: number, f: FormData) {
  const scope = await sellerScope();
  const back = `/seller/products/${productId}`;
  await run(back, () => `${back}?saved=1`, () => updateVariant(scope, variantId, variantFields(f, `v${variantId}_`)));
}

export async function changeMemberAction(userId: string, f: FormData) {
  const scope = await sellerScope();
  const role = text(f, "role");
  await run("/seller/members", () => "/seller/members?saved=1", () =>
    changeMember(scope, userId, role === "remove" ? null : (role as "owner" | "staff")),
  );
}

export async function inviteMemberAction(f: FormData) {
  const scope = await sellerScope();
  const base = surfaceOriginsFromEnv(process.env).appOrigin;
  await run("/seller/members", () => "/seller/members?saved=1", () =>
    createInvitation(scope, dbMailer(db()), { email: text(f, "email"), role: text(f, "role") }, (token) => `${base}/invite/${token}`),
  );
}

export async function revokeInvitationAction(invitationId: number) {
  const scope = await sellerScope();
  await run("/seller/members", () => "/seller/members?saved=1", () => revokeInvitation(scope, invitationId));
}
