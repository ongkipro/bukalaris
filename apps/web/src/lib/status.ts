import { ORDER_STATUS_LABEL, type InvitationStatus, type LogLevel, type OrderAction, type OrderStatus } from "@bukalaris/db";

/** Mirrors `JOB_STATUSES` in packages/db/src/schema-jobs.ts (not exported from the package root). */
export type JobStatus = "pending" | "running" | "done" | "failed";

// Every enum the admin renders has exactly one Indonesian label and one badge tone here. Pages never
// print a raw enum string; new enums get a row here first.
export type Tone = "default" | "secondary" | "outline" | "destructive" | "success" | "warning";

export const orderStatusLabel = ORDER_STATUS_LABEL;
export const orderStatusTone: Record<OrderStatus, Tone> = {
  awaiting_confirmation: "warning",
  on_hold: "secondary",
  awaiting_payment: "warning",
  placed: "default",
  processing: "default",
  shipped: "outline",
  completed: "success",
  cancelled: "destructive",
};

export const orderActionLabel: Record<OrderAction, string> = {
  confirm: "Konfirmasi pesanan",
  hold: "Tahan pesanan",
  reject: "Tolak pesanan",
  pay: "Tandai sudah dibayar",
  process: "Proses pesanan",
  ship: "Kirim pesanan",
  complete: "Tandai selesai",
  cancel: "Batalkan pesanan",
};

export const paymentLabel = { cod: "COD (bayar di tempat)", manual_transfer: "Transfer manual" } as const;
export const paymentShortLabel = { cod: "COD", manual_transfer: "Transfer" } as const;

export type ProductStatus = "draft" | "active" | "archived";
export const productStatusLabel: Record<ProductStatus, string> = { draft: "Draf", active: "Aktif", archived: "Diarsipkan" };
export const productStatusTone: Record<ProductStatus, Tone> = { draft: "secondary", active: "success", archived: "outline" };

export type PublishStatus = "draft" | "published";
export const publishStatusLabel: Record<PublishStatus, string> = { draft: "Draf", published: "Publik" };
export const publishStatusTone: Record<PublishStatus, Tone> = { draft: "secondary", published: "success" };

export type StoreStatus = "active" | "suspended";
export const storeStatusLabel: Record<StoreStatus, string> = { active: "Aktif", suspended: "Ditangguhkan" };
export const storeStatusTone: Record<StoreStatus, Tone> = { active: "success", suspended: "destructive" };

export type Role = "owner" | "staff";
export const roleLabel: Record<Role, string> = { owner: "Pemilik", staff: "Staf" };

export const invitationStatusLabel: Record<InvitationStatus, string> = { pending: "Menunggu", accepted: "Diterima", revoked: "Dibatalkan", expired: "Kedaluwarsa" };
export const invitationStatusTone: Record<InvitationStatus, Tone> = { pending: "warning", accepted: "success", revoked: "outline", expired: "destructive" };

export type ChannelState = "active" | "expired" | "revoked";
export const channelStateLabel: Record<ChannelState, string> = { active: "Aktif", expired: "Kedaluwarsa", revoked: "Dicabut" };
export const channelStateTone: Record<ChannelState, Tone> = { active: "success", expired: "warning", revoked: "outline" };

export const jobStatusLabel: Record<JobStatus, string> = { pending: "Menunggu", running: "Berjalan", done: "Selesai", failed: "Gagal" };
export const jobStatusTone: Record<JobStatus, Tone> = { pending: "warning", running: "default", done: "success", failed: "destructive" };

export const logLevelLabel: Record<LogLevel, string> = { debug: "Debug", info: "Info", warn: "Peringatan", error: "Error", fatal: "Fatal" };
export const logLevelTone: Record<LogLevel, Tone> = { debug: "outline", info: "secondary", warn: "warning", error: "destructive", fatal: "destructive" };

export type StoreTheme = "responsive" | "mobile";
export const themeLabel: Record<StoreTheme, string> = { responsive: "Responsif", mobile: "Mobile" };
/** Unknown values fall back to the raw code so a new theme is still visible rather than blank. */
export const themeName = (t: string) => themeLabel[t as StoreTheme] ?? t;

/**
 * Audit-log action codes written by packages/db (`<verb>` or `<verb>:<id>[:<arg>]`), as operators read them.
 * Unknown codes fall back to the raw string so a new action is still visible rather than blank.
 */
const AUDIT_VERB: Record<string, (id?: string, arg?: string) => string> = {
  "store.create": () => "Toko dibuat",
  "store.active": () => "Toko diaktifkan kembali",
  "store.suspended": () => "Toko ditangguhkan",
  "store.settings": (theme) => `Pengaturan toko disimpan${theme ? ` (tema ${themeName(theme)})` : ""}`,
  "channel.create": (id) => `Channel #${id} dibuat`,
  "channel.revoke": (id) => `Channel #${id} dicabut`,
  "invite.create": (id, role) => `Undangan #${id} dikirim${role ? ` (${roleLabel[role as Role] ?? role})` : ""}`,
  "invite.revoke": (id) => `Undangan #${id} dibatalkan`,
  "invite.accept": (id, role) => `Undangan #${id} diterima${role ? ` (${roleLabel[role as Role] ?? role})` : ""}`,
  "session.revoke": () => "Sesi anggota dicabut",
  "logs.list": () => "Log dibaca (daftar)",
  "logs.read": () => "Log dibaca (detail)",
};
export const auditAction = (code: string) => {
  const [verb, id, arg] = code.split(":");
  const fn = AUDIT_VERB[verb!];
  return fn ? fn(id, arg) : code;
};
