import { CopyButton } from "@/components/copy-button";
import { rupiah } from "@/lib/format";
import type { BuyerBankTransfer } from "@bukalaris/db";

const dt = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });
export const PROOF_STATUS_LABEL = { sent: "Terkirim, menunggu penjual", accepted: "Diterima penjual", rejected: "Ditolak penjual" } as const;

/**
 * T-113 (ADR-0013 decision 37): what the buyer of a bank-transfer order must do, on the confirmation and the order-status page: the exact order
 * total (no unique code), the seller's destination accounts frozen on the order, and the end of the payment window. Never the seller's provider.
 */
export function BankTransferInstruction({ bank, storeName }: { bank: BuyerBankTransfer; storeName: string }) {
  if (bank.confirmed || bank.orderStatus !== "awaiting_payment") return null;
  return (
    <section aria-labelledby="bank-transfer-heading" className="grid gap-3 rounded-lg border p-3 text-sm" data-testid="bank-transfer-instruction">
      <h2 id="bank-transfer-heading" className="font-medium">Transfer ke rekening {storeName}</h2>
      <p className="flex flex-wrap items-center gap-2">
        <span>Transfer tepat <strong className="tabular-nums" data-testid="bank-transfer-total">{rupiah(bank.totalIdr)}</strong></span>
        <CopyButton value={String(bank.totalIdr)} label="jumlah transfer" />
      </p>
      <ul className="grid gap-2" aria-label="Rekening tujuan">
        {bank.accounts.map((a) => (
          <li key={`${a.bankCode}-${a.accountNumber}`} className="grid gap-0.5 rounded-md bg-muted/50 p-2" data-testid="bank-account">
            <span className="text-xs text-muted-foreground">{a.bankCode} · a.n. {a.holderName}</span>
            <span className="flex flex-wrap items-center gap-2">
              <strong className="select-all font-mono">{a.accountNumber}</strong>
              <CopyButton value={a.accountNumber} label={`nomor rekening ${a.bankCode}`} />
            </span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        Bayar sebelum <span data-testid="bank-transfer-expiry">{dt.format(bank.expiresAt)} WIB</span>; setelah itu pesanan dibatalkan otomatis. Pesanan diproses setelah penjual mengonfirmasi dana masuk di rekeningnya.
      </p>
    </section>
  );
}
