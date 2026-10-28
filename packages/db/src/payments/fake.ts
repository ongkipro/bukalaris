import type { PaymentAdapter } from "./providers.ts";
import { buildSubmit, expiryStampWib, parseListPayment, parseSubmit, type PaymentCreateInput } from "./contract.ts";
import { createHash } from "node:crypto";

/** Only this fake fixture defines local enabled channels. No network transport exists. */
export class FakeAutoLaris implements PaymentAdapter {
  readonly mode = "fake" as const;
  channels: unknown = { rc: "00", data: [
    { channel_code: "VABCA", name: "Virtual account BCA (simulasi)", admin: "6500", tipe_admin: "fix" },
    { channel_code: "QRIS", name: "QRIS (simulasi)", admin: "0.7", tipe_admin: "persen" },
    { channel_code: "VABNI", name: "Virtual account BNI (simulasi)", admin: "3000", tipe_admin: "fix" },
    { channel_code: "OVO", name: "Dompet digital (simulasi)", admin: "3.0", tipe_admin: "persen" },
  ] };
  createCalls: PaymentCreateInput[] = [];
  adviceCalls: string[] = [];
  bills = new Map<string, Record<string, unknown>>();
  adviceResults = new Map<string, unknown>();
  instructionForm: "va" | "qr" | "payment_code" | "url" = "va";
  /** Fake fault controls: logical rejection, malformed reply, and lost response AFTER bill creation. */
  createResult: Record<string, unknown> | undefined;
  crashAfterCreate = false;
  /** The provider never received the request (network timeout before creation). */
  down = false;
  crashAdvice = false;
  async listChannels() { return parseListPayment(this.channels); }
  async submit(input: PaymentCreateInput) {
    this.createCalls.push(input);
    buildSubmit(input); // exercise the same request contract; no HTTP operation is possible
    if (this.down) throw new Error("simulated provider timeout");
    let raw = this.bills.get(input.reffId);
    if (!raw) {
      const transactionId = `SIM-${createHash("sha256").update(input.reffId).digest("hex").slice(0, 24)}`;
      const form = input.channelCode === "QRIS" ? "qr" : input.channelCode === "OVO" ? "url" : this.instructionForm;
      const value = form === "qr" ? "000201010212\n  QRIS-BYTES-UNCHANGED-6304ABCD " : form === "url" ? `https://example.invalid/pay/${transactionId}` : form === "payment_code" ? `SIM-CODE-${transactionId}` : `SIM-VA-${transactionId}`;
      raw = this.createResult ?? { rc: "00", data: { reff_id: input.reffId, channel_code: input.channelCode, transaction_id: transactionId, total: input.totalIdr, biaya_admin: Math.floor(input.adminFeeIdr * 0.8),
        payment_info: { [form]: value, expired: expiryStampWib(input.expiresAt) } } };
      if (raw.rc === "00") this.bills.set(input.reffId, raw); // a logical rejection creates no bill
    }
    if (this.crashAfterCreate) throw new Error("simulated lost submit response");
    return parseSubmit(raw, input);
  }
  async advice({ transactionId }: { transactionId: string }): Promise<unknown> {
    this.adviceCalls.push(transactionId);
    if (this.crashAdvice) throw new Error("simulated lost inquiry response");
    return this.adviceResults.get(transactionId) ?? { rc: "02", ket: "FAILED" };
  }
  /** Fake-only recovery seam, not an invented provider endpoint. Real unknown creates need manual evidence. */
  async recoverCreate(input: PaymentCreateInput) {
    const raw = this.bills.get(input.reffId);
    return raw ? parseSubmit(raw, input) : null;
  }
}
export const fakeAutoLaris = new FakeAutoLaris();
