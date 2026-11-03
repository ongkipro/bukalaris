/** Inside the store shell: a missing product/collection/page keeps the store navigation. */
export default function StoreNotFound() {
  return (
    <section className="mx-auto grid max-w-md gap-4 py-10 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">Halaman tidak ditemukan</h1>
      <p className="text-muted-foreground">Produk, koleksi atau halaman ini tidak ada atau belum dipublikasikan. Gunakan nama toko di atas untuk kembali ke beranda.</p>
    </section>
  );
}
