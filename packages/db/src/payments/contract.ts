import { AUTOLARIS_PAID } from "./settings.ts";
import { z } from "zod";

export type PaymentOwner = { kind: "order" | "subscription_invoice"; id: string };
export type PaymentCustomer = { id: string; name: string; phone: string; email: string | null };
export type PaymentCreateInput = {
  reffId: string; channelCode: string; owner: PaymentOwner; customer: PaymentCustomer;
  amountIdr: number; adminFeeIdr: number; totalIdr: number; expiresAt: Date; callbackUrl: string;
  /** T-106 (ADR-0013 decision 13): the store's own account data (area ids, shipper e-mail, sender address). Absent = the platform profile of T-49. */
  profile?: SubmitProfile;
};
/** The account fields of the payment-only `/submit` profile. UNVERIFIED (C-P8): the request shape is confirmed with AutoLaris per account. */
export type SubmitProfile = { shipperName: string; originAreaId: string; destinationAreaId: string; shipperEmail: string; senderAddress: string };
export type PaymentInstruction = {
  reference: string; transactionId: string; channelCode: string;
  virtualAccount: string | null; qr: string | null; paymentCode: string | null; url: string | null;
  expiresAt: string; amountIdr: number; adminFeeIdr: number; totalIdr: number; providerFeeIdr: number;
};
export type PaymentChannel = { code: string; name: string; admin: string; adminType: "fix" | "persen" };
export type AdviceInput = { transactionId: string };

export class PaymentContractError extends Error {
  readonly code: "rejected" | "malformed" | "configuration" | "binding" | "amount" | "identity" | "not_found" | "too_large";
  constructor(code: PaymentContractError["code"], message: string) {
    super(message); this.code = code; this.name = "PaymentContractError";
  }
}
const fail = (message: string): never => { throw new PaymentContractError("malformed", message); };
const object = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : fail("invalid provider envelope");
export const safeIdr = (v: unknown): number | null => {
  if (typeof v !== "number" && !(typeof v === "string" && /^\d+$/.test(v))) return null;
  const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const text = (v: unknown): string => typeof v === "string" && v.length > 0 ? v : fail("missing provider identity");

/** GET /list_payment is the ONLY availability authority; unknown extra flags do not disable a returned row. */
export function parseListPayment(raw: unknown): PaymentChannel[] {
  const envelope = object(raw);
  if (envelope.rc !== "00") throw new PaymentContractError("rejected", "channel discovery rejected");
  const rows = z.array(z.object({ channel_code: z.string().regex(/^[A-Z0-9_-]{1,40}$/), name: z.string().min(1).max(120), admin: z.string().regex(/^\d+(\.\d+)?$/), tipe_admin: z.enum(["fix", "persen"]) })).parse(envelope.data);
  if (new Set(rows.map((r) => r.channel_code)).size !== rows.length) fail("duplicate channel");
  return rows.map((r) => ({ code: r.channel_code, name: r.name, admin: r.admin, adminType: r.tipe_admin }));
}

/** UTC+7 arithmetic, never the container's local timezone. Explicit submit-expiry support remains live-gated. */
export function expiryStampWib(at: Date): string {
  if (!Number.isFinite(at.getTime())) fail("invalid expiry");
  const d = new Date(at.getTime() + 7 * 3_600_000);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((v, i) => String(v).padStart(i === 0 ? 4 : 2, "0")).join("");
}

/** Account-approved non-physical profile only. These 24 keys do not instruct shipping or pickup. */
/** An area id as the provider documents it (a number); a non-numeric value from the account is sent as given (UNVERIFIED, C-P8). */
const areaValue = (id: string): number | string => (/^\d{1,15}$/.test(id) ? Number(id) : id);
export function buildSubmit(input: PaymentCreateInput) {
  const p = input.profile;
  return {
    reff_id: input.reffId, channel_code: input.channelCode, courir_id: 1,
    origin: p ? areaValue(p.originAreaId) : 3517100, destination: p ? areaValue(p.destinationAreaId) : 3518010, weight: "1", length: "1", width: "1", height: "1",
    shipper_name: p?.shipperName ?? "Bukalaris", shipper_phone: "0800000000", shipper_email: p?.shipperEmail ?? "payments@example.invalid", shipper_address: p?.senderAddress ?? "Pesanan digital",
    receiver_name: input.customer.name, receiver_phone: input.customer.phone, receiver_email: input.customer.email ?? "", receiver_address: "Pesanan digital",
    callback_url: input.callbackUrl, grand_total: String(input.totalIdr), cod_value: "0", longitude: "", latitude: "", remark: `Pembayaran ${input.owner.kind}`,
    order_details: [{ name: "Pembayaran Bukalaris", qty: "1", unit_price: String(input.totalIdr) }],
  };
}

/** An HTTP success is not a logical success. Never trim/rewrite QR bytes or choose between ambiguous instructions. */
export function parseSubmit(raw: unknown, input: PaymentCreateInput): PaymentInstruction {
  const e = object(raw);
  if (e.rc !== "00") throw new PaymentContractError("rejected", "payment creation rejected");
  const d = object(e.data), p = object(d.payment_info);
  if (d.reff_id !== input.reffId || d.channel_code !== input.channelCode) fail("provider reference mismatch");
  const values = [p.va, p.virtual_account, p.qr, p.payment_code, p.url];
  if (values.some((v) => v != null && typeof v !== "string")) fail("invalid instruction field");
  const populated = values.filter((v) => typeof v === "string" && v.length > 0) as string[];
  if (populated.length !== 1 || populated[0]!.length > 2048 || !populated[0]!.trim()) fail("exactly one bounded instruction required");
  const total = safeIdr(d.total), fee = safeIdr(d.biaya_admin);
  if (total === null || total !== input.totalIdr || fee === null) throw new PaymentContractError("malformed", "provider total mismatch");
  const url = typeof p.url === "string" && p.url ? p.url : null;
  if (url && !/^https:\/\//.test(url)) fail("unsafe instruction URL");
  return { reference: input.reffId, transactionId: text(d.transaction_id), channelCode: input.channelCode,
    virtualAccount: (p.va || p.virtual_account || null) as string | null, qr: (p.qr || null) as string | null,
    paymentCode: (p.payment_code || null) as string | null, url, expiresAt: text(p.expired),
    amountIdr: input.amountIdr, adminFeeIdr: input.adminFeeIdr, totalIdr: total, providerFeeIdr: fee };
}
export type AdviceClassification = "paid" | "pending" | "unknown";
const adviceData = (e: Record<string, unknown>): Record<string, unknown> => (typeof e.data === "object" && e.data !== null && !Array.isArray(e.data) ? e.data as Record<string, unknown> : {});
/**
 * Decision 22 / D-21 K: `paid` only for the paid code AND a status word on the one allow-list (`AUTOLARIS_PAID`, UNVERIFIED) AND the provider
 * amount equal to the attempt total. `02` is pending; everything else, including an unknown word, is `unknown` and never settles.
 */
export function classifyAdvice(raw: unknown, totalIdr: number): AdviceClassification {
  if (typeof raw !== "object" || raw === null) return "unknown";
  const e = raw as Record<string, unknown>;
  if (e.rc === "02") return "pending";
  const d = adviceData(e), word = d[AUTOLARIS_PAID.statusField];
  return e.rc === AUTOLARIS_PAID.code && typeof word === "string" && AUTOLARIS_PAID.words.includes(word) && safeIdr(d[AUTOLARIS_PAID.amountField]) === totalIdr ? "paid" : "unknown";
}
/** The status word as received, for review (decision 22); a value that is not a short plain token is not stored. */
export function adviceStatusWord(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const w = adviceData(e)[AUTOLARIS_PAID.statusField] ?? e.ket;
  return typeof w === "string" && /^[A-Za-z0-9 _.-]{1,64}$/.test(w) ? w : null;
}

/** One channel's fee as a versioned platform setting (decision 19). Explicit bases prevent the QRIS fee-on-shipping incident (BILL-4). */
export type FeeRate = { base: "goods_omset" | "payable" | "flat"; rateBps: number; fixedIdr: number };
/** The fee schedule in force: the highest version of `payment_fee_rate` (`currentFeeSchedule`). Availability never comes from it. */
export type FeeSchedule = { version: number; rates: Readonly<Record<string, FeeRate>> };
/**
 * The version-1 seed of migration 0020 (the reference system's starting data, UNVERIFIED with AutoLaris, decision 19). Runtime code never reads
 * it: checkout prices with the schedule read from the database. Tests use it to build a schedule and to prove the seed.
 */
export const STARTING_FEE_RATES: Readonly<Record<string, FeeRate>> = Object.freeze({
  QRIS: { base: "goods_omset", rateBps: 70, fixedIdr: 0 },
  VABCA: { base: "flat", rateBps: 0, fixedIdr: 6500 },
  VABNI: { base: "flat", rateBps: 0, fixedIdr: 3000 }, VABRI: { base: "flat", rateBps: 0, fixedIdr: 3000 },
  VAMANDIRI: { base: "flat", rateBps: 0, fixedIdr: 3000 }, VAPERMATA: { base: "flat", rateBps: 0, fixedIdr: 3000 },
  OVO: { base: "payable", rateBps: 300, fixedIdr: 0 },
});
/**
 * T-107 (ADR-0013 decisions 17 to 19): the provider COD fee is a row of the same versioned schedule under this reserved code (base `payable` = the
 * order total before the fee). It is never a payment channel: the channel list, the seller's exclusions and the Owner console locks leave it out.
 */
export const COD_FEE_CODE = "COD";
const rateOf = (schedule: FeeSchedule, channel: string): FeeRate | undefined => (Object.hasOwn(schedule.rates, channel) ? schedule.rates[channel] : undefined);
export function paymentFee(schedule: FeeSchedule, channel: string, goodsOmset: number, payable: number): number {
  const fee = rateOf(schedule, channel);
  if (!fee) throw new PaymentContractError("configuration", "channel has no approved fee schedule");
  const base = fee.base === "goods_omset" ? goodsOmset : fee.base === "payable" ? payable : 0;
  if (safeIdr(base) === null || safeIdr(payable) === null) fail("invalid fee base");
  return Number((BigInt(base) * BigInt(fee.rateBps) + BigInt(5000)) / BigInt(10000)) + fee.fixedIdr;
}

/** Buyer-facing description of the gateway fee schedule of a channel (Indonesian, white-label); null when the channel is not priced. */
export function feeLabel(schedule: FeeSchedule, channel: string): string | null {
  const fee = rateOf(schedule, channel);
  if (!fee) return null;
  if (fee.base === "flat") return `Biaya layanan Rp${fee.fixedIdr.toLocaleString("id-ID")}`;
  const percent = (fee.rateBps / 100).toLocaleString("id-ID", { maximumFractionDigits: 2 });
  return `Biaya layanan ${percent}% dari ${fee.base === "goods_omset" ? "nilai belanja" : "total tagihan"}`;
}
export const isPricedChannel = (schedule: FeeSchedule, code: string): boolean => rateOf(schedule, code) !== undefined;
