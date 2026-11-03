import { tanggal } from "@/lib/format";
import { platformDb, listOutbox } from "@bukalaris/db";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

export const metadata = { title: "Dev outbox — Bukalaris" };
export const dynamic = "force-dynamic";

/** Local mail viewer. In production only with DEV_OUTBOX=1 AND a loopback request host (the links carry tokens; wave 2 review). */
export default async function DevOutboxPage() {
  if (process.env.NODE_ENV === "production") {
    let host = "";
    try { host = new URL(`http://${(await headers()).get("host") ?? ""}`).hostname; } catch { /* unparsable host: refused below */ }
    const loopback = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
    if (process.env.DEV_OUTBOX !== "1" || !loopback) notFound();
  }
  const mails = await listOutbox(platformDb());
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
      <h1 className="text-2xl font-semibold">Dev outbox</h1>
      <p className="mb-4 text-sm text-muted-foreground tabular-nums">Email keluar disimpan di tabel <code>mail_outbox</code>; tidak ada pengiriman jaringan. {mails.length} terbaru.</p>
      {mails.length === 0 && <p className="rounded-md border p-4 text-sm text-muted-foreground">Belum ada email keluar.</p>}
      <ul className="grid gap-3">
        {mails.map((m) => (
          <li key={m.id} className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground tabular-nums">
              #{m.id} · <time dateTime={m.createdAt.toISOString()}>{tanggal(m.createdAt)}</time> · kepada <span className="font-medium text-foreground">{m.toEmail}</span>
            </p>
            <h2 className="mt-1 font-medium">{m.subject}</h2>
            {m.bodiesPurgedAt && !m.textBody ? (
              <p className="mt-2 text-xs text-muted-foreground">Isi email sudah dihapus otomatis setelah pengiriman atau batas waktu tautan berakhir.</p>
            ) : (
              <pre className="mt-2 whitespace-pre-wrap wrap-anywhere rounded-md bg-muted/40 p-3 font-mono text-xs">{m.textBody}</pre>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
