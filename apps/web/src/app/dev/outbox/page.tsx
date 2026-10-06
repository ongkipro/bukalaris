import { db, listOutbox } from "@bukalaris/db";
import { notFound } from "next/navigation";

export const metadata = { title: "Dev outbox — Bukalaris" };
export const dynamic = "force-dynamic";

/** Local mail viewer. Hidden in production unless DEV_OUTBOX=1 is set explicitly (the links carry tokens). */
export default async function DevOutboxPage() {
  if (process.env.NODE_ENV === "production" && process.env.DEV_OUTBOX !== "1") notFound();
  const mails = await listOutbox(db());
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
      <h1 className="text-2xl font-semibold">Dev outbox</h1>
      <p className="mb-4 text-sm text-muted-foreground">Email keluar disimpan di tabel <code>mail_outbox</code>; tidak ada yang dikirim. {mails.length} terbaru.</p>
      {mails.length === 0 && <p className="rounded-md border p-4 text-sm">Belum ada email.</p>}
      <ul className="grid gap-3">
        {mails.map((m) => (
          <li key={m.id} className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">
              #{m.id} · {m.createdAt.toISOString()} · kepada <span className="font-medium text-foreground">{m.toEmail}</span>
            </p>
            <h2 className="mt-1 font-medium">{m.subject}</h2>
            <pre className="mt-2 whitespace-pre-wrap break-all text-sm">{m.textBody}</pre>
          </li>
        ))}
      </ul>
    </main>
  );
}
