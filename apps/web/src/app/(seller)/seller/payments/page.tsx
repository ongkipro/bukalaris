import { CsrfField } from "@/lib/auth-csrf-form";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { sellerScope } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { BANK_ACCOUNT_MAX, can, sellerBankTransfer, sellerPaymentPreferences, sellerProviderAccounts, type BankTransferState, type PaymentAccountDetails, type PaymentPreferences, type ProviderAccountView, type Readiness } from "@bukalaris/db";
import { BANKS } from "@/lib/finance";
import Link from "next/link";
import { addBankAccountAction, checkProviderNowAction, removeBankAccountAction, removeProviderKeyAction, saveBankTransferSettingsAction, savePaymentDetailsAction, savePaymentPreferencesAction, saveProviderKeyAction } from "./actions";
import { checkLabel, environmentLabel, feeBearerLabel, gapLabel, providerName, savedLabel } from "./labels";

export const metadata = { title: "Akun penyedia — Bukalaris" };

// SC-32 (T-104): the store's own Mengantar and AutoLaris accounts. The page shows only the connected state, the environment, a masked hint and
// the last check; a stored key is never sent to the browser. Owner only (`integrations.manage`).

export default async function ProviderAccountsPage({ searchParams }: PageProps<"/seller/payments">) {
  const scope = await sellerScope();
  const { error, saved } = await searchParams;
  if (!can(scope, "integrations.manage"))
    return (
      <section className="grid max-w-3xl gap-6">
        <PageHeader title="Akun penyedia" />
        <p role="note" data-testid="providers-denied" className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">Hanya pemilik toko yang dapat menghubungkan, mengganti atau menghapus kunci akun pengiriman dan pembayaran toko.</p>
      </section>
    );
  const [data, prefs, bank] = await Promise.all([sellerProviderAccounts(scope), sellerPaymentPreferences(scope), sellerBankTransfer(scope)]);
  const savedKey = typeof saved === "string" ? saved : undefined;
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader title="Akun penyedia" description="Hubungkan akun Mengantar dan AutoLaris milik toko Anda. Uang pembeli dan uang COD masuk langsung ke akun Anda; Bukalaris tidak memegangnya." />
      <Notice error={error} saved={savedKey} savedText={savedKey ? savedLabel[savedKey] : undefined} />

      <dl className="grid gap-3 sm:grid-cols-2" data-testid="readiness">
        <ReadinessCard testId="readiness-payment" title="Pembayaran QRIS/VA" readiness={data.readiness.qrisVa} />
        <ReadinessCard testId="readiness-shipping" title="Pengiriman dan COD" readiness={data.readiness.shipping} />
        <ReadinessCard testId="readiness-bank" title="Transfer bank" readiness={{ ready: bank.ready, missing: [] }} note={bank.ready ? undefined : bank.accounts.length === 0 ? "Tambahkan minimal satu rekening." : "Transfer bank dimatikan."} />
      </dl>
      <p className="-mt-3 text-xs text-muted-foreground" data-testid="readiness-open">
        {data.readiness.canOpen ? "Toko punya setidaknya satu cara bayar yang siap." : "Toko butuh setidaknya satu cara bayar yang siap sebelum bisa dibuka."} Produk fisik hanya bisa diaktifkan saat pengiriman siap.
      </p>

      <ProviderSection account={data.autolaris} title="Pembayaran · AutoLaris" intro="Kunci API H2H dari AutoLaris untuk QRIS dan virtual account. Minta profil khusus pembayaran ke AutoLaris, lalu masukkan kuncinya di sini." />
      <DetailsForm details={data.details} connected={data.autolaris.connected || data.details !== null} />
      {prefs.preferences && <PreferencesForm preferences={prefs.preferences} channels={prefs.channels} />}
      {can(scope, "finance.confirm_payment") && (
        <p className="text-sm">
          <Link href="/seller/payments/transactions" className="inline-flex min-h-6 items-center font-medium underline underline-offset-4" data-testid="transactions-link">Transaksi pembayaran AutoLaris</Link>
          <span className="text-muted-foreground"> — status tagihan, cek status sekarang dan konfirmasi manual.</span>
        </p>
      )}
      <BankTransferSection bank={bank} />
      <ProviderSection account={data.mengantar} title="Pengiriman · Mengantar" intro="Kunci API dari akun Mengantar baru yang khusus dipakai toko ini. Ongkir, pemesanan kurir dan pelacakan berjalan di akun Anda." />
      <p className="text-xs text-muted-foreground">
        Tidak ada kolom alamat server: Bukalaris memakai alamat resmi penyedia sesuai lingkungan yang Anda pilih. Area dan alamat pickup diatur di <Link href="/seller/shipping" className="underline underline-offset-4">Pengiriman</Link>.
      </p>
    </section>
  );
}

function ReadinessCard({ title, readiness, testId, note }: { title: string; readiness: Readiness; testId: string; note?: string | undefined }) {
  return (
    <div className="grid content-start gap-1.5 rounded-lg border p-4" data-testid={testId}>
      <dt className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-muted-foreground">
        {title}
        <StatusBadge label={readiness.ready ? "Siap" : "Belum siap"} tone={readiness.ready ? "success" : "warning"} />
      </dt>
      {readiness.missing.map((gap) => (
        <dd key={gap} className="text-sm">{gapLabel[gap]}</dd>
      ))}
      {note && <dd className="text-sm">{note}</dd>}
      {readiness.ready && <dd className="text-sm">Semua syarat terpenuhi.</dd>}
    </div>
  );
}

function ProviderSection({ account, title, intro }: { account: ProviderAccountView; title: string; intro: string }) {
  const p = account.provider;
  const name = providerName[p];
  return (
    <section aria-labelledby={`${p}-heading`} className="grid gap-3" data-testid={`provider-${p}`}>
      <h2 id={`${p}-heading`} className="text-base font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{intro}</p>
      <dl className="grid gap-x-4 gap-y-2 rounded-lg border p-4 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Status</dt>
        <dd><StatusBadge data-testid={`${p}-status`} label={account.connected ? "Terhubung" : "Belum terhubung"} tone={account.connected ? "success" : "secondary"} /></dd>
        <dt className="text-muted-foreground">Lingkungan</dt>
        <dd data-testid={`${p}-environment`}>{account.environment ? environmentLabel[account.environment] : "—"}</dd>
        <dt className="text-muted-foreground">Kunci</dt>
        <dd className="font-mono break-all" data-testid={`${p}-hint`}>{account.keyHint ?? "—"}</dd>
        <dt className="text-muted-foreground">Cek terakhir</dt>
        <dd data-testid={`${p}-last-check`}>{account.lastCheckedAt ? `${tanggal(account.lastCheckedAt)} · ${checkLabel[account.lastResult ?? ""] ?? "—"}` : "Belum pernah"}</dd>
      </dl>

      <form action={saveProviderKeyAction} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2" aria-label={`Simpan kunci ${name}`}>
        <CsrfField />
        <input type="hidden" name="provider" value={p} />
        <div className="grid gap-2">
          <Label htmlFor={`${p}-env`}>Lingkungan</Label>
          <NativeSelect id={`${p}-env`} name="environment" defaultValue={account.environment ?? "sandbox"}>
            <option value="sandbox">{environmentLabel.sandbox}</option>
            <option value="production">{environmentLabel.production}</option>
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${p}-key`}>{account.connected ? "Kunci API baru (opsional)" : "Kunci API"}</Label>
          <Input id={`${p}-key`} name="apiKey" type="password" autoComplete="new-password" spellCheck={false} required={!account.connected} maxLength={512} aria-describedby={`${p}-key-help`} />
        </div>
        <p id={`${p}-key-help`} className="text-xs text-muted-foreground sm:col-span-2">
          {account.connected ? "Kosongkan untuk tetap memakai kunci tersimpan (misalnya saat hanya mengganti lingkungan). " : ""}Kunci dicek ke {name} sebelum disimpan; kunci yang gagal dicek tidak disimpan dan kunci lama tetap dipakai. Kunci tidak pernah ditampilkan lagi.
        </p>
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor={`${p}-code`}>Kode verifikasi dua langkah (6 angka)</Label>
          <Input id={`${p}-code`} name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" autoComplete="one-time-code" required className="sm:max-w-48" />
        </div>
        <SubmitButton className="justify-self-start" pendingText="Mengecek…">Simpan dan cek</SubmitButton>
      </form>

      {account.connected && (
        <div className="flex flex-wrap items-end gap-3">
          <form action={checkProviderNowAction} aria-label={`Cek kunci ${name}`}>
            <CsrfField />
            <input type="hidden" name="provider" value={p} />
            <SubmitButton variant="outline" pendingText="Mengecek…">Cek sekarang</SubmitButton>
          </form>
          <form action={removeProviderKeyAction} className="flex flex-wrap items-end gap-2" aria-label={`Hapus kunci ${name}`}>
            <CsrfField />
            <input type="hidden" name="provider" value={p} />
            <div className="grid gap-2">
              <Label htmlFor={`${p}-remove-code`}>Kode verifikasi</Label>
              <Input id={`${p}-remove-code`} name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" autoComplete="one-time-code" required className="w-32" />
            </div>
            <ConfirmSubmit variant="destructive" message={`Hapus kunci ${name}? Toko tidak bisa memakai akun ini sampai kunci baru dihubungkan.`}>Hapus kunci</ConfirmSubmit>
          </form>
        </div>
      )}
    </section>
  );
}

function DetailsForm({ details, connected }: { details: PaymentAccountDetails | null; connected: boolean }) {
  if (!connected) return null;
  return (
    <form action={savePaymentDetailsAction} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2" aria-label="Data akun AutoLaris">
      <CsrfField />
      <h3 className="text-sm font-semibold sm:col-span-2">Data akun AutoLaris</h3>
      <div className="grid gap-2">
        <Label htmlFor="originAreaId">ID area asal</Label>
        <Input id="originAreaId" name="originAreaId" defaultValue={details?.originAreaId ?? ""} required maxLength={64} pattern="[A-Za-z0-9_\-]{1,64}" autoComplete="off" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="destinationAreaId">ID area tujuan</Label>
        <Input id="destinationAreaId" name="destinationAreaId" defaultValue={details?.destinationAreaId ?? ""} required maxLength={64} pattern="[A-Za-z0-9_\-]{1,64}" autoComplete="off" />
      </div>
      <div className="grid gap-2 sm:col-span-2">
        <Label htmlFor="shipperEmail">E-mail pengirim</Label>
        <Input id="shipperEmail" name="shipperEmail" type="email" defaultValue={details?.shipperEmail ?? ""} required maxLength={254} />
      </div>
      <div className="grid gap-2 sm:col-span-2">
        <Label htmlFor="senderAddress">Alamat pengirim</Label>
        <Textarea id="senderAddress" name="senderAddress" rows={2} defaultValue={details?.senderAddress ?? ""} required minLength={10} maxLength={500} />
      </div>
      <label className="flex min-h-9 items-start gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="paymentOnly" defaultChecked={!!details?.paymentOnlyConfirmedAt} className="mt-0.5 size-4 accent-foreground" />
        <span>AutoLaris sudah memasang profil khusus pembayaran di akun ini (Bukalaris hanya memakai AutoLaris untuk pembayaran, bukan pengiriman).</span>
      </label>
      <SubmitButton className="justify-self-start">Simpan data</SubmitButton>
    </form>
  );
}

// T-106 (ADR-0013 section 4, decision 18): the seller's AutoLaris switch, excluded channels and who bears the payment fee. Locked channels are
// shown but cannot be chosen (the platform never offers them).
function PreferencesForm({ preferences, channels }: { preferences: PaymentPreferences; channels: { code: string; locked: boolean }[] }) {
  return (
    <form action={savePaymentPreferencesAction} className="grid gap-3 rounded-lg border p-4" aria-label="Pengaturan pembayaran AutoLaris" data-testid="payment-preferences">
      <CsrfField />
      <h3 className="text-sm font-semibold">Pengaturan pembayaran</h3>
      <label className="flex min-h-9 items-start gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={preferences.enabled} className="mt-0.5 size-4 accent-foreground" />
        <span>Terima pembayaran QRIS/VA lewat AutoLaris di checkout</span>
      </label>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Channel yang tidak ditawarkan</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {channels.map((c) => (
            <label key={c.code} className="flex min-h-9 items-center gap-2 text-sm">
              <input type="checkbox" name="excluded" value={c.code} disabled={c.locked} defaultChecked={c.locked || preferences.excludedChannels.includes(c.code)} className="size-4 accent-foreground" />
              <span className="font-mono">{c.code}</span>
              {c.locked && <span className="text-xs text-muted-foreground">dikunci Bukalaris</span>}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Biaya layanan pembayaran ditanggung</legend>
        {(["buyer", "seller"] as const).map((v) => (
          <label key={v} className="flex min-h-9 items-center gap-2 text-sm">
            <input type="radio" name="feeBearer" value={v} defaultChecked={preferences.feeBearer === v} className="size-4 accent-foreground" />
            <span>{feeBearerLabel[v]}</span>
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-muted-foreground">Berlaku untuk pesanan baru. Pesanan yang sudah dibuat memakai pengaturan saat pesanan dibuat.</p>
      <SubmitButton className="justify-self-start">Simpan pengaturan</SubmitButton>
    </form>
  );
}

/**
 * T-113 (ADR-0013 decisions 35 to 39a): bank transfer to the store's own bank account. Up to five destination accounts; listing or removing one
 * needs the owner's fresh second factor (a code, turned into a single-use proof), and every change is audited. The switch and the payment window
 * apply to new orders; an order keeps the accounts it showed the buyer.
 */
function BankTransferSection({ bank }: { bank: BankTransferState }) {
  return (
    <section aria-labelledby="bank-heading" className="grid gap-3" data-testid="bank-transfer-settings">
      <h2 id="bank-heading" className="text-base font-semibold">Transfer bank ke rekening toko</h2>
      <p className="text-sm text-muted-foreground">Pembeli mentransfer tepat sebesar total pesanan ke rekening Anda dan bisa mengirim foto bukti. Pesanan menjadi dibayar hanya setelah Anda mengonfirmasi dana masuk pada halaman pesanan; Bukalaris tidak memeriksa rekening bank.</p>
      {bank.accounts.length > 0 ? (
        <ul className="divide-y rounded-lg border text-sm" aria-label="Rekening tujuan" data-testid="bank-accounts">
          {bank.accounts.map((a) => (
            <li key={a.id} className="grid gap-2 p-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <span><span className="font-medium">{a.bankCode}</span> <span className="font-mono">{a.accountNumber}</span><span className="block text-muted-foreground">a.n. {a.holderName}</span></span>
              <form action={removeBankAccountAction} className="flex flex-wrap items-end gap-2" aria-label={`Hapus rekening ${a.bankCode} ${a.accountNumber}`}>
                <CsrfField />
                <input type="hidden" name="id" value={a.id} />
                <div className="grid gap-1">
                  <Label htmlFor={`bank-remove-code-${a.id}`} className="text-xs">Kode verifikasi</Label>
                  <Input id={`bank-remove-code-${a.id}`} name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" autoComplete="one-time-code" required className="w-32" />
                </div>
                <ConfirmSubmit variant="outline" message={`Hapus rekening ${a.bankCode} ${a.accountNumber}? Pesanan yang sudah dibuat tetap menampilkan rekening ini.`}>Hapus</ConfirmSubmit>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p role="note" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground" data-testid="bank-accounts-empty">Belum ada rekening. Transfer bank tampil di checkout setelah satu rekening ditambahkan.</p>
      )}
      {bank.accounts.length < BANK_ACCOUNT_MAX && (
        <form action={addBankAccountAction} className="grid gap-3 rounded-lg border p-4 text-sm" aria-label="Tambah rekening">
          <CsrfField />
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="bank-code">Bank</Label>
              <NativeSelect id="bank-code" name="bankCode" defaultValue="BCA">{BANKS.map((b) => <option key={b} value={b}>{b}</option>)}</NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bank-number">Nomor rekening</Label>
              <Input id="bank-number" name="accountNumber" inputMode="numeric" pattern="[0-9]{5,24}" required autoComplete="off" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bank-holder">Nama pemilik rekening</Label>
              <Input id="bank-holder" name="holderName" required minLength={2} maxLength={120} autoComplete="off" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bank-add-code">Kode verifikasi dua langkah</Label>
            <Input id="bank-add-code" name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" autoComplete="one-time-code" required className="sm:max-w-48" aria-describedby="bank-add-code-help" />
            <p id="bank-add-code-help" className="text-xs text-muted-foreground">Kode 6 angka dari aplikasi autentikator. Maksimal {BANK_ACCOUNT_MAX} rekening.</p>
          </div>
          <SubmitButton className="sm:justify-self-start" pendingText="Menyimpan…">Tambah rekening</SubmitButton>
        </form>
      )}
      <form action={saveBankTransferSettingsAction} className="grid gap-3 rounded-lg border p-4 text-sm" aria-label="Pengaturan transfer bank">
        <CsrfField />
        <input type="hidden" name="revision" value={bank.revision} />
        <label className="flex min-h-6 items-center gap-2">
          <input type="checkbox" name="enabled" defaultChecked={bank.enabled} className="size-4" />
          Tawarkan transfer bank di checkout
        </label>
        <div className="grid gap-1.5 sm:max-w-64">
          <Label htmlFor="bank-window">Batas waktu bayar (jam)</Label>
          <Input id="bank-window" name="paymentWindowHours" type="number" min={1} max={168} required defaultValue={bank.paymentWindowHours} aria-describedby="bank-window-help" />
          <p id="bank-window-help" className="text-xs text-muted-foreground">Stok ditahan selama ini; pesanan yang belum dibayar lalu dibatalkan otomatis, kecuali bukti transfer masih menunggu pemeriksaan Anda.</p>
        </div>
        <SubmitButton variant="outline" className="sm:justify-self-start" pendingText="Menyimpan…">Simpan pengaturan</SubmitButton>
      </form>
    </section>
  );
}
