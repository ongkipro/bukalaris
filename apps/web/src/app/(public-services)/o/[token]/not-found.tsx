/** Expired, tampered or unknown order link (T-36): a plain 404 with a safe message, no detail about why. */
export default function OrderLinkNotFound() {
  return (
    <section className="grid gap-3 rounded-xl border bg-background p-6" aria-labelledby="link-invalid">
      <h1 id="link-invalid" className="text-2xl font-semibold tracking-tight">Tautan tidak berlaku</h1>
      <p className="text-muted-foreground">Tautan status pesanan ini tidak valid atau sudah kedaluwarsa. Gunakan tautan dari email terbaru Anda, atau hubungi penjual.</p>
    </section>
  );
}
