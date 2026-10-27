import type { BlockType, LpAccent, LpFontScale } from "@bukalaris/db";

// Indonesian labels for the builder's enums (one place, like lib/status.ts for the admin enums).
export const blockLabel: Record<BlockType, string> = {
  hero: "Hero (judul utama)",
  text: "Teks",
  image: "Gambar",
  benefits: "Daftar manfaat",
  testimonials: "Testimoni",
  faq: "Pertanyaan umum (FAQ)",
  cta: "Tombol ajakan",
  order: "Bagian pemesanan",
};
export const blockHint: Record<BlockType, string> = {
  hero: "Judul besar, kalimat pendukung, gambar utama dan tombol menuju bagian pemesanan.",
  text: "Paragraf bebas dengan format ringan (# judul, - daftar, **tebal**, [tautan](https://…)).",
  image: "Satu gambar dari foto produk toko, dengan keterangan opsional.",
  benefits: "Poin-poin keunggulan produk, maksimal 8.",
  testimonials: "Kutipan pembeli (teks saja), maksimal 8.",
  faq: "Pertanyaan yang bisa dibuka-tutup, maksimal 12.",
  cta: "Tombol yang menggulir ke bagian pemesanan.",
  order: "Komponen pemesanan Bukalaris: pilihan varian dan jumlah, lalu checkout. Satu per halaman.",
};
export const accentLabel: Record<LpAccent, string> = { ink: "Hitam", teal: "Toska", emerald: "Hijau", amber: "Kuning", rose: "Merah muda", indigo: "Biru" };
export const fontScaleLabel: Record<LpFontScale, string> = { compact: "Ringkas", regular: "Normal", large: "Besar" };
