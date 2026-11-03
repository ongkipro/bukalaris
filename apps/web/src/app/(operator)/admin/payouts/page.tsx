import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { payoutStatusLabel, payoutStatusTone, refundStatusLabel, refundStatusTone } from "@/lib/finance";
import { rupiah, tanggal } from "@/lib/format";
import { payoutFreeze, transferQueue, type TransferKind } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../access-denied";
import { setFreezeAction } from "./actions";

export const metadata = { title: "Pencairan dan refund" };

const OPEN = { payout: ["requested", "processing"], refund: ["pending", "processing"] } as const;
const DONE = { payout: ["paid", "rejected"], refund: ["completed", "failed"] } as const;
const SAVED: Record<string, string> = { frozen: "Pembekuan penarikan dinyalakan.", unfrozen: "Pembekuan penarikan dicabut." };

export default async function PayoutsPage({ searchParams }: PageProps<"/admin/payouts">) {
  const g = await consoleGate("/admin/payouts");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { error, saved, kind: rawKind, view: rawView } = await searchParams;
  const canPayout = g.caps.includes("payouts.process");
  const canRefund = g.caps.includes("refunds.process");
  const kind: TransferKind = rawKind === "refund" ? (canRefund ? "refund" : "payout") : canPayout ? "payout" : "refund";
  const view = rawView === "done" ? "done" : "open";
  const rows = await allowed(transferQueue(g.op, kind, (view === "open" ? OPEN : DONE)[kind]));
  const freeze = canPayout ? await payoutFreeze(g.op.exec) : null;
  const label = kind === "payout" ? payoutStatusLabel : refundStatusLabel;
  const tone = kind === "payout" ? payoutStatusTone : refundStatusTone;
  const tab = (k: TransferKind, v: string, text: string) => (
    <Link href={`/admin/payouts?kind=${k}&view=${v}`} aria-current={k === kind && v === view ? "page" : undefined} className={`inline-flex min-h-10 items-center border-b-2 px-1 text-sm ${k === kind && v === view ? "border-current font-medium" : "border-transparent opacity-70 hover:opacity-100"}`}>
      {text}
    </Link>
  );
  return (
    <section className="grid gap-6">
      <PageHeader title="Pencairan dan refund" description="Permintaan penarikan seller dan refund pembeli (non-COD). Persetujuan transfer butuh orang kedua; nomor rekening hanya tampil di halaman rincian dan setiap tampilannya tercatat." />
      <Notice error={error} saved={typeof saved === "string" ? saved : undefined} savedText={typeof saved === "string" ? SAVED[saved] : undefined} />
      {freeze && (
        <form action={setFreezeAction} className={`grid gap-2 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end ${freeze.frozen ? "border-destructive/50 bg-destructive/5" : ""}`} data-testid="payout-freeze" aria-label="Pembekuan penarikan setelah pemulihan data">
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="freeze-reason">Alasan ({freeze.frozen ? "pencabutan" : "pembekuan"})</Label>
              <StatusBadge label={freeze.frozen ? "Dibekukan" : "Berjalan normal"} tone={freeze.frozen ? "destructive" : "success"} />
            </div>
            <Input id="freeze-reason" name="reason" required minLength={5} maxLength={500} />
            <p className="text-xs text-muted-foreground">
              Status: <strong data-testid="freeze-state">{freeze.frozen ? "DIBEKUKAN" : "berjalan"}</strong>
              {freeze.reason && freeze.reason !== "initial" && <> · {freeze.reason}</>}. Saat dibekukan: tidak ada permintaan penarikan baru, persetujuan, klaim, pencatatan transfer atau pelepasan rekonsiliasi COD. Dipakai setelah pemulihan data sampai bukti bank dicocokkan.
            </p>
          </div>
          <input type="hidden" name="frozen" value={freeze.frozen ? "0" : "1"} />
          <SubmitButton variant={freeze.frozen ? "default" : "destructive"} pendingText="Menyimpan…">{freeze.frozen ? "Cabut pembekuan" : "Bekukan penarikan"}</SubmitButton>
        </form>
      )}
      <nav aria-label="Antrean" className="flex flex-wrap gap-x-4 border-b">
        {canPayout && tab("payout", "open", "Penarikan seller · berjalan")}
        {canRefund && tab("refund", "open", "Refund pembeli · berjalan")}
        {canPayout && tab("payout", "done", "Penarikan · selesai")}
        {canRefund && tab("refund", "done", "Refund · selesai")}
      </nav>
      {rows === undefined ? (
        <AccessDenied capability={kind === "payout" ? "payouts.process" : "refunds.process"} />
      ) : rows.length === 0 ? (
        <EmptyState title={view === "open" ? "Tidak ada yang menunggu" : "Belum ada yang selesai"}>Antrean ini terisi saat seller meminta penarikan atau pembeli berhak atas refund.</EmptyState>
      ) : (
        <ul className="grid gap-2" aria-label="Antrean" data-testid="transfer-queue">
          {rows.map((r) => (
            <li key={r.id} className="grid gap-1 rounded-lg border p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center" data-testid={`${kind}-${r.id}`}>
              <div className="min-w-0 grid gap-0.5">
                <Link href={`/admin/payouts/${kind}/${r.id}`} className="font-medium underline underline-offset-4">{kind === "payout" ? "Penarikan" : "Refund"} #{r.id} · {r.storeName}</Link>
                <span className="text-muted-foreground">
                  {r.orderId ? <>pesanan #{r.orderId} · </> : null}
                  {r.accountLast4 ? <>{r.bank} ••••{r.accountLast4}</> : <>belum ada rekening tujuan</>}
                  {r.holderCheck === "mismatch" && " · nama pemilik berbeda"}
                  {" · "}<time dateTime={new Date(r.createdAt).toISOString()}>{tanggal(new Date(r.createdAt))}</time>
                  {r.transferUnknownAt && " · HASIL TRANSFER BELUM DIKETAHUI"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <span className="font-medium tabular-nums">{rupiah(r.amountIdr)}</span>
                {r.holderCheck === "mismatch" && <StatusBadge label="Nama berbeda" tone="warning" />}
                {r.transferUnknownAt && <StatusBadge label="Hasil belum diketahui" tone="destructive" />}
                <StatusBadge label={label[r.status] ?? r.status} tone={tone[r.status] ?? "secondary"} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
