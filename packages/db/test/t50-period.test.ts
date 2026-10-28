import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addMonthsClamped, deriveBillingState, jakartaDate, jakartaMidnight, periodBounds, periodIndexAt, targetPeriodIndex, trialSchedule, DAY_MS } from "../src/billing/period.ts";
import { platform } from "./helpers.ts";

// BILL-7 billing period formula and the access-state arithmetic (T-50). Pure functions, plus a parity check against the SQL the database guard uses.

describe("billing period formula: calendar months from the anchor, day clamped, never drifting", () => {
  it("an anchor on the 31st gives 30 Nov, 31 Dec, 31 Jan, 28 Feb and 31 Mar (each boundary from the anchor, not the previous end)", () => {
    const ends = [1, 2, 3, 4, 5].map((k) => addMonthsClamped("2026-10-31", k));
    expect(ends).toEqual(["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31"]);
    expect(periodBounds("2026-10-31", 3)).toEqual({ start: "2027-01-31", end: "2027-02-28" }); // the clamped month end is exclusive
    expect(periodBounds("2026-10-31", 4)).toEqual({ start: "2027-02-28", end: "2027-03-31" }); // March is back on the 31st: no drift
  });

  it("a leap year keeps 29 February, a 30th anchor clamps February, a 29th anchor clamps in a common year only", () => {
    expect(addMonthsClamped("2027-10-31", 4)).toBe("2028-02-29");
    expect(addMonthsClamped("2026-10-30", 4)).toBe("2027-02-28");
    expect(addMonthsClamped("2027-12-29", 2)).toBe("2028-02-29");
    expect(addMonthsClamped("2026-12-29", 2)).toBe("2027-02-28");
    expect(addMonthsClamped("2026-12-31", 1)).toBe("2027-01-31"); // year rollover
  });

  it("the worked example of UX-18: created 26 Oct 2026 with a 3-day trial, trial ends 29 Oct, period 0 is 29 Oct to 29 Nov", () => {
    const { trialEndsAt, anchor } = trialSchedule(new Date("2026-10-26T03:00:00Z"), 3);
    expect(trialEndsAt.toISOString()).toBe("2026-10-29T03:00:00.000Z");
    expect(anchor).toBe("2026-10-29");
    expect(periodBounds(anchor, 0)).toEqual({ start: "2026-10-29", end: "2026-11-29" });
  });

  it("the anchor is the Asia/Jakarta date, not the UTC date: a trial ending at 20:00 UTC is already the next day in Jakarta", () => {
    // 28 Oct 20:00 UTC + 3 days = 31 Oct 20:00 UTC = 1 Nov 03:00 WIB
    const { trialEndsAt, anchor } = trialSchedule(new Date("2026-10-28T20:00:00Z"), 3);
    expect(trialEndsAt.toISOString().slice(0, 10)).toBe("2026-10-31");
    expect(anchor).toBe("2026-11-01");
    // and the other side of midnight: 16:59:59 UTC is 23:59:59 WIB, 17:00:00 UTC is 00:00:00 WIB of the next day
    expect(jakartaDate(new Date("2026-10-31T16:59:59Z"))).toBe("2026-10-31");
    expect(jakartaDate(new Date("2026-10-31T17:00:00Z"))).toBe("2026-11-01");
    expect(jakartaMidnight("2026-11-01").toISOString()).toBe("2026-10-31T17:00:00.000Z");
  });

  it("the period containing a date, at every boundary (the end is exclusive); before the anchor is the trial", () => {
    expect(periodIndexAt("2026-10-31", "2026-10-30")).toBe(-1);
    expect(periodIndexAt("2026-10-31", "2026-10-31")).toBe(0);
    expect(periodIndexAt("2026-10-31", "2026-11-29")).toBe(0);
    expect(periodIndexAt("2026-10-31", "2026-11-30")).toBe(1); // 30 Nov is period 1's first day, the clamped end of period 0
    expect(periodIndexAt("2026-10-31", "2027-02-27")).toBe(3);
    expect(periodIndexAt("2026-10-31", "2027-02-28")).toBe(4);
    expect(periodIndexAt("2026-10-31", "2030-01-15")).toBe(38);
  });

  it("the invoice target: period 0 opens its window one lead before the anchor, the next period one lead before its start", () => {
    const lead = 3 * DAY_MS;
    const anchor = "2026-10-29";
    expect(targetPeriodIndex(anchor, new Date("2026-10-25T16:59:59Z"), lead)).toBeNull(); // 26 Oct 23:59:59 WIB: one second before the window
    expect(targetPeriodIndex(anchor, new Date("2026-10-25T17:00:00Z"), lead)).toBe(0); // 26 Oct 00:00 WIB... lead is exactly 3 days before 29 Oct 00:00 WIB
    expect(targetPeriodIndex(anchor, new Date("2026-11-25T16:59:59Z"), lead)).toBe(0); // one second before the window of period 1 (29 Nov 00:00 WIB minus 3 days)
    expect(targetPeriodIndex(anchor, new Date("2026-11-25T17:00:00Z"), lead)).toBe(1); // 26 Nov 00:00 WIB: the window of period 1 opens
    expect(targetPeriodIndex(anchor, new Date("2026-11-28T17:00:00Z"), lead)).toBe(1); // 29 Nov 00:00 WIB: period 1 is current, period 2's window is still 25 days away
  });

  it("rejects malformed input instead of guessing", () => {
    expect(() => periodBounds("2026-10-31", -1)).toThrow(RangeError);
    expect(() => addMonthsClamped("31-10-2026", 1)).toThrow(RangeError);
    expect(() => addMonthsClamped("2026-10-31", 1.5)).toThrow(RangeError);
  });

  it("the TypeScript formula equals the database formula for every anchor day of a leap and a common year over four years of periods", async () => {
    const mismatches: string[] = [];
    for (const year of [2026, 2027, 2028]) {
      for (let month = 1; month <= 12; month++) {
        for (const day of [1, 15, 28, 29, 30, 31]) {
          const anchor = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          if (new Date(`${anchor}T00:00:00Z`).getUTCDate() !== day) continue; // not a real date
          const rows = (await platform.execute(sql`select k, ((${anchor}::date + (k * interval '1 month'))::date)::text as d from generate_series(0, 49) k`)) as unknown as { k: number; d: string }[];
          for (const r of rows) if (addMonthsClamped(anchor, Number(r.k)) !== r.d) mismatches.push(`${anchor}+${r.k}: ts ${addMonthsClamped(anchor, Number(r.k))} sql ${r.d}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("billing state arithmetic (trial, active, past_due, suspended) at every instant boundary", () => {
  const trialEndsAt = new Date("2026-10-29T03:00:00Z");
  const paidThrough = new Date("2026-11-28T17:00:00Z"); // 29 Nov 00:00 WIB
  const at = (iso: string, over: Partial<Parameters<typeof deriveBillingState>[0]> = {}) => deriveBillingState({ trialEndsAt, coveredThrough: null, graceDays: 3, now: new Date(iso), ...over });

  it("trial runs up to, and excludes, the trial end instant; then past_due for exactly the grace days; then suspended", () => {
    expect(at("2026-10-29T02:59:59.999Z").state).toBe("trial");
    const justPast = at("2026-10-29T03:00:00.000Z");
    expect(justPast.state).toBe("past_due");
    expect(justPast.pastDueAt!.toISOString()).toBe("2026-10-29T03:00:00.000Z");
    expect(justPast.graceEndsAt!.toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(at("2026-11-01T02:59:59.999Z").state).toBe("past_due");
    expect(at("2026-11-01T03:00:00.000Z").state).toBe("suspended");
    expect([at("2026-10-29T02:59:59Z"), at("2026-10-29T03:00:00Z"), at("2026-11-01T03:00:00Z")].map((s) => s.writable)).toEqual([true, false, false]);
  });

  it("a paid period is active until its end instant (29 Nov 00:00 WIB), then past_due from that instant, grace counted from it", () => {
    expect(at("2026-11-28T16:59:59.999Z", { coveredThrough: paidThrough }).state).toBe("active");
    const d = at("2026-11-28T17:00:00Z", { coveredThrough: paidThrough });
    expect(d.state).toBe("past_due");
    expect(d.pastDueAt!.toISOString()).toBe("2026-11-28T17:00:00.000Z");
    expect(d.graceEndsAt!.toISOString()).toBe("2026-12-01T17:00:00.000Z");
    expect(at("2026-12-01T17:00:00Z", { coveredThrough: paidThrough }).state).toBe("suspended");
  });

  it("paying while still in the trial is active at once (and does not shorten anything: the trial end stays the earlier bound)", () => {
    expect(at("2026-10-27T00:00:00Z", { coveredThrough: paidThrough }).state).toBe("active");
    expect(at("2026-10-27T00:00:00Z", { coveredThrough: paidThrough }).coveredUntil.toISOString()).toBe(paidThrough.toISOString());
  });

  it("zero grace days suspends at the very instant coverage ends; the grace length is the caller's plan value, never a constant", () => {
    expect(at("2026-10-29T03:00:00Z", { graceDays: 0 }).state).toBe("suspended");
    expect(at("2026-11-04T02:59:59Z", { graceDays: 7 }).state).toBe("past_due");
    expect(at("2026-11-05T03:00:00Z", { graceDays: 7 }).state).toBe("suspended");
  });

  it("a late payment of an old period never moves coverage backwards: coverage earlier than the trial end leaves the trial end as the bound", () => {
    const d = at("2026-10-30T00:00:00Z", { coveredThrough: new Date("2026-10-01T00:00:00Z") });
    expect(d.coveredUntil.toISOString()).toBe(trialEndsAt.toISOString());
    expect(d.state).toBe("past_due");
  });
});
