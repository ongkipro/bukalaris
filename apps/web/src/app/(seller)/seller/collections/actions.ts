"use server";

import { sellerScope } from "@/lib/context";
import { createCollection, updateCollection } from "@bukalaris/db";
import { run, text } from "../_run";

const fields = (f: FormData) => ({
  title: text(f, "title"),
  slug: text(f, "slug"),
  description: text(f, "description"),
  status: text(f, "status"),
  // Checked products in the order the seller typed in the "urutan" fields (ties keep list order).
  productIds: f
    .getAll("productIds")
    .map((id) => ({ id: String(id), order: Number(f.get(`order_${id}`)) || 0 }))
    .sort((a, b) => a.order - b.order)
    .map((p) => p.id),
});

export async function createCollectionAction(f: FormData) {
  const scope = await sellerScope();
  await run("/seller/collections/new", (id) => `/seller/collections/${id}?saved=1`, () => createCollection(scope, fields(f)));
}

export async function updateCollectionAction(collectionId: number, f: FormData) {
  const scope = await sellerScope();
  const back = `/seller/collections/${collectionId}`;
  await run(back, () => `${back}?saved=1`, () => updateCollection(scope, collectionId, fields(f)));
}
