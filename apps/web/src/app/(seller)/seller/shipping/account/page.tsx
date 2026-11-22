import { CsrfField } from "@/lib/auth-csrf-form";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sellerScope } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { can, displayableCategory, shippingSync } from "@bukalaris/db";
import Link from "next/link";
import { confirmDedicatedAction, removeWebhookSecretAction, requestAccountScanAction, resolveForeignParcelAction, setWebhookSecretAction } from "./actions";

export const metadata = { title: "Akun Mengantar — Bukalaris" };

// SC-34 (T-115): the store's link with its OWN Mengantar account. The screen names Mengantar on purpose (the seller holds the account). It shows
// the dedicated-account confirmation, the webhook address and whether a Webhook Secret is stored (never the secret), the sync state with the
// foreign parcels, and Mengantar's balance and invoices read-only with their read time.

const SAVED: Record<string, string> = {
  dedicated: "Akun dikonfirmasi sebagai akun baru yang hanya dipakai toko ini.",
  secret: "Webhook Secret tersimpan terkunci. Semua pemilik toko sudah diberi tahu lewat e-mail.",
  secret_removed: "Webhook Secret dihapus. Status paket tetap diperbarui otomatis secara berkala.",
  scan: "Pemeriksaan akun Mengantar diminta. Hasilnya muncul di halaman ini dalam beberapa saat.",
  scan_pending: "Pemeriksaan akun sudah diminta beberapa menit lalu; hasilnya muncul di halaman ini.",
  resolved: "Paket asing ditandai sudah ditangani.",
};
const INVOICE_TYPE: Record<string, string> = { typeWithdraw: "Penarikan", typeAddBalance: "Isi saldo", typePayment: "Pembayaran", typeReconciliation: "Rekonsiliasi", typeRefund: "Pengembalian" };

export default async function MengantarAccountPage({ searchParams }: PageProps<"/seller/shipping/account">) {
  const scope = await sellerScope();
  const { error, saved } = await searchParams;
  const savedKey = typeof saved === "string" ? saved : undefined;
  if (!can(scope, "shipping.manage"))
    return (
      <section className="grid max-w-3xl gap-6">
        <PageHeader title="Akun Mengantar" />
        <p role="note" className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">Hanya pemilik toko yang dapat melihat dan mengatur akun Mengantar toko.</p>
      </section>
    );
  const owner = can(scope, "integrations.manage");
  const sync = await shippingSync(scope);
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader
        title="Akun Mengantar"
        description="Akun Mengantar milik toko Anda. Bukalaris membaca status paket, saldo dan tagihan dari akun ini; uang ongkir dan COD diselesaikan langsung antara Anda dan Mengantar."
      />
      <Notice error={error} saved={savedKey} savedText={savedKey ? SAVED[savedKey] : undefined} />
      <p className="-mt-3 text-sm text-muted-foreground">
        <Link href="/seller/shipping" className="font-medium text-foreground underline underline-offset-4">Kembali ke Pengiriman</Link>
      </p>

      {!sync.connected ? (
        <EmptyState title="Akun Mengantar belum terhubung" action={<Link href="/seller/payments" className="text-sm font-medium underline underline-offset-4">Buka Akun penyedia</Link>}>
          Hubungkan kunci API akun Mengantar baru yang khusus untuk toko ini di Akun penyedia, lalu kembali ke halaman ini.
        </EmptyState>
      ) : (
        <>
          <section aria-labelledby="dedicated" className="grid gap-3 rounded-lg border p-4" data-testid="dedicated">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="dedicated" className="text-base font-semibold">Akun khusus toko</h2>
              <StatusBadge data-testid="dedicated-state" label={sync.dedicated.confirmedAt ? "Terkonfirmasi" : "Belum dikonfirmasi"} tone={sync.dedicated.confirmedAt ? "success" : "warning"} />
            </div>
            <p className="text-sm text-muted-foreground">
              Pakai akun Mengantar baru yang hanya dipakai toko ini, supaya daftar paket, status dan angka di Mengantar sama dengan di Bukalaris. Saat dikonfirmasi, Bukalaris membaca daftar pesanan akun dan menolak akun yang sudah berisi pesanan lain. Pengiriman baru siap setelah konfirmasi ini.
            </p>
            {sync.dedicated.confirmedAt ? (
              <p className="text-sm" data-testid="dedicated-at">Dikonfirmasi {tanggal(sync.dedicated.confirmedAt)} untuk kunci dan lingkungan yang sedang terhubung.</p>
            ) : owner ? (
              <form action={confirmDedicatedAction} className="grid gap-3" aria-label="Konfirmasi akun khusus">
                <CsrfField />
                <label className="flex min-h-6 items-start gap-2 text-sm">
                  <input type="checkbox" name="confirmed" required className="mt-0.5 size-4 shrink-0 accent-foreground" />
                  <span>Akun Mengantar ini baru dan hanya dipakai toko ini; saya tidak akan membuat paket di akun ini dari aplikasi atau sistem lain.</span>
                </label>
                <SubmitButton className="justify-self-start" pendingText="Memeriksa akun…">Konfirmasi akun khusus</SubmitButton>
              </form>
            ) : (
              <p className="text-sm" role="note">Hanya pemilik toko yang dapat mengonfirmasi akun.</p>
            )}
          </section>

          <section aria-labelledby="webhook" className="grid gap-3 rounded-lg border p-4" data-testid="webhook">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="webhook" className="text-base font-semibold">Webhook status paket</h2>
              <StatusBadge data-testid="webhook-state" label={sync.webhook.secretSet ? "Secret tersimpan" : "Belum diatur"} tone={sync.webhook.secretSet ? "success" : "secondary"} />
            </div>
            <p className="text-sm text-muted-foreground">
              Opsional. Dengan webhook, perubahan status dari Mengantar langsung memicu pembacaan status di akun Anda. Tanpa webhook, Bukalaris tetap membaca status setiap paket yang belum selesai secara berkala, hanya lebih lambat.
            </p>
            {sync.webhookUrl ? (
              <>
                <div className="grid gap-1.5">
                  <p className="text-sm font-medium">1. Pasang alamat ini di Mengantar (Pengaturan → Akun → Integrasi Public API)</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-0 rounded bg-muted px-2 py-1 font-mono text-xs break-all" data-testid="webhook-url">{sync.webhookUrl}</code>
                    <CopyButton value={sync.webhookUrl} label="alamat webhook" />
                  </div>
                </div>
                <p className="text-sm font-medium">2. Salin Webhook Secret dari Mengantar, lalu simpan di bawah</p>
                {sync.webhook.secretSet && sync.webhook.sealedAt && <p className="text-sm" data-testid="webhook-sealed-at">Secret tersimpan sejak {tanggal(sync.webhook.sealedAt)}. Secret tidak pernah ditampilkan lagi.</p>}
                <p className="text-sm text-muted-foreground" data-testid="webhook-last">{sync.webhook.lastWebhookAt ? `Webhook terakhir diterima ${tanggal(sync.webhook.lastWebhookAt)}.` : "Belum ada webhook yang diterima."}</p>
                {owner && (
                  <form action={setWebhookSecretAction} className="grid gap-3 sm:grid-cols-2" aria-label="Simpan Webhook Secret">
                    <CsrfField />
                    <div className="grid gap-2">
                      <Label htmlFor="secret">{sync.webhook.secretSet ? "Webhook Secret baru" : "Webhook Secret"}</Label>
                      <Input id="secret" name="secret" type="password" autoComplete="new-password" spellCheck={false} required minLength={8} maxLength={256} aria-describedby="secret-help" />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="secret-code">Kode verifikasi dua langkah (6 angka)</Label>
                      <Input id="secret-code" name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" autoComplete="one-time-code" required className="sm:max-w-48" />
                    </div>
                    <p id="secret-help" className="text-xs text-muted-foreground sm:col-span-2">Secret disimpan terkunci untuk kunci API yang sedang terhubung. Mengganti kunci API di Mengantar juga mengganti Webhook Secret, jadi simpan secret yang baru setelahnya.</p>
                    <SubmitButton className="justify-self-start">Simpan secret</SubmitButton>
                  </form>
                )}
                {owner && sync.webhook.secretSet && (
                  <form action={removeWebhookSecretAction} className="flex flex-wrap items-end gap-2" aria-label="Hapus Webhook Secret">
                    <CsrfField />
                    <div className="grid gap-2">
                      <Label htmlFor="remove-code">Kode verifikasi</Label>
                      <Input id="remove-code" name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" autoComplete="one-time-code" required className="w-32" />
                    </div>
                    <ConfirmSubmit variant="destructive" message="Hapus Webhook Secret? Webhook dari Mengantar akan ditolak; status paket tetap diperbarui berkala.">Hapus secret</ConfirmSubmit>
                  </form>
                )}
              </>
            ) : (
              <p className="text-sm" role="note" data-testid="webhook-after-dedicated">Alamat webhook toko dibuat setelah akun dikonfirmasi sebagai akun khusus.</p>
            )}
          </section>

          <section aria-labelledby="sync" className="grid gap-3 rounded-lg border p-4" data-testid="sync">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="sync" className="text-base font-semibold">Sinkronisasi paket</h2>
              <StatusBadge data-testid="sync-state" label={sync.exact ? "Sinkron" : "Tidak sinkron"} tone={sync.exact ? "success" : "warning"} />
            </div>
            <p className="text-sm text-muted-foreground" data-testid="sync-last">
              {sync.lastScanAt ? `Akun terakhir diperiksa ${tanggal(sync.lastScanAt)}.` : "Akun belum pernah diperiksa."} {sync.scanError ?? ""}
            </p>
            <form action={requestAccountScanAction}>
              <CsrfField />
              <SubmitButton variant="outline" pendingText="Meminta…">Periksa akun sekarang</SubmitButton>
            </form>
            {sync.foreign.length > 0 && (
              <div className="grid gap-2" data-testid="foreign-parcels">
                <p className="text-sm">
                  Paket berikut ada di akun Mengantar Anda tetapi tidak dibuat lewat Bukalaris. Paket ini tidak diimpor sebagai pesanan. Selama masih ada, data Bukalaris dan Mengantar tidak lagi sama: periksa di Mengantar, lalu tandai sudah ditangani dengan catatan.
                </p>
                <ul className="grid gap-3">
                  {sync.foreign.map((p) => (
                    <li key={p.id} className="grid gap-2 rounded-lg border p-3 text-sm" data-testid={`foreign-${p.providerOrderId}`}>
                      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_minmax(0,1fr)]">
                        <dt className="text-muted-foreground">ID order Mengantar</dt>
                        <dd className="font-mono break-all">{p.providerOrderId}</dd>
                        <dt className="text-muted-foreground">Resi</dt>
                        <dd className="font-mono break-all">{p.trackingNumber ?? "—"}</dd>
                        <dt className="text-muted-foreground">Status di Mengantar</dt>
                        <dd className="break-all">{displayableCategory(p.providerStatus) ?? "—"}</dd>
                        <dt className="text-muted-foreground">Ditemukan</dt>
                        <dd>{tanggal(p.firstSeenAt)}</dd>
                      </dl>
                      <form action={resolveForeignParcelAction} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" aria-label={`Tandai ${p.providerOrderId} sudah ditangani`}>
                        <CsrfField />
                        <input type="hidden" name="id" value={p.id} />
                        <div className="grid gap-2">
                          <Label htmlFor={`note-${p.id}`}>Catatan</Label>
                          <Input id={`note-${p.id}`} name="note" required minLength={5} maxLength={300} placeholder="mis. paket lama dari toko offline, sudah dihapus" />
                        </div>
                        <SubmitButton size="sm">Tandai sudah ditangani</SubmitButton>
                      </form>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section aria-labelledby="money" className="grid gap-3 rounded-lg border p-4" data-testid="mengantar-money">
            <h2 id="money" className="text-base font-semibold">Saldo dan tagihan Mengantar</h2>
            <p className="text-sm text-muted-foreground">
              Angka milik Mengantar, hanya dibaca dari akun Anda. Bukalaris tidak mencatat, menahan atau mencocokkan uang ini.
            </p>
            {sync.mirror.readAt ? (
              <>
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Saldo Mengantar</dt>
                  <dd className="text-right font-medium tabular-nums" data-testid="mengantar-balance">{rupiah(sync.mirror.balanceIdr)}</dd>
                  <dt className="text-muted-foreground">Dibaca</dt>
                  <dd className="text-right" data-testid="mengantar-read-at">{tanggal(sync.mirror.readAt)}</dd>
                </dl>
                {sync.mirror.invoices.length > 0 ? (
                  <ul className="divide-y rounded-lg border text-sm" aria-label="Tagihan dan mutasi Mengantar" data-testid="mengantar-invoices">
                    {sync.mirror.invoices.map((i) => (
                      <li key={i.invNumber} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <span className="min-w-0 break-words">
                          <span className="font-mono text-xs break-all">{i.invNumber}</span> · {INVOICE_TYPE[i.type] ?? "Transaksi lain"}
                          {i.createdAt && !Number.isNaN(Date.parse(i.createdAt)) ? ` · ${tanggal(new Date(i.createdAt))}` : ""}
                        </span>
                        <span className="tabular-nums sm:text-right">{rupiah(i.total ?? i.amount)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Belum ada tagihan.</p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="mengantar-not-read">Belum dibaca. Tekan Periksa akun sekarang.</p>
            )}
          </section>
        </>
      )}
    </section>
  );
}
