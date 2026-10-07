import { fieldClass, Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { sellerScope } from "@/lib/context";
import {
  can,
  destinationHealth,
  feedSettings,
  listDestinations,
  liveMode,
  SIGNAL_PROVIDERS,
  type DestinationHealth,
  type DestinationView,
  type FeedSettings,
  type SignalProvider,
} from "@bukalaris/db";
import { clearTokenAction, revokeFeedTokenAction, saveDestinationAction } from "./actions";
import { FeedTokenForm } from "./feed-token-form";

export const metadata = { title: "Pemasaran — Seller Admin" };

const COPY: Record<SignalProvider, { title: string; idLabel: string; idHint: string; tokenLabel: string | null; tokenHint: string }> = {
  meta: {
    title: "Meta (Facebook/Instagram)",
    idLabel: "Pixel ID",
    idHint: "Angka 5–20 digit dari Events Manager.",
    tokenLabel: "Access token Conversions API",
    tokenHint: "Dibuat di Events Manager → Settings → Conversions API. Disimpan terenkripsi, tidak pernah ditampilkan lagi.",
  },
  tiktok: {
    title: "TikTok",
    idLabel: "Pixel Code",
    idHint: "Huruf besar/angka dari TikTok Events Manager.",
    tokenLabel: "Access token Events API",
    tokenHint: "Dibuat di Events Manager → Settings → Generate Access Token. Disimpan terenkripsi.",
  },
  google: {
    title: "Google Ads",
    idLabel: "Google tag ID",
    idHint: "Format AW-1234567890. Konversi Purchase memakai label di bawah.",
    tokenLabel: null,
    tokenHint: "Google berjalan di browser saja (Google tag). Unggah konversi offline COD setelah pengiriman menyusul.",
  },
};
const fmt = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });

export default async function MarketingPage({ searchParams }: PageProps<"/seller/marketing">) {
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  if (!can(scope, "marketing.manage")) {
    return (
      <section className="grid gap-4">
        <h1 className="text-2xl font-semibold">Pemasaran</h1>
        <p role="note" className="rounded-lg border p-4 text-sm text-muted-foreground">Hanya pemilik toko yang dapat mengatur pixel iklan dan token server.</p>
      </section>
    );
  }
  const [destinations, health, feeds] = await Promise.all([listDestinations(scope), destinationHealth(scope), feedSettings(scope)]);
  const byProvider = new Map(destinations.map((d) => [d.provider, d]));
  const healthBy = new Map(health.map((h) => [h.provider, h]));
  return (
    <section className="grid gap-6">
      <div>
        <h1 className="mb-1 text-2xl font-semibold">Pemasaran</h1>
        <p className="text-sm text-muted-foreground">
          Sinyal konversi (lihat produk, tambah keranjang, mulai checkout, pembelian) dikirim dari browser pembeli dan dari server dengan ID event yang sama. Pembelian COD
          dihitung saat pesanan dibuat, transfer saat pembayaran ditandai lunas; nilainya subtotal barang tanpa ongkir.
        </p>
      </div>
      <Notice error={error} saved={saved} />
      {!liveMode() && (
        <p role="note" className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="signals-mode">
          Mode simulasi: event server dicatat tetapi belum dikirim ke penyedia sampai pengujian test event disetujui.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        {SIGNAL_PROVIDERS.map((p) => (
          <DestinationCard key={p} provider={p} current={byProvider.get(p)} health={healthBy.get(p)} />
        ))}
      </div>
      <FeedSection feeds={feeds} />
    </section>
  );
}

/** T-40: token-protected catalog feeds for Meta Commerce Manager and Google Merchant Center. */
function FeedSection({ feeds }: { feeds: FeedSettings }) {
  return (
    <article className="grid gap-4 rounded-lg border p-4" data-testid="feed-section" aria-labelledby="feed-title">
      <div className="grid gap-1">
        <h2 id="feed-title" className="font-medium">Feed katalog</h2>
        <p className="text-sm text-muted-foreground">
          Meta dan Google mengambil katalog toko dari URL feed secara terjadwal. Satu item per varian produk aktif: ID item = ID varian, ID grup = ID produk —
          sama dengan content id yang dikirim sinyal konversi, jadi iklan katalog dan event pembelian bertemu di produk yang sama.
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm tabular-nums" data-testid="feed-stats">
        <dt className="text-muted-foreground">Produk aktif dalam feed</dt>
        <dd className="text-right">{feeds.activeProducts - feeds.withoutImage}</dd>
        <dt className="text-muted-foreground">Aktif tanpa gambar (dilewati)</dt>
        <dd className={`text-right ${feeds.withoutImage ? "text-destructive" : ""}`}>{feeds.withoutImage}</dd>
      </dl>
      {feeds.withoutImage > 0 && (
        <p className="text-xs text-muted-foreground">Kedua platform mewajibkan gambar utama; unggah gambar di halaman produk agar produk itu ikut dalam feed.</p>
      )}
      {feeds.token ? (
        <p className="text-sm" data-testid="feed-token-state">
          Token aktif <code className="rounded bg-muted px-1 text-xs">blfd_{feeds.token.prefix}_…</code> dibuat {fmt.format(feeds.token.createdAt)}. URL feed hanya ditampilkan
          saat dibuat.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="feed-token-state">Belum ada token feed. Buat satu untuk mendapatkan URL feed Meta dan Google.</p>
      )}
      <div className="flex flex-wrap items-start gap-2">
        <FeedTokenForm hasToken={feeds.token !== null} />
        {feeds.token && (
          <form action={revokeFeedTokenAction}>
            <ConfirmSubmit variant="outline" message="Cabut token feed? Meta dan Google tidak bisa lagi mengambil katalog sampai Anda membuat token baru dan memperbaruinya di sana.">
              Cabut token feed
            </ConfirmSubmit>
          </form>
        )}
      </div>
    </article>
  );
}

function DestinationCard({ provider, current, health }: { provider: SignalProvider; current?: DestinationView; health?: DestinationHealth }) {
  const c = COPY[provider];
  const save = saveDestinationAction.bind(null, provider);
  const clear = clearTokenAction.bind(null, provider);
  return (
    <article className="grid content-start gap-4 rounded-lg border p-4" data-testid={`destination-${provider}`} aria-labelledby={`${provider}-title`}>
      <div className="flex items-start justify-between gap-2">
        <h2 id={`${provider}-title`} className="font-medium">{c.title}</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs ${current?.enabled ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}>
          {current?.enabled ? "Aktif" : "Nonaktif"}
        </span>
      </div>
      <form action={save} className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${provider}-pixelId`}>{c.idLabel}</Label>
          <Input id={`${provider}-pixelId`} name="pixelId" defaultValue={current?.pixelId ?? ""} required maxLength={40} autoComplete="off" aria-describedby={`${provider}-id-hint`} />
          <p id={`${provider}-id-hint`} className="text-xs text-muted-foreground">{c.idHint}</p>
        </div>
        {provider === "google" && (
          <div className="grid gap-1.5">
            <Label htmlFor="google-label">Label konversi Purchase</Label>
            <Input id="google-label" name="conversionLabel" defaultValue={current?.conversionLabel ?? ""} maxLength={60} autoComplete="off" />
          </div>
        )}
        {c.tokenLabel && (
          <div className="grid gap-1.5">
            <Label htmlFor={`${provider}-token`}>{c.tokenLabel}</Label>
            <input
              id={`${provider}-token`}
              name="token"
              type="password"
              autoComplete="new-password"
              maxLength={512}
              placeholder={current?.hasToken ? "Tersimpan — isi untuk mengganti" : "Tempel token"}
              className={fieldClass}
              aria-describedby={`${provider}-token-hint`}
            />
            <p id={`${provider}-token-hint`} className="text-xs text-muted-foreground">
              {c.tokenHint}
              {current?.tokenSetAt && <> Token terakhir disimpan {fmt.format(current.tokenSetAt)}.</>}
            </p>
          </div>
        )}
        {provider !== "google" && (
          <div className="grid gap-1.5">
            <Label htmlFor={`${provider}-test`}>Kode test event (opsional)</Label>
            <Input id={`${provider}-test`} name="testEventCode" defaultValue={current?.testEventCode ?? ""} maxLength={40} autoComplete="off" />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={current?.enabled ?? false} className="size-4 accent-foreground" />
          Aktifkan pengiriman event
        </label>
        <Button type="submit" className="justify-self-start">Simpan {c.title.split(" ")[0]}</Button>
      </form>
      {current?.hasToken && (
        <form action={clear}>
          <Button type="submit" variant="outline" size="sm">Hapus token server</Button>
        </form>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t pt-3 text-sm tabular-nums" aria-label={`Kesehatan 7 hari ${c.title}`} data-testid={`health-${provider}`}>
        <dt className="text-muted-foreground">Terkirim (7 hari)</dt>
        <dd className="text-right">{health?.sent ?? 0}</dd>
        <dt className="text-muted-foreground">Simulasi</dt>
        <dd className="text-right">{health?.simulated ?? 0}</dd>
        <dt className="text-muted-foreground">Menunggu</dt>
        <dd className="text-right">{health?.pending ?? 0}</dd>
        <dt className="text-muted-foreground">Gagal</dt>
        <dd className={`text-right ${health?.failed ? "text-destructive" : ""}`}>{health?.failed ?? 0}</dd>
        {health?.lastSentAt && (
          <>
            <dt className="text-muted-foreground">Terakhir diterima</dt>
            <dd className="text-right">{fmt.format(health.lastSentAt)}</dd>
          </>
        )}
      </dl>
      {health?.lastError && (
        <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive" role="status">Error terakhir: {health.lastError}</p>
      )}
    </article>
  );
}
