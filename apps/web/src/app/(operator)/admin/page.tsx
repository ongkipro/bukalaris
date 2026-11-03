import { PageHeader } from "@/components/page-header";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { consoleDashboard, type PlatformCapability } from "@bukalaris/db";
import Link from "next/link";
import type { ReactNode } from "react";
import { AccessDenied } from "./access-denied";

// A layout's title template applies to child segments only, so the dashboard (same segment as the layout) names itself in full.
export const metadata = { title: { absolute: "Ringkasan — Bukalaris Owner" } };

// Cards of the planned sources. They are listed, with the capability that will gate them, so an operator sees what is not
// built yet instead of a zero (UX-22 SA-14: "no data yet" is never rendered as 0).
const PLANNED: { capability: PlatformCapability; title: string; href: string }[] = [
  { capability: "billing.read", title: "Pendapatan langganan", href: "/admin/billing" },
  { capability: "finance.read", title: "Saldo penjual dan kewajiban", href: "/admin/money" },
  { capability: "payouts.process", title: "Antrean pencairan dan refund", href: "/admin/payouts" },
  { capability: "cases.read", title: "Kasus terbuka", href: "/admin/cases" },
  { capability: "tenants.read", title: "Bendera risiko toko", href: "/admin/risk" },
];

function Card({ title, children, href, testId }: { title: string; children: ReactNode; href?: string; testId: string }) {
  return (
    <section aria-labelledby={`${testId}-t`} data-testid={testId} className="grid content-start gap-1 border-t pt-3">
      <h2 id={`${testId}-t`} className="text-sm font-medium text-muted-foreground">
        {href ? <Link href={href} className="underline-offset-4 hover:underline">{title}</Link> : title}
      </h2>
      {children}
    </section>
  );
}
const Unavailable = ({ text = "Belum tersedia" }: { text?: string }) => <p className="text-sm text-muted-foreground">{text}</p>;

export default async function AdminDashboardPage() {
  const g = await consoleGate("/admin");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const d = await allowed(consoleDashboard(g.op));
  if (d === undefined) return <AccessDenied capability="dashboard.read" />;
  const planned = PLANNED.filter((p) => d.caps.includes(p.capability));
  return (
    <section className="grid gap-6">
      <PageHeader title="Ringkasan" description={<>Angka dibaca langsung dari sumbernya, per <time dateTime={d.asOf.toISOString()}>{tanggal(d.asOf)}</time>. Kartu tanpa sumber tertulis &ldquo;Belum tersedia&rdquo;, bukan 0.</>} />
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
        {d.stores.state !== "hidden" && (
          <Card title="Toko" href="/admin/stores" testId="card-stores">
            {d.stores.state === "error" ? (
              <Unavailable text="Sumber toko tidak dapat dibaca. Ini bukan berarti 0." />
            ) : (
              <>
                <p className="text-2xl font-bold tabular-nums">{d.stores.data.total}</p>
                <p className="text-sm text-muted-foreground tabular-nums">
                  {d.stores.data.active} aktif + {d.stores.data.suspended} ditangguhkan = {d.stores.data.total} toko
                </p>
              </>
            )}
          </Card>
        )}
        {d.approvals.state !== "hidden" && (
          <Card title="Persetujuan menunggu" href="/admin/approvals" testId="card-approvals">
            {d.approvals.state === "error" ? (
              <Unavailable text="Sumber persetujuan tidak dapat dibaca." />
            ) : (
              <>
                <p className="text-2xl font-bold tabular-nums">{d.approvals.data.pending}</p>
                <p className="text-sm text-muted-foreground">{d.approvals.data.oldest ? <>Tertua sejak <time dateTime={d.approvals.data.oldest.toISOString()}>{tanggal(d.approvals.data.oldest)}</time></> : "Tidak ada yang menunggu."}</p>
              </>
            )}
          </Card>
        )}
        {d.jobs.state !== "hidden" && (
          <Card title="Pekerjaan gagal" href="/admin/ops" testId="card-jobs">
            {d.jobs.state === "error" ? (
              <Unavailable text="Sumber pekerjaan tidak dapat dibaca." />
            ) : (
              <>
                <p className="text-2xl font-bold tabular-nums">{d.jobs.data.dead + d.jobs.data.unknown}</p>
                <p className="text-sm text-muted-foreground tabular-nums">{d.jobs.data.dead} gagal permanen, {d.jobs.data.unknown} hasil belum diketahui</p>
              </>
            )}
          </Card>
        )}
        {d.issues.state !== "hidden" && (
          <Card title="Masalah terbuka per halaman" href="/admin/issues" testId="card-issues">
            {d.issues.state === "error" ? (
              <Unavailable text="Sumber laporan tidak dapat dibaca." />
            ) : d.issues.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">Belum ada laporan terbuka.</p>
            ) : (
              <ul className="grid gap-1 text-sm tabular-nums">
                {d.issues.data.map((r) => (
                  <li key={r.pageId}><Link className="underline underline-offset-4" href={`/admin/issues?pageId=${r.pageId}`}><span className="font-mono">{r.pageId}</span> · {r.open} laporan</Link></li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {planned.map((p) => (
          <Card key={p.title} title={p.title} href={p.href} testId={`card-planned-${p.capability.replace(/\./g, "-")}`}>
            <Unavailable text="Belum tersedia di kartu ringkasan — buka halaman untuk data langsung." />
          </Card>
        ))}
      </div>
      {d.stores.state === "hidden" && d.approvals.state === "hidden" && d.jobs.state === "hidden" && d.issues.state === "hidden" && planned.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">Izin Anda saat ini tidak membuka kartu ringkasan apa pun. Menu di atas hanya menampilkan halaman yang boleh Anda buka.</p>
      )}
    </section>
  );
}
