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
import { can, sellerProviderAccounts, type PaymentAccountDetails, type ProviderAccountView, type Readiness } from "@bukalaris/db";
import Link from "next/link";
import { checkProviderNowAction, removeProviderKeyAction, savePaymentDetailsAction, saveProviderKeyAction } from "./actions";
import { checkLabel, environmentLabel, gapLabel, providerName, savedLabel } from "./labels";

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
  const data = await sellerProviderAccounts(scope);
  const savedKey = typeof saved === "string" ? saved : undefined;
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader title="Akun penyedia" description="Hubungkan akun Mengantar dan AutoLaris milik toko Anda. Uang pembeli dan uang COD masuk langsung ke akun Anda; Bukalaris tidak memegangnya." />
      <Notice error={error} saved={savedKey} savedText={savedKey ? savedLabel[savedKey] : undefined} />

      <dl className="grid gap-3 sm:grid-cols-2" data-testid="readiness">
        <ReadinessCard testId="readiness-payment" title="Pembayaran QRIS/VA" readiness={data.readiness.qrisVa} />
        <ReadinessCard testId="readiness-shipping" title="Pengiriman dan COD" readiness={data.readiness.shipping} />
      </dl>
      <p className="-mt-3 text-xs text-muted-foreground" data-testid="readiness-open">
        {data.readiness.canOpen ? "Toko punya setidaknya satu cara bayar yang siap." : "Toko butuh setidaknya satu cara bayar yang siap sebelum bisa dibuka."} Produk fisik hanya bisa diaktifkan saat pengiriman siap.
      </p>

      <ProviderSection account={data.autolaris} title="Pembayaran · AutoLaris" intro="Kunci API H2H dari AutoLaris untuk QRIS dan virtual account. Minta profil khusus pembayaran ke AutoLaris, lalu masukkan kuncinya di sini." />
      <DetailsForm details={data.details} connected={data.autolaris.connected || data.details !== null} />
      <ProviderSection account={data.mengantar} title="Pengiriman · Mengantar" intro="Kunci API dari akun Mengantar baru yang khusus dipakai toko ini. Ongkir, pemesanan kurir dan pelacakan berjalan di akun Anda." />
      <p className="text-xs text-muted-foreground">
        Tidak ada kolom alamat server: Bukalaris memakai alamat resmi penyedia sesuai lingkungan yang Anda pilih. Area dan alamat pickup diatur di <Link href="/seller/shipping" className="underline underline-offset-4">Pengiriman</Link>.
      </p>
    </section>
  );
}

function ReadinessCard({ title, readiness, testId }: { title: string; readiness: Readiness; testId: string }) {
  return (
    <div className="grid content-start gap-1.5 rounded-lg border p-4" data-testid={testId}>
      <dt className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-muted-foreground">
        {title}
        <StatusBadge label={readiness.ready ? "Siap" : "Belum siap"} tone={readiness.ready ? "success" : "warning"} />
      </dt>
      {readiness.missing.map((gap) => (
        <dd key={gap} className="text-sm">{gapLabel[gap]}</dd>
      ))}
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
