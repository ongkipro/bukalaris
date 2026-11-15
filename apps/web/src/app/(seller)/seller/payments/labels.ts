import type { Provider, ReadinessGap } from "@bukalaris/db";

// One Indonesian label per value of the provider-account screen (SC-32). The screen names Mengantar and AutoLaris on purpose: the seller
// connects their OWN accounts (ADR-0013 section 8).

export const providerName: Record<Provider, string> = { mengantar: "Mengantar", autolaris: "AutoLaris" };
export const environmentLabel = { sandbox: "Sandbox (uji coba)", production: "Produksi" } as const;
export const checkLabel: Record<string, string> = {
  ready: "Berhasil",
  AUTH_FAILED: "Kunci ditolak penyedia",
  PROVIDER_UNAVAILABLE: "Penyedia tidak bisa dihubungi",
  INVALID_RESPONSE: "Jawaban penyedia tidak terbaca",
};
export const gapLabel: Record<ReadinessGap, string> = {
  key: "Kunci API belum dihubungkan.",
  check: "Pengecekan terakhir gagal. Tekan Cek sekarang setelah masalahnya beres.",
  pickup_area: "Area pickup belum diatur di menu Pengiriman.",
  pickup_registered: "Alamat pickup belum terdaftar di akun Mengantar ini.",
  order_fields: "Data akun AutoLaris (ID area asal, ID area tujuan, e-mail pengirim) belum lengkap.",
  sender_address: "Alamat pengirim belum diisi.",
  payment_only: "Profil khusus pembayaran dari AutoLaris belum dikonfirmasi.",
};
export const savedLabel: Record<string, string> = {
  key: "Kunci lolos pengecekan dan tersimpan terkunci. Semua pemilik toko sudah diberi tahu lewat e-mail.",
  removed: "Kunci dihapus. Semua pemilik toko sudah diberi tahu lewat e-mail.",
  check: "Pengecekan berhasil: kunci tersimpan bisa dipakai.",
  details: "Data akun AutoLaris tersimpan.",
};
