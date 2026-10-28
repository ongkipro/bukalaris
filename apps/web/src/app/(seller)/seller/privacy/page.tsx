import { ConfirmSubmit } from "@/components/confirm-submit";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { sellerScope } from "@/lib/context";
import { rupiah, tanggal } from "@/lib/format";
import { orderStatusLabel, orderStatusTone, paymentShortLabel } from "@/lib/status";
import { can, CLOSED_STATUSES, DomainError, findBuyerOrders, REDACTED } from "@bukalaris/db";
import Link from "next/link";
import { redactAction, redactSessionsAction } from "./actions";

export const metadata = { title: "Data pembeli — Bukalaris" };

// T-43 (SEC-19, PRIV-4): owner-only mechanism to locate one buyer's data in this store, hand it
// over as JSON, and irreversibly redact the contact fields of chosen orders. Legal applicability
// is the privacy owner's call (docs/13-COMPLIANCE-PRIVACY.md); this page only executes it.

type Found = Awaited<ReturnType<typeof findBuyerOrders>>;

export default async function SellerPrivacyPage({ searchParams }: PageProps<"/seller/privacy">) {
  const { error, saved, q, sessions } = await searchParams;
  const scope = await sellerScope();
  const manage = can(scope, "privacy.manage");
  const keyword = typeof q === "string" ? q.trim() : "";
  let found: Found | undefined;
  let searchError: string | undefined;
  if (manage && keyword) {
    try {
      found = await findBuyerOrders(scope, keyword);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      searchError = err.message;
    }
  }
  const open = found?.orders.filter((o) => !CLOSED_STATUSES.includes(o.status)) ?? [];
  const savedCount = typeof saved === "string" ? Number(saved) : NaN;

  return (
    <section className="grid max-w-4xl gap-6">
      <PageHeader
        title="Data pembeli"
        description={
          manage
            ? "Cari pembeli dengan nomor HP atau email untuk mengekspor datanya di toko ini atau menghapus data kontak dari pesanan tertentu. Nominal, item, dan status pesanan tetap tersimpan."
            : "Hanya pemilik toko yang dapat mengekspor atau menghapus data pembeli."
        }
      />
      <Notice
        error={error}
        saved={Number.isFinite(savedCount) ? saved : undefined}
        savedText={
          sessions === "1"
            ? `Kontak yang diketik pembeli di ${savedCount} keranjang tertinggal dihapus permanen.`
            : savedCount > 0
              ? `Data kontak ${savedCount} pesanan dihapus permanen. Pesanan itu tidak lagi muncul dalam pencarian ini.`
              : "Tidak ada pesanan baru yang dihapus — semua sudah dihapus sebelumnya."
        }
      />

      {!manage && <p role="note" className="text-sm text-muted-foreground">Minta pemilik toko bila ada permintaan pembeli terkait datanya.</p>}

      {manage && (
        <>
          <form method="get" action="/seller/privacy" className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor="q">Nomor HP atau email pembeli</Label>
              <Input
                id="q"
                name="q"
                defaultValue={keyword}
                required
                minLength={5}
                maxLength={254}
                autoComplete="off"
                placeholder="mis. 0812… atau nama@contoh.com"
                aria-describedby={searchError ? "q-error" : "q-help"}
                aria-invalid={searchError ? true : undefined}
              />
              {!searchError && <p id="q-help" className="text-xs text-muted-foreground">Penulisan +62, 62, dan 0 dianggap sama. Pencarian hanya mencakup pesanan toko ini.</p>}
            </div>
            <Button type="submit" variant="outline">Cari</Button>
          </form>
          {searchError && <p id="q-error" role="alert" className="text-sm text-destructive">{searchError}</p>}

          {found && found.orders.length === 0 && found.sessions === 0 && (
            <EmptyState title={`Tidak ada pesanan untuk ${found.key.kind === "phone" ? "nomor" : "email"} ini di toko ini.`} data-testid="privacy-empty">
              Data pembeli yang sudah dihapus tidak dapat dicari lagi. Periksa penulisan nomor atau email.
            </EmptyState>
          )}

          {found && found.orders.length > 0 && (
            <form action={redactAction} className="grid gap-4" data-testid="privacy-results">
              <input type="hidden" name="q" value={keyword} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {found.orders.length} pesanan dengan {found.key.kind === "phone" ? "nomor" : "email"} <span className="font-mono">{found.key.value}</span>.
                </p>
                <a href={`/seller/privacy/export?q=${encodeURIComponent(keyword)}`} download className={buttonVariants({ variant: "outline", size: "sm" })} data-testid="privacy-export">
                  Unduh JSON
                </a>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"><span className="sr-only">Pilih</span></TableHead>
                    <TableHead>Pesanan</TableHead>
                    <TableHead>Waktu</TableHead>
                    <TableHead>Pembeli</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead numeric>Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {found.orders.map((o) => (
                    <TableRow key={o.id} data-testid={`privacy-order-${o.id}`}>
                      <TableCell>
                        <input type="checkbox" name="orderId" value={o.id} aria-label={`Pilih pesanan #${o.id}`} className="size-4 accent-foreground" />
                      </TableCell>
                      <TableCell>
                        <Link href={`/seller/orders/${o.id}`} className="font-mono text-xs font-medium tabular-nums underline-offset-4 hover:underline">#{o.id}</Link>
                        <span className="ml-1 text-xs text-muted-foreground">{paymentShortLabel[o.paymentMethod]}</span>
                      </TableCell>
                      <TableCell className="text-muted-foreground"><time dateTime={o.createdAt.toISOString()}>{tanggal(o.createdAt)}</time></TableCell>
                      <TableCell>{o.buyerName}</TableCell>
                      <TableCell><StatusBadge label={orderStatusLabel[o.status]} tone={orderStatusTone[o.status]} /></TableCell>
                      <TableCell numeric>{rupiah(o.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <fieldset className="grid gap-3 rounded-lg border border-destructive/30 p-4" data-testid="privacy-redact">
                <legend className="px-1 text-sm font-medium">Hapus data kontak pesanan terpilih</legend>
                <p className="text-sm text-muted-foreground">
                  Nama, nomor HP, alamat, dan email diganti menjadi <span className="font-mono">{REDACTED}</span>; konteks iklan dan isi email pesanan ikut dihapus. Nominal, item, status, dan resi tetap ada. Tindakan ini
                  permanen dan tercatat di audit.
                </p>
                {open.length > 0 && (
                  <div className="grid gap-2 text-sm">
                    <label className="flex items-start gap-2">
                      <input type="checkbox" name="override" className="mt-0.5 size-4 accent-foreground" />
                      <span>
                        Tetap hapus pesanan yang belum selesai/dibatalkan (#{open.map((o) => o.id).join(", #")}). Tanpa ini, pesanan yang masih berjalan ditolak.
                      </span>
                    </label>
                    <div className="grid gap-1">
                      <Label htmlFor="reason">Alasan (wajib bila tetap hapus)</Label>
                      <Textarea id="reason" name="reason" rows={2} minLength={5} maxLength={500} placeholder="mis. permintaan pembeli lewat WhatsApp pada 7 Okt" />
                    </div>
                  </div>
                )}
                <ConfirmSubmit variant="destructive" size="sm" className="justify-self-start" message="Hapus data kontak pesanan terpilih secara permanen? Tindakan ini tidak bisa dibatalkan.">
                  Hapus data terpilih
                </ConfirmSubmit>
              </fieldset>
            </form>
          )}

          {found && found.sessions > 0 && (
            <form action={redactSessionsAction} className="grid gap-3 rounded-lg border p-4" data-testid="privacy-sessions">
              <input type="hidden" name="q" value={keyword} />
              <p className="text-sm">
                {found.sessions} keranjang tertinggal masih menyimpan {found.key.kind === "phone" ? "nomor" : "email"} ini (yang diketik pembeli di checkout sebelum memesan). Data ini ikut diekspor dan otomatis dihapus 30 hari setelah dibuat.
              </p>
              <div className="flex flex-wrap gap-2">
                {found.orders.length === 0 && (
                  <a href={`/seller/privacy/export?q=${encodeURIComponent(keyword)}`} download className={buttonVariants({ variant: "outline", size: "sm" })} data-testid="privacy-export-sessions">
                    Unduh JSON
                  </a>
                )}
                <ConfirmSubmit variant="destructive" size="sm" message="Hapus kontak di keranjang tertinggal ini secara permanen? Tindakan ini tidak bisa dibatalkan.">
                  Hapus kontak keranjang tertinggal
                </ConfirmSubmit>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
