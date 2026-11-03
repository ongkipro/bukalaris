import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { consoleGate } from "@/lib/console-gate";
import { consoleSettings } from "@bukalaris/db";
import { RESERVED_HOST_LABEL_LIST } from "@bukalaris/db/host";
import { AccessDenied } from "../access-denied";

export const metadata = { title: "Pengaturan platform" };

/** Labels that are reserved for the platform. `berkah` and `bos` are retired, kept reserved so no store can claim them (T-70). */
const RETIRED = new Set(["berkah", "bos"]);
const ACTIVE_SURFACE = new Set(["owner", "app", "checkout", "affiliate", "buyer", "logs"]);

export default async function SettingsPage() {
  const g = await consoleGate("/admin/settings");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const s = await consoleSettings(g.op);
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader title="Pengaturan platform" description="Hanya baca. Host, domain, dan label diubah lewat deployment; tidak ada saklar fitur di sini." />
      <section aria-labelledby="host" className="grid gap-2">
        <h2 id="host" className="text-lg font-semibold">Host</h2>
        <p className="rounded-lg border p-4 text-sm">Domain induk toko: <span className="font-mono font-medium">{s.rootDomain ?? "belum dikonfigurasi"}</span>. Status DNS dan TLS tidak diperiksa dari konsol ini.</p>
      </section>
      <section aria-labelledby="labels" className="grid gap-2">
        <h2 id="labels" className="text-lg font-semibold">Label host yang dicadangkan</h2>
        <ul className="grid gap-2 rounded-lg border p-4 text-sm sm:grid-cols-2">
          {RESERVED_HOST_LABEL_LIST.map((label) => (
            <li key={label} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-1.5">
              <span className="font-mono font-medium">{label}</span>
              <Badge variant={RETIRED.has(label) ? "secondary" : ACTIVE_SURFACE.has(label) ? "default" : "outline"}>
                {RETIRED.has(label) ? "dipensiunkan, tetap dicadangkan" : ACTIVE_SURFACE.has(label) ? "permukaan aktif" : "infrastruktur"}
              </Badge>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="rate" className="grid gap-2">
        <h2 id="rate" className="text-lg font-semibold">Batas laju</h2>
        <dl className="divide-y rounded-lg border text-sm">
          {s.rateLimits.map((r) => (
            <div key={r.key} className="grid gap-1 p-3 sm:grid-cols-[16rem_minmax(0,1fr)] sm:gap-4">
              <dt className="font-mono font-medium">{r.key}</dt>
              <dd className="text-muted-foreground">{r.policy}</dd>
            </div>
          ))}
        </dl>
      </section>
    </section>
  );
}
