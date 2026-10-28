import type { Tone } from "@/lib/status";

// Labels and tones of the seller money enums (UX-14, T-37). Pages never print a raw enum; a new value gets its row here first.
export const payoutStatusLabel: Record<string, string> = { requested: "Menunggu persetujuan", processing: "Sedang ditransfer", paid: "Sudah ditransfer", rejected: "Ditolak (dana dikembalikan)" };
export const payoutStatusTone: Record<string, Tone> = { requested: "warning", processing: "default", paid: "success", rejected: "destructive" };

export const refundStatusLabel: Record<string, string> = { pending: "Menunggu rekening / persetujuan", processing: "Sedang ditransfer ke pembeli", completed: "Sudah dikembalikan ke pembeli", failed: "Gagal, akan dibuka kembali" };
export const refundStatusTone: Record<string, Tone> = { pending: "warning", processing: "default", completed: "success", failed: "destructive" };
export const refundReasonLabel: Record<string, string> = { order_cancelled: "Pesanan dibatalkan", order_returned: "Pesanan kembali (RTS)", late_payment: "Pembayaran terlambat" };

export const ledgerStatusLabel: Record<string, string> = { pending: "Dana dalam proses", available: "Tersedia" };
export const ledgerStatusTone: Record<string, Tone> = { pending: "warning", available: "success" };
export const releaseBasisLabel: Record<string, string> = { delivery: "Paket diterima", reconciliation: "Dana COD direkonsiliasi", netting: "Dikompensasi dengan penjualan", direct: "Langsung" };

export const BANKS = ["BCA", "BNI", "BRI", "MANDIRI", "BSI", "CIMB", "PERMATA", "DANAMON", "JAGO", "SEABANK"] as const;

export const BATCH_STATUS_LABEL: Record<string, string> = { draft: "Draf", pending_approval: "Menunggu persetujuan", applied: "Diterapkan", void: "Dibatalkan" };
export const BATCH_STATUS_TONE: Record<string, Tone> = { draft: "secondary", pending_approval: "warning", applied: "success", void: "outline" };
