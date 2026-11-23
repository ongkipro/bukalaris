import { sellerScope } from "@/lib/context";
import { proofResponse, readProofFile, sellerProofFile } from "@bukalaris/db";
import { parseId } from "../../../../status";

/**
 * T-113 (ADR-0013 decision 39): a buyer's proof-of-transfer image for the store's finance role (`finance.confirm_payment`), looked up by the
 * proof of THIS order in the seller's own store context and read from the private store. Always an attachment, sandboxed, never cached.
 */
export async function GET(_req: Request, { params }: RouteContext<"/seller/orders/[id]/proof/[proofId]/[n]">) {
  const { id, proofId, n } = await params;
  const scope = await sellerScope();
  const orderId = parseId(id);
  const found = Number.isSafeInteger(orderId) ? await sellerProofFile(scope, orderId, { proofId, n }).catch(() => null) : null;
  const bytes = found ? await readProofFile(found.file.key) : null;
  if (!found || !bytes) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return proofResponse(bytes, found.file.mime, found.n);
}
