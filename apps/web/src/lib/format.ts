const idr = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
export const rupiah = (n: number | null | undefined) => (n == null ? "—" : idr.format(n));

// Admin dates: the viewer's timezone is unknown server-side, so every timestamp is rendered in one
// explicit zone (WIB) and says so (UX-9). Three shapes only: date+minute, date only, date+second (logs).
const TZ = "Asia/Jakarta";
const dateTime = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });
const dateOnly = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: TZ });
const precise = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "medium", timeZone: TZ });

/** "7 Okt 2026, 14.03 WIB" — orders, history, audit rows. */
export const tanggal = (d: Date) => `${dateTime.format(d)} WIB`;
/** "7 Okt 2026" — list columns where the time of day does not matter. */
export const tanggalSaja = (d: Date) => dateOnly.format(d);
/** "7 Okt 2026, 14.03.21 WIB" — log events, where seconds matter. */
export const waktuLog = (d: Date) => `${precise.format(d)} WIB`;
