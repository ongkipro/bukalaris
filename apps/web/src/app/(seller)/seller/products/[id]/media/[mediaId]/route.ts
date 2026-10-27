import { currentUser } from "@/lib/context";
import { imageResponse, readMedia } from "@/lib/media";
import { db, listProductMedia, mediaKey, sellerContext } from "@bukalaris/db";
import type { NextRequest } from "next/server";

/** Seller preview of an own image (draft products included): session + membership scoped, private cache. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/seller/products/[id]/media/[mediaId]">) {
  const { id, mediaId } = await ctx.params;
  if (!/^[0-9]{1,15}$/.test(id) || !/^[0-9]{1,15}$/.test(mediaId)) return new Response(null, { status: 404 });
  const u = await currentUser();
  if (!u) return new Response(null, { status: 401 });
  const sctx = await sellerContext(db(), u.id);
  if (!sctx.ok) return new Response(null, { status: 403 });
  const m = (await listProductMedia(sctx.scope, Number(id))).find((x) => x.id === Number(mediaId));
  if (!m) return new Response(null, { status: 404 });
  const bytes = await readMedia(mediaKey(m));
  if (!bytes) return new Response(null, { status: 404 });
  return imageResponse(bytes, m.mime, 0);
}
