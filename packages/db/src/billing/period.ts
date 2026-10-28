// BILL-7 billing period formula and the access-state arithmetic. Pure functions: no clock, no database. Dates are Asia/Jakarta
// calendar dates as `YYYY-MM-DD` strings; Indonesia has no DST, so Jakarta is a fixed UTC+7 and instants convert exactly.
// The same formula is a database invariant (the `subscription_invoice_guard` trigger computes `anchor + k months` in SQL).

const JAKARTA_OFFSET_MS = 7 * 3_600_000;
export const DAY_MS = 86_400_000;

export type BillingState = "trial" | "active" | "past_due" | "suspended";

/** Asia/Jakarta calendar date of an instant. */
export const jakartaDate = (at: Date): string => new Date(at.getTime() + JAKARTA_OFFSET_MS).toISOString().slice(0, 10);
/** The instant a Jakarta calendar date starts (00:00 WIB). */
export const jakartaMidnight = (date: string): Date => new Date(Date.parse(`${date}T00:00:00Z`) - JAKARTA_OFFSET_MS);

const parts = (date: string): [number, number, number] => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`invalid date ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const daysInMonth = (year: number, month1: number) => new Date(Date.UTC(year, month1, 0)).getUTCDate();
const iso = (y: number, m1: number, d: number) => `${String(y).padStart(4, "0")}-${String(m1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** `anchor + months` with the day clamped to the month's last day (31 Oct + 1 = 30 Nov, + 4 = 28 Feb). Always computed from the anchor, never from a previous end. */
export function addMonthsClamped(anchor: string, months: number): string {
  if (!Number.isInteger(months)) throw new RangeError("months must be an integer");
  const [y, m, d] = parts(anchor);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month1 = (total % 12) + 1;
  return iso(year, month1, Math.min(d, daysInMonth(year, month1)));
}

/** Period `k` is `[anchor + k months, anchor + (k + 1) months)`, end exclusive. */
export function periodBounds(anchor: string, index: number): { start: string; end: string } {
  if (!Number.isInteger(index) || index < 0) throw new RangeError("period index must be a non-negative integer");
  return { start: addMonthsClamped(anchor, index), end: addMonthsClamped(anchor, index + 1) };
}

/** Index of the period containing a Jakarta date, or -1 before the anchor (still in the trial). */
export function periodIndexAt(anchor: string, date: string): number {
  if (date < anchor) return -1;
  const [ay, am] = parts(anchor);
  const [y, m] = parts(date);
  let k = Math.max(0, (y - ay) * 12 + (m - am));
  while (k > 0 && addMonthsClamped(anchor, k) > date) k--;
  while (addMonthsClamped(anchor, k + 1) <= date) k++;
  return k;
}

/**
 * The period an invoice is due for at `now`: the period containing today, or the next one once its start is within `leadMs`
 * (so it can be paid before the covered period ends); period 0 from `leadMs` before the anchor. null = nothing to invoice yet.
 */
export function targetPeriodIndex(anchor: string, now: Date, leadMs: number): number | null {
  const current = periodIndexAt(anchor, jakartaDate(now));
  if (current < 0) return now.getTime() >= jakartaMidnight(anchor).getTime() - leadMs ? 0 : null;
  const nextStart = jakartaMidnight(periodBounds(anchor, current).end).getTime();
  return now.getTime() >= nextStart - leadMs ? current + 1 : current;
}

/** Trial end = creation instant plus the trial days; the billing anchor is the Jakarta date of that instant (written once, never changed). */
export function trialSchedule(createdAt: Date, trialDays: number): { trialEndsAt: Date; anchor: string } {
  const trialEndsAt = new Date(createdAt.getTime() + trialDays * DAY_MS);
  return { trialEndsAt, anchor: jakartaDate(trialEndsAt) };
}

export type DerivedState = {
  state: BillingState;
  /** Writes are allowed only while covered (trial or paid period running). */
  writable: boolean;
  /** The instant coverage ends (the later of the trial end and the covered period end). */
  coveredUntil: Date;
  pastDueAt: Date | null;
  graceEndsAt: Date | null;
};

/**
 * The billing state at `now` from the stored facts alone, so access never depends on a cron run having happened:
 * trial until `trialEndsAt`; `active` while a paid or comp period covers `now`; otherwise `past_due` from the instant coverage
 * ended until `graceDays` later, then `suspended`. `graceDays` is the plan value in force when coverage ended.
 */
export function deriveBillingState(input: { trialEndsAt: Date; coveredThrough: Date | null; graceDays: number; now: Date }): DerivedState {
  const { trialEndsAt, coveredThrough, graceDays, now } = input;
  const coveredUntil = coveredThrough && coveredThrough > trialEndsAt ? coveredThrough : trialEndsAt;
  if (coveredThrough && now < coveredThrough) return { state: "active", writable: true, coveredUntil, pastDueAt: null, graceEndsAt: null };
  if (now < trialEndsAt) return { state: "trial", writable: true, coveredUntil, pastDueAt: null, graceEndsAt: null };
  const pastDueAt = coveredUntil;
  const graceEndsAt = new Date(pastDueAt.getTime() + graceDays * DAY_MS);
  return { state: now < graceEndsAt ? "past_due" : "suspended", writable: false, coveredUntil, pastDueAt, graceEndsAt };
}
