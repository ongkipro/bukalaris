export const metadata = { title: "Tautan checkout tidak berlaku — Bukalaris" };

/** Safe landing for an unknown, expired or already-used checkout handoff: no cart, no session. */
export default function InvalidHandoffPage() {
  return (
    <section role="alert" className="grid gap-2 rounded-lg border bg-background p-6">
      <h1 className="text-2xl font-semibold">Tautan checkout tidak berlaku</h1>
      <p className="text-sm text-muted-foreground">
        Tautan ini sudah dipakai, kedaluwarsa, atau keranjangnya sudah di-checkout. Kembali ke toko dan mulai checkout lagi.
      </p>
    </section>
  );
}
