import type { Tone } from "@/lib/status";
import type { SupportOutcome, StaffMfaOutcome } from "@bukalaris/db";

/** Reason codes offered by the governance forms (a select, never free text; the bounded reason text goes next to it). */
export const REASON_CODES: readonly (readonly [string, string])[] = [
  ["operator_decision", "Keputusan operator"],
  ["risk_review", "Tinjauan risiko"],
  ["payment_dispute", "Sengketa pembayaran"],
  ["abuse_report", "Laporan penyalahgunaan"],
  ["policy_violation", "Pelanggaran kebijakan"],
  ["owner_request", "Permintaan pemilik"],
  ["lost_device", "Perangkat hilang"],
  ["locked_out", "Tidak bisa masuk"],
  ["case_resolved", "Kasus selesai"],
];

/** What was WRITTEN, in words (UX-22: never "user recovered", always "link queued"). The `saved` query carries only the outcome key and a count. */
export const OUTCOME_TEXT: Record<string, (n: number | null) => string> = {
  sessions_revoked: (n) => `${n ?? 0} sesi diakhiri. Tab seller yang masih terbuka tidak bisa lagi mengubah data.`,
  recovery_link_queued: () => "Tautan pemulihan diantrekan ke kontak yang tercatat; pengiriman belum dikonfirmasi. Tautan tidak ditampilkan kepada siapa pun.",
  identity_suspended: (n) => `Akun ditangguhkan dan ${n ?? 0} sesi diakhiri.`,
  identity_reinstated: () => "Penangguhan akun dicabut. Akun bisa masuk lagi.",
  mfa_reset_awaiting_approval: () => "Permintaan reset dicatat. Menunggu penyetuju kedua; belum ada yang direset.",
  mfa_reset_done: () => "Verifikasi dua langkah direset dan kontak yang tercatat diberi tahu. Pengguna mendaftarkannya lagi saat masuk.",
  mfa_reset_cancelled: () => "Persetujuan ditolak atau kedaluwarsa; permintaan reset dibatalkan dan tidak ada yang direset.",
  case_opened: () => "Kasus dibuka.",
  case_moved: () => "Status kasus diperbarui.",
  note_added: () => "Catatan ditambahkan.",
  reveal: () => "Nilai ditampilkan selama jendela pengungkapan; pengungkapan ini tercatat.",
  verification_saved: () => "Versi verifikasi disimpan. Catatan ini informasional dan tidak menghalangi apa pun.",
  verification_reviewed: () => "Keputusan verifikasi disimpan.",
  risk_ack: () => "Pengakuan disimpan; tanda risiko tersembunyi sampai batas waktunya.",
  staff_changed: () => "Perubahan staf disimpan.",
  review_saved: () => "Keputusan review akses disimpan.",
  break_glass_requested: () => "Permintaan akses darurat dicatat. Menunggu penyetuju kedua; belum ada akses yang diberikan.",
  break_glass_granted: () => "Akses darurat diberikan untuk jendela yang disetujui; semua pemegang audit.read diberi tahu.",
  break_glass_ended: () => "Akses darurat dicabut atau ditinjau.",
};

export const savedKey = (o: SupportOutcome | StaffMfaOutcome) => `${o.outcome}${"count" in o && o.count !== null ? `.${o.count}` : ""}${o.replayed ? ".replay" : ""}`;
/** `outcome.count[.replay]` back to text. */
export function savedText(saved: string | string[] | undefined): string | undefined {
  if (typeof saved !== "string") return undefined;
  const [key, count, replay] = saved.split(".");
  const f = OUTCOME_TEXT[key!];
  if (!f) return undefined;
  const text = f(count && /^\d+$/.test(count) ? Number(count) : null);
  return replay === "replay" || count === "replay" ? `${text} (permintaan yang sama sudah pernah diproses; tidak ada perubahan baru)` : text;
}

export const ISSUE_STATUS_LABEL: Record<string, string> = {
  new: "Baru",
  triaged: "Ditriage",
  in_progress: "Dikerjakan",
  resolved: "Selesai",
  wont_fix: "Tidak diperbaiki",
  duplicate: "Duplikat",
};
export const ISSUE_STATUS_TONE: Record<string, Tone> = {
  new: "warning",
  triaged: "default",
  in_progress: "default",
  resolved: "success",
  wont_fix: "secondary",
  duplicate: "outline",
};
export const ISSUE_CATEGORY_LABEL: Record<string, string> = {
  no_response: "Tombol/fungsi tidak merespons",
  wrong_result: "Hasil salah",
  error_message: "Pesan error",
  page_broken: "Halaman rusak",
  other: "Lainnya",
};
export const ISSUE_SEVERITY_LABEL: Record<string, string> = {
  low: "Rendah",
  medium: "Sedang",
  high: "Tinggi",
  blocking: "Menghambat pekerjaan",
};
export const ISSUE_SEVERITY_TONE: Record<string, Tone> = {
  low: "secondary",
  medium: "outline",
  high: "warning",
  blocking: "destructive",
};
