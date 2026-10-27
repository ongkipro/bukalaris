import { imageResponse, readMedia } from "@/lib/media";
import { db, getPublicMedia, storefrontScope } from "@bukalaris/db";
import type { NextRequest } from "next/server";

/**
 * Public product image: the store is resolved from the host/path, the id must belong to
 * that store and to an active product; the file is read from MEDIA_DIR by the stored key.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/s/[store]/media/[id]">) {
  const { store, id } = await ctx.params;
  if (!/^[0-9]{1,15}$/.test(id)) return new Response(null, { status: 404 });
  const scope = await storefrontScope(db(), store);
  const m = scope && (await getPublicMedia(scope, Number(id)));
  if (!m || m.productStatus !== "active") return new Response(null, { status: 404 });
  const bytes = await readMedia(m.key);
  if (!bytes) return new Response(null, { status: 404 });
  return imageResponse(bytes, m.mime);
}
