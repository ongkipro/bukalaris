import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { consoleGate } from "@/lib/console-gate";
import { tanggal } from "@/lib/format";
import { log } from "@/lib/log";
import type { Tone } from "@/lib/status";
import { approvalInbox, type InboxItem, type InboxTab } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../access-denied";
import { decideApprovalAction } from "./actions";

export const metadata = { title: "Persetujuan" };

const TABS: [InboxTab, string][] = [
  ["waiting", "Menunggu saya"],
  ["mine", "Permintaan saya"],
  ["decided", "Sudah diputuskan"],
];
const STATUS: Record<string, [string, Tone]> = {
  pending: ["Menunggu orang kedua", "warning"],
  approved: ["Disetujui, belum dijalankan", "default"],
  executed: ["Sudah dijalankan", "success"],
  rejected: ["Ditolak", "destructive"],
  expired: ["Kedaluwarsa", "secondary"],
  cancelled: ["Dibatalkan", "secondary"],
};
const ACTION_LABEL: Record<string, string> = {
  "payout.approve_transfer": "Persetujuan transfer pencairan seller",
  "payout.reject_processing": "Penolakan pencairan sedang diproses",
  "refund.approve_transfer": "Persetujuan transfer refund pembeli",
  "refund.fail": "Pernyataan refund gagal",
  "cod.reconcile_release": "Pelepasan batch rekonsiliasi COD",
  "cod.manual_complete": "Penyelesaian manual pesanan pengiriman",
  "ledger.adjust": "Penyesuaian manual buku besar",
  "shipping.margin": "Perubahan margin atau diskon ongkir",
  "billing.comp": "Pemberian masa aktif gratis (comp)",
  "billing.mark_paid": "Pencatatan tagihan lunas manual",
  "billing.plan_price": "Perubahan harga paket langganan",
  "grant.sensitive": "Pemberian izin sensitif staf",
  "breakglass.approve": "Pemberian akses darurat (break-glass)",
  "mfa.reset": "Reset verifikasi dua langkah pemilik toko",
  "staff.mfa_reset": "Reset verifikasi dua langkah staf",
};
const TRANSFER_ACTIONS: Record<string, true> = { "payout.approve_transfer": true, "refund.approve_transfer": true, "affiliate_payout.approve_transfer": true };
export default async function ApprovalsPage({ searchParams }: PageProps<"/admin/approvals">) {
  const g = await consoleGate("/admin/approvals");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { error, saved, tab: rawTab } = await searchParams;
  const tab: InboxTab = TABS.some(([t]) => t === rawTab) ? (rawTab as InboxTab) : "waiting";
  let items: InboxItem[] | null = null;
  try {
    items = await approvalInbox(g.op, tab);
  } catch (err) {
    await log("error", "approval source unavailable", { module: "admin.approvals", operation: "approvalInbox", error_name: err instanceof Error ? err.name : "unknown" });
  }
  return (
    <section className="grid gap-6">
      <PageHeader title="Persetujuan" description="Tindakan sensitif butuh orang kedua. Anda menyetujui teks persis yang tampil di sini; jika isinya berubah, persetujuan tidak berlaku." />
      <Notice error={error} saved={saved} savedText="Keputusan tersimpan. Tindakan dijalankan oleh pemohon." />
      <nav aria-label="Daftar persetujuan" className="flex flex-wrap gap-x-4 border-b">
        {TABS.map(([t, label]) => (
          <Link key={t} href={t === "waiting" ? "/admin/approvals" : `/admin/approvals?tab=${t}`} aria-current={t === tab ? "page" : undefined} className={`inline-flex min-h-10 items-center border-b-2 px-1 text-sm ${t === tab ? "border-current font-medium" : "border-transparent opacity-70 hover:opacity-100"}`}>
            {label}
          </Link>
        ))}
      </nav>
      {items === null ? (
        <p role="alert" className="rounded-lg border border-destructive/40 p-6">
          <strong className="block">Sumber persetujuan tidak tersedia.</strong>Ini bukan berarti tidak ada permintaan. Coba muat ulang beberapa saat lagi.
        </p>
      ) : items.length === 0 ? (
        <EmptyState title={tab === "waiting" ? "Tidak ada persetujuan yang menunggu Anda" : tab === "mine" ? "Anda belum membuat permintaan" : "Belum ada keputusan"}>
          {tab === "waiting" ? "Permintaan dari staf lain yang memakai izin yang sama dengan Anda muncul di sini." : "Daftar ini terisi saat ada permintaan persetujuan."}
        </EmptyState>
      ) : (
        <ul className="grid gap-4">
          {items.map((a) => {
            const [label, tone] = STATUS[a.status] ?? [a.status, "secondary" as Tone];
            return (
              <li key={a.id} className="grid gap-3 rounded-lg border p-4" data-testid={`approval-${a.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="grid gap-0.5">
                    <h2 className="text-base font-semibold">
                      {ACTION_LABEL[a.actionKey] ? `${ACTION_LABEL[a.actionKey]} · ` : ""}
                      <span className="font-mono text-sm">{a.actionKey}</span> · {a.targetKind} <span className="font-mono text-sm">{a.targetId}</span>
                    </h2>
                  </div>
                  <StatusBadge label={label} tone={tone} />
                </div>
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
                  <dt className="text-muted-foreground">Pemohon</dt>
                  <dd className="font-mono break-all">{a.own ? "Anda (pemohon)" : a.requestedBy}</dd>
                  <dt className="text-muted-foreground">Alasan pemohon</dt>
                  <dd className="break-words">{a.reason}</dd>
                  <dt className="text-muted-foreground">Diminta</dt>
                  <dd><time dateTime={a.createdAt.toISOString()}>{tanggal(a.createdAt)}</time></dd>
                  <dt className="text-muted-foreground">Berlaku sampai</dt>
                  <dd><time dateTime={a.expiresAt.toISOString()}>{tanggal(a.expiresAt)}</time></dd>
                  <dt className="text-muted-foreground">Izin yang dibutuhkan</dt>
                  <dd className="font-mono">{a.capability}</dd>
                </dl>
                <div className="grid gap-1">
                  <p className="text-sm font-medium">Isi yang disetujui (teks kanonis persis)</p>
                  <pre data-testid="payload" className="max-h-56 overflow-auto rounded-md border bg-muted/40 p-2.5 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{a.payloadCanonical}</pre>
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    SHA-256: <span className="font-mono">{a.payloadSha256}</span>
                    {TRANSFER_ACTIONS[a.actionKey] && " · Pembacaan rincian rekening di atas tercatat sebagai akses data pribadi (PRIV-9)."}
                  </p>
                </div>
                {a.status === "pending" && tab !== "mine" && (
                  a.own ? (
                    <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground" data-testid="own-note">
                      Anda pemohon permintaan ini, jadi tidak bisa menyetujuinya sendiri. Orang kedua yang memegang izin <code>{a.capability}</code> harus memeriksa teks di atas dan memutuskan.
                    </p>
                  ) : (
                    <form className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
                      <div className="grid gap-1.5">
                        <Label htmlFor={`reason-${a.id}`}>Alasan keputusan (wajib)</Label>
                        <Input id={`reason-${a.id}`} name="reason" required minLength={5} maxLength={500} aria-describedby={`stepup-${a.id}`} />
                      </div>
                      <SubmitButton formAction={decideApprovalAction.bind(null, a.id, "approve")} pendingText="Menyimpan…">Setujui</SubmitButton>
                      <SubmitButton formAction={decideApprovalAction.bind(null, a.id, "reject")} variant="outline" pendingText="Menyimpan…">Tolak</SubmitButton>
                      <p id={`stepup-${a.id}`} className="text-xs text-muted-foreground sm:col-span-3">
                        Keputusan ini membutuhkan verifikasi dua langkah yang segar di sesi ini (5 menit terakhir) dan mengikat hash SHA-256 di atas.
                      </p>
                    </form>
                  )
                )}
                {a.status === "pending" && tab === "mine" && (
                  <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                    Menunggu orang kedua. Jangan dianggap berhasil sebelum disetujui dan dijalankan.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
