import { StatusBadge } from "@/components/status-badge";
import type { SetupChecklist, SetupLock, SetupStepId } from "@bukalaris/db";
import Link from "next/link";

// T-117 (SC-01): the owner-only "Persiapan toko" card. Steps and unlocks come from `sellerSetupChecklist` — it never carries a
// key, a hint or a secret, so this card only links to the screens that own the forms.

const TITLE: Record<SetupStepId, string> = {
  terms: "Setujui Ketentuan Penjual",
  mengantar_account: "Buka akun Mengantar baru khusus toko ini, lalu masukkan kuncinya",
  pickup: "Daftarkan alamat pickup toko",
  webhook: "Atur alamat webhook Bukalaris di Mengantar, lalu masukkan Webhook Secret",
  autolaris: "Minta profil payment-only AutoLaris ke Bukalaris, lalu masukkan kunci yang diterima",
  bank_account: "Daftarkan rekening bank untuk transfer bank",
};
const NOTE: Partial<Record<SetupStepId, string>> = {
  webhook: "Disarankan: tanpa webhook, status paket hanya diperbarui lewat pembacaan terjadwal (lebih lambat).",
};
const LOCK_LABEL: Record<SetupLock, string> = {
  keys: "memasukkan kunci akun dan rekening bank",
  physical: "produk fisik",
  cod: "COD",
  qrisVa: "QRIS/VA",
  bankTransfer: "transfer bank",
  digital: "produk digital",
};
const CAN_LABEL = { physical: "produk fisik", digital: "produk digital", cod: "COD", qrisVa: "QRIS/VA", bankTransfer: "transfer bank" } as const;

export function SetupChecklistCard({ checklist }: { checklist: SetupChecklist }) {
  const requiredOpen = checklist.steps.filter((s) => !s.recommended && !s.done);
  const webhookStep = checklist.steps.find((s) => s.id === "webhook")!;
  if (requiredOpen.length === 0) {
    // Everything required is done; the card leaves, but an open webhook still deserves one small note.
    if (webhookStep.done) return null;
    return (
      <p role="note" className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground" data-testid="setup-webhook-note">
        {NOTE.webhook}{" "}
        <Link href={webhookStep.href} className="inline-flex min-h-6 items-center font-medium text-foreground underline underline-offset-4">
          Atur webhook
        </Link>
      </p>
    );
  }
  const unlocked = (Object.keys(CAN_LABEL) as (keyof typeof CAN_LABEL)[]).filter((k) => checklist.can[k]).map((k) => CAN_LABEL[k]);
  return (
    <section aria-labelledby="setup-checklist-heading" className="grid gap-3 rounded-lg border p-4 text-sm" data-testid="setup-checklist">
      <div className="grid gap-1">
        <h2 id="setup-checklist-heading" className="text-base font-semibold">
          Persiapan toko
        </h2>
        <p className="text-muted-foreground">Selesaikan langkah berikut agar semua jenis produk dan pembayaran bisa diaktifkan.</p>
      </div>
      <ul className="grid gap-3">
        {checklist.steps.map((s) => (
          <li key={s.id} className="grid gap-1 border-t pt-3 first:border-t-0 first:pt-0" data-testid={`setup-step-${s.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <span className="font-medium">{TITLE[s.id]}</span>
              <StatusBadge
                label={s.done ? "Selesai" : s.recommended ? "Disarankan" : "Belum"}
                tone={s.done ? "success" : s.recommended ? "warning" : "secondary"}
                data-testid={`setup-step-${s.id}-status`}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
              {NOTE[s.id] && <span>{NOTE[s.id]}</span>}
              <Link href={s.href} className="inline-flex min-h-6 items-center font-medium text-foreground underline underline-offset-4" data-testid={`setup-step-${s.id}-link`}>
                Buka pengaturan
              </Link>
            </div>
            {!s.done && s.blocks.length > 0 && (
              <p className="text-xs text-muted-foreground" data-testid={`setup-step-${s.id}-locks`}>
                Yang masih terkunci: {s.blocks.map((b) => LOCK_LABEL[b]).join(", ")}.
              </p>
            )}
          </li>
        ))}
      </ul>
      <p className="border-t pt-3 text-muted-foreground" data-testid="setup-unlocked">
        {unlocked.length > 0 ? `Bisa diaktifkan sekarang: ${unlocked.join(", ")}.` : "Belum ada yang bisa diaktifkan."}
      </p>
    </section>
  );
}
