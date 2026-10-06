import type { OrderAction, OrderStatus } from "@bukalaris/db";

export const statusLabel: Record<OrderStatus, string> = {
  awaiting_payment: "Menunggu pembayaran",
  placed: "Baru",
  processing: "Diproses",
  shipped: "Dikirim",
  completed: "Selesai",
  cancelled: "Dibatalkan",
};

export const statusVariant: Record<OrderStatus, "default" | "secondary" | "outline" | "destructive"> = {
  awaiting_payment: "outline",
  placed: "default",
  processing: "default",
  shipped: "secondary",
  completed: "secondary",
  cancelled: "destructive",
};

export const actionLabel: Record<OrderAction, string> = {
  pay: "Tandai sudah dibayar",
  process: "Proses pesanan",
  ship: "Kirim pesanan",
  complete: "Tandai selesai",
  cancel: "Batalkan pesanan",
};

export const paymentLabel = { cod: "COD (bayar di tempat)", manual_transfer: "Transfer manual" } as const;

const dt = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });
export const tanggal = (d: Date) => dt.format(d);

/** Route param → safe integer id, or NaN. */
export const parseId = (s: string) => (/^[0-9]{1,15}$/.test(s) ? Number(s) : NaN);
