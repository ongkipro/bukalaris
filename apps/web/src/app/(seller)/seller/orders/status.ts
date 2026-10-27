// Labels and tones live in `@/lib/status` (shared by every seller/admin page); this module keeps the
// orders-track import path and the route-param parser.
export { orderActionLabel as actionLabel, orderStatusLabel as statusLabel, orderStatusTone as statusVariant, paymentLabel } from "@/lib/status";
export { tanggal } from "@/lib/format";

/** Route param → safe integer id, or NaN. */
export const parseId = (s: string) => (/^[0-9]{1,15}$/.test(s) ? Number(s) : NaN);
