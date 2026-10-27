"use server";

import { sellerScope } from "@/lib/context";
import { unlinkMedia, writeMedia } from "@/lib/media";
import { addProductMedia, moveMediaUp, removeProductMedia, updateMediaAlt } from "@bukalaris/db";
import { run, text } from "../_run";

/** Upload: bytes are sniffed in packages/db; the file is written inside the insert transaction. */
export async function uploadMediaAction(productId: number, f: FormData) {
  const scope = await sellerScope();
  const back = `/seller/products/${productId}`;
  await run(back, () => `${back}?saved=1#gambar`, async () => {
    const file = f.get("file");
    const bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(0);
    await addProductMedia(scope, productId, bytes, text(f, "alt"), (key) => writeMedia(key, bytes));
  });
}

export async function updateMediaAltAction(productId: number, mediaId: number, f: FormData) {
  const scope = await sellerScope();
  const back = `/seller/products/${productId}`;
  await run(back, () => `${back}?saved=1#gambar`, () => updateMediaAlt(scope, mediaId, text(f, `alt_${mediaId}`)));
}

export async function moveMediaUpAction(productId: number, mediaId: number) {
  const scope = await sellerScope();
  const back = `/seller/products/${productId}`;
  await run(back, () => `${back}?saved=1#gambar`, () => moveMediaUp(scope, mediaId));
}

export async function removeMediaAction(productId: number, mediaId: number) {
  const scope = await sellerScope();
  const back = `/seller/products/${productId}`;
  await run(back, () => `${back}?saved=1#gambar`, async () => {
    const key = await removeProductMedia(scope, mediaId);
    await unlinkMedia(key);
  });
}
