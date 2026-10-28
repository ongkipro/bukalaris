/** Seller and buyer surfaces say "Bukalaris Kirim" (D-15, ADR-0007): provider error text recorded on a shipment is scrubbed of the vendor name at display time. */
export const whiteLabel = (text: string): string => text.replace(/MengantarError:\s*Mengantar:?\s*/g, "").replace(/mengantar/gi, "Bukalaris Kirim");

/** Shown instead of a provider status this product does not know: the raw provider text never reaches a seller or a buyer (it stays on the shipment row for the operator). */
export const UNKNOWN_PROVIDER_STATUS_LABEL = "Pembaruan terbaru dari kurir";
/** A partner snapshot is never dispatched through another account, and live partner dispatch is not open: the same sentence on every path that refuses it. */
export const PARTNER_DISPATCH_LOCKED_MESSAGE = "Akun Bukalaris Kirim toko ini belum dibuka untuk pengiriman nyata. Pesanan tidak dialihkan ke akun lain; coba lagi setelah akun dipulihkan oleh Bukalaris.";
const TIMELINE_TEXT_MAX = 160;
/** A provider-written timeline line shown to a seller or buyer: vendor name replaced, control characters and runs of spaces collapsed, length bounded. */
export const scrubProviderText = (text: string): string => {
  const clean = whiteLabel(text).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return clean.length > TIMELINE_TEXT_MAX ? `${clean.slice(0, TIMELINE_TEXT_MAX - 1)}…` : clean;
};
