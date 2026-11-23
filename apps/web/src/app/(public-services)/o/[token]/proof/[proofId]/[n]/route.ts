import { buyerProofFile, db, getOrderForLink, proofResponse, readProofFile, resolveBuyerOrder } from "@bukalaris/db";
import { servesStore } from "@/lib/storefront";

/**
 * T-113 (ADR-0013 decision 39): the buyer's own proof-of-transfer image, through the signed order-status link only. The file is looked up by the
 * proof of THIS order (a proof id of another order is the same 404 as an invalid link) and read from the private store; always an attachment,
 * sandboxed, never cached. The public media route never reads this store.
 */
export async function GET(_req: Request, { params }: RouteContext<"/o/[token]/proof/[proofId]/[n]">) {
  const { token, proofId, n } = await params;
  const o = await getOrderForLink(db(), token);
  const ref = o && (await servesStore(o.storeSlug)) ? await resolveBuyerOrder(db(), { token }) : null;
  const found = ref ? await buyerProofFile(db(), ref, { proofId, n }) : null;
  const bytes = found ? await readProofFile(found.file.key) : null;
  if (!found || !bytes) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return proofResponse(bytes, found.file.mime, found.n);
}
