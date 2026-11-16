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
  production_off: "Pembayaran produksi AutoLaris belum diaktifkan oleh Bukalaris. Pakai lingkungan sandbox untuk uji coba dulu.",
};
export const savedLabel: Record<string, string> = {
  key: "Kunci lolos pengecekan dan tersimpan terkunci. Semua pemilik toko sudah diberi tahu lewat e-mail.",
  removed: "Kunci dihapus. Semua pemilik toko sudah diberi tahu lewat e-mail.",
  check: "Pengecekan berhasil: kunci tersimpan bisa dipakai.",
  details: "Data akun AutoLaris tersimpan.",
  preferences: "Pengaturan pembayaran tersimpan.",
  confirmed: "Pembayaran dikonfirmasi manual dan tercatat. Catatan ini tidak bisa diubah.",
  recheck: "Pengecekan status dijadwalkan. Muat ulang halaman sebentar lagi.",
};
export const feeBearerLabel = { buyer: "Pembeli (tagihan = total pesanan + biaya)", seller: "Penjual (tagihan = total pesanan)" } as const;
export const attemptStateLabel = (a: { status: string; requestState: string; expiresAt: Date; manual: unknown }, now = new Date()): { label: string; tone: "success" | "warning" | "secondary" | "destructive" } => {
  if (a.status === "paid") return { label: "Lunas (AutoLaris)", tone: "success" };
  if (a.manual) return { label: "Dikonfirmasi manual", tone: "success" };
  if (a.requestState === "failed") return { label: "Tagihan gagal dibuat", tone: "destructive" };
  if (a.requestState === "unknown") return { label: "Sedang diperiksa", tone: "warning" };
  if (a.requestState === "in_progress") return { label: "Sedang disiapkan", tone: "secondary" };
  return a.expiresAt <= now ? { label: "Kedaluwarsa", tone: "secondary" } : { label: "Menunggu pembayaran", tone: "warning" };
};
export const anomalyLabel = { second_settled: "Pesanan ini sudah dibayar lewat tagihan lain: pembeli membayar dua kali. Kembalikan kelebihannya ke pembeli dari akun Anda.", paid_after_close: "Dibayar setelah pesanan ditutup. Kembalikan dana ke pembeli dari akun Anda." } as const;
