import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  computeSlots, isSlotOffered, mergeIntervals, subtractIntervals, wallToUtc, MINUTE,
  type SlotQuery, type WeeklyRule, type DateException,
} from "@/lib/availability/engine";

const utc = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16) + "Z"; // 2026-06-01T09:00Z
const hhmm = (list: number[], zone = "UTC") => list.map((m) => DateTime.fromMillis(m, { zone }).toFormat("HH:mm"));

const weekdays = (days: number[], startMin: number, endMin: number, extra: Partial<WeeklyRule> = {}): WeeklyRule[] =>
  days.map((weekday) => ({ weekday, startMin, endMin, kind: "work", serviceId: null, ...extra }));
const MON_FRI = [1, 2, 3, 4, 5];
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

/** Whole local calendar day [00:00, next 00:00) in `zone`. */
function dayRange(date: string, zone: string) {
  return { rangeStart: wallToUtc(date, 0, zone), rangeEnd: wallToUtc(date, 1440, zone) };
}

function query(over: Partial<SlotQuery> & { date?: string } = {}): SlotQuery {
  const { date = "2026-06-01", ...rest } = over; // 2026-06-01 is a Monday
  const tz = rest.timezone ?? "UTC";
  return {
    timezone: tz,
    rules: weekdays(MON_FRI, 9 * 60, 17 * 60),
    exceptions: [],
    serviceId: "svc",
    durationMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    intervalMin: 30,
    busy: [],
    now: utc("2026-01-01T00:00:00Z"),
    minNoticeMin: 0,
    maxAdvanceDays: 3650,
    ...dayRange(date, tz),
    ...rest,
  };
}

describe("interval helpers", () => {
  it("merges overlapping and touching intervals", () => {
    expect(mergeIntervals([{ start: 5, end: 10 }, { start: 0, end: 5 }, { start: 8, end: 12 }, { start: 20, end: 25 }])).toEqual([
      { start: 0, end: 12 }, { start: 20, end: 25 },
    ]);
  });
  it("subtracts, including cuts that span several windows and are fully inside", () => {
    expect(subtractIntervals([{ start: 0, end: 100 }], [{ start: 10, end: 20 }, { start: 15, end: 30 }, { start: 90, end: 200 }])).toEqual([
      { start: 0, end: 10 }, { start: 30, end: 90 },
    ]);
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: -5, end: 50 }])).toEqual([]);
  });
});

describe("weekly hours", () => {
  it("offers a slot every 30 minutes across 09:00-17:00", () => {
    const s = computeSlots(query());
    expect(s).toHaveLength(16);
    expect(iso(s[0])).toBe("2026-06-01T09:00Z");
    expect(iso(s.at(-1)!)).toBe("2026-06-01T16:30Z");
  });

  it("offers nothing on a day with no hours (Saturday)", () => {
    expect(computeSlots(query({ date: "2026-06-06" }))).toEqual([]);
  });

  it("never lets an appointment run past the end of the window", () => {
    const s = computeSlots(query({ durationMin: 60 }));
    expect(iso(s.at(-1)!)).toBe("2026-06-01T16:00Z");
  });

  it("honours the slot interval (15 min) and a duration longer than the interval", () => {
    const s = computeSlots(query({ intervalMin: 15, durationMin: 45 }));
    expect(hhmm(s).slice(0, 3)).toEqual(["09:00", "09:15", "09:30"]);
    expect(hhmm(s).at(-1)).toBe("16:15"); // 16:15 + 45m = 17:00
  });

  it("anchors an interval that does not divide the hour (45 min) at the window start", () => {
    const s = computeSlots(query({ intervalMin: 45, durationMin: 45 }));
    expect(hhmm(s).slice(0, 4)).toEqual(["09:00", "09:45", "10:30", "11:15"]);
  });

  it("aligns to the clock when a window starts off-grid", () => {
    const s = computeSlots(query({ rules: weekdays([1], 9 * 60 + 10, 11 * 60) }));
    expect(hhmm(s)).toEqual(["09:30", "10:00", "10:30"]);
  });
});

describe("overlapping rules", () => {
  it("unions overlapping work rules into one window (no duplicate slots)", () => {
    const rules = [...weekdays([1], 9 * 60, 12 * 60), ...weekdays([1], 11 * 60, 14 * 60)];
    const s = computeSlots(query({ rules }));
    expect(hhmm(s)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30"]);
    expect(new Set(s).size).toBe(s.length);
  });

  it("treats back-to-back rules as continuous: a 60-min visit may span the seam", () => {
    const rules = [...weekdays([1], 9 * 60, 12 * 60), ...weekdays([1], 12 * 60, 15 * 60)];
    const s = computeSlots(query({ rules, durationMin: 60 }));
    expect(hhmm(s)).toContain("11:30");
    expect(hhmm(s).at(-1)).toBe("14:00");
  });

  it("a rule fully inside another changes nothing", () => {
    const rules = [...weekdays([1], 9 * 60, 17 * 60), ...weekdays([1], 10 * 60, 11 * 60)];
    expect(computeSlots(query({ rules }))).toHaveLength(16);
  });

  it("unions overlapping breaks", () => {
    const rules = [
      ...weekdays([1], 9 * 60, 17 * 60),
      ...weekdays([1], 12 * 60, 13 * 60, { kind: "break" }),
      ...weekdays([1], 12 * 60 + 30, 13 * 60 + 30, { kind: "break" }),
    ];
    const h = hhmm(computeSlots(query({ rules })));
    expect(h).not.toContain("12:00");
    expect(h).not.toContain("12:30");
    expect(h).not.toContain("13:00");
    expect(h).toContain("11:30");
    expect(h).toContain("13:30");
  });

  it("a break stops a long appointment from straddling it", () => {
    const rules = [...weekdays([1], 9 * 60, 17 * 60), ...weekdays([1], 12 * 60, 13 * 60, { kind: "break" })];
    const h = hhmm(computeSlots(query({ rules, durationMin: 60 })));
    expect(h).toContain("11:00"); // ends 12:00 exactly when the break starts
    expect(h).not.toContain("11:30");
    expect(h).not.toContain("12:30");
    expect(h).toContain("13:00");
    expect(h).toHaveLength(12);
  });

  it("a break covering the whole day, or sitting outside work hours", () => {
    const all = [...weekdays([1], 9 * 60, 17 * 60), ...weekdays([1], 8 * 60, 18 * 60, { kind: "break" })];
    expect(computeSlots(query({ rules: all }))).toEqual([]);
    const outside = [...weekdays([1], 9 * 60, 17 * 60), ...weekdays([1], 18 * 60, 19 * 60, { kind: "break" })];
    expect(computeSlots(query({ rules: outside }))).toHaveLength(16);
  });

  it("split shifts (morning + afternoon) leave the gap closed", () => {
    const rules = [...weekdays([1], 9 * 60, 12 * 60), ...weekdays([1], 14 * 60, 17 * 60)];
    const h = hhmm(computeSlots(query({ rules })));
    expect(h).toHaveLength(12);
    expect(h).not.toContain("12:00");
    expect(h).not.toContain("13:30");
  });

  it("a service with its own hours ignores the global hours but keeps global breaks", () => {
    const rules: WeeklyRule[] = [
      ...weekdays([1], 9 * 60, 17 * 60),
      ...weekdays([1], 14 * 60, 16 * 60, { serviceId: "svc" }),
      ...weekdays([1], 15 * 60, 15 * 60 + 30, { kind: "break" }),
    ];
    expect(hhmm(computeSlots(query({ rules, serviceId: "svc" })))).toEqual(["14:00", "14:30", "15:30"]);
    expect(computeSlots(query({ rules, serviceId: "other" }))).toHaveLength(15); // 16 minus the 15:00 break
  });
});

describe("holidays and date exceptions", () => {
  const ex = (e: Partial<DateException>): DateException => ({ date: "2026-06-01", kind: "closed", startMin: null, endMin: null, ...e });

  it("a closed date has no slots", () => {
    expect(computeSlots(query({ exceptions: [ex({})] }))).toEqual([]);
  });

  it("a yearly holiday repeats in later years but not on other dates", () => {
    const yearly = ex({ date: "2020-06-01", yearly: true });
    expect(computeSlots(query({ exceptions: [yearly] }))).toEqual([]);
    expect(computeSlots(query({ exceptions: [yearly], date: "2026-06-02" }))).toHaveLength(16);
    const oneOff = ex({ date: "2020-06-01" });
    expect(computeSlots(query({ exceptions: [oneOff] }))).toHaveLength(16);
  });

  it("custom hours REPLACE the weekly pattern for that date (and its breaks), even on a normally-closed day", () => {
    const rules = [...weekdays([1], 9 * 60, 17 * 60), ...weekdays([1], 12 * 60, 13 * 60, { kind: "break" })];
    const open = ex({ kind: "open", startMin: 10 * 60, endMin: 13 * 60 });
    expect(hhmm(computeSlots(query({ rules, exceptions: [open] })))).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00", "12:30"]);
    const sat = computeSlots(query({ date: "2026-06-06", exceptions: [{ ...open, date: "2026-06-06" }] }));
    expect(sat).toHaveLength(6);
  });

  it("multiple custom ranges on one date are unioned; closed beats open", () => {
    const opens = [ex({ kind: "open", startMin: 9 * 60, endMin: 11 * 60 }), ex({ kind: "open", startMin: 10 * 60, endMin: 12 * 60 })];
    expect(computeSlots(query({ exceptions: opens }))).toHaveLength(6);
    expect(computeSlots(query({ exceptions: [...opens, ex({})] }))).toEqual([]);
  });
});

describe("notice, horizon and busy time", () => {
  it("enforces minimum notice", () => {
    const now = utc("2026-06-01T09:00:00Z");
    const h = hhmm(computeSlots(query({ now, minNoticeMin: 120 })));
    expect(h[0]).toBe("11:00");
    expect(hhmm(computeSlots(query({ now, minNoticeMin: 121 })))[0]).toBe("11:30");
  });

  it("offers nothing in the past", () => {
    expect(computeSlots(query({ now: utc("2026-06-02T00:00:00Z") }))).toEqual([]);
  });

  it("enforces the booking horizon", () => {
    const now = utc("2026-05-30T12:00:00Z");
    expect(computeSlots(query({ now, maxAdvanceDays: 1 }))).toEqual([]);
    expect(computeSlots(query({ now, maxAdvanceDays: 3 }))).toHaveLength(16);
  });

  it("removes slots that collide with busy time", () => {
    const busy = [{ start: utc("2026-06-01T10:00:00Z"), end: utc("2026-06-01T11:00:00Z") }];
    const h = hhmm(computeSlots(query({ busy })));
    expect(h).not.toContain("10:00");
    expect(h).not.toContain("10:30");
    expect(h).toContain("09:30");
    expect(h).toContain("11:00");
  });

  it("applies buffers before and after to the NEW appointment against existing busy time", () => {
    const busy = [{ start: utc("2026-06-01T10:00:00Z"), end: utc("2026-06-01T10:30:00Z") }];
    const h = hhmm(computeSlots(query({ busy, bufferBeforeMin: 15, bufferAfterMin: 15 })));
    // 09:30 slot would block 09:15-10:15 -> collides with 10:00 busy
    expect(h).not.toContain("09:30");
    expect(h).toContain("09:00"); // blocks 08:45-09:45
    expect(h).not.toContain("10:30"); // before-buffer 10:15-10:30 hits busy
    expect(h).toContain("11:00");
  });

  it("buffers may extend outside working hours without hiding the first/last slot", () => {
    const h = hhmm(computeSlots(query({ bufferBeforeMin: 15, bufferAfterMin: 15 })));
    expect(h[0]).toBe("09:00");
    expect(h.at(-1)).toBe("16:30");
  });
});

describe("time zones (store UTC, show local)", () => {
  it("resolves business wall-clock hours to UTC: New York winter vs summer", () => {
    const winter = computeSlots(query({ timezone: "America/New_York", date: "2026-01-12" }));
    const summer = computeSlots(query({ timezone: "America/New_York", date: "2026-06-01" }));
    expect(iso(winter[0])).toBe("2026-01-12T14:00Z"); // 09:00 EST
    expect(iso(summer[0])).toBe("2026-06-01T13:00Z"); // 09:00 EDT
  });

  it("handles half-hour zones (Asia/Kolkata): 09:00 IST = 03:30 UTC and slots stay on :00/:30 local", () => {
    const s = computeSlots(query({ timezone: "Asia/Kolkata" }));
    expect(iso(s[0])).toBe("2026-06-01T03:30Z");
    expect(hhmm(s, "Asia/Kolkata").slice(0, 3)).toEqual(["09:00", "09:30", "10:00"]);
    expect(s).toHaveLength(16);
  });

  it("returns only starts inside the requested UTC range, even when local days straddle it", () => {
    // Auckland is UTC+12 in June. Monday 09:00 NZST = Sunday 21:00 UTC.
    const q = query({ timezone: "Pacific/Auckland", rangeStart: utc("2026-05-31T00:00:00Z"), rangeEnd: utc("2026-06-01T00:00:00Z") });
    const s = computeSlots(q);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x >= q.rangeStart && x < q.rangeEnd)).toBe(true);
    expect(iso(s[0])).toBe("2026-05-31T21:00Z");
    expect(iso(s.at(-1)!)).toBe("2026-05-31T23:30Z");
  });
});

describe("daylight saving time (America/New_York)", () => {
  const NY = "America/New_York";
  const SPRING = "2026-03-08"; // 02:00 EST -> 03:00 EDT (Sunday)
  const FALL = "2026-11-01"; // 02:00 EDT -> 01:00 EST (Sunday)

  it("sanity: the dates really are the transitions", () => {
    expect(DateTime.fromISO(`${SPRING}T12:00`, { zone: NY }).offset).toBe(-240);
    expect(DateTime.fromISO(`${SPRING}T00:30`, { zone: NY }).offset).toBe(-300);
    expect(DateTime.fromISO(`${FALL}T00:30`, { zone: NY }).offset).toBe(-240);
    expect(DateTime.fromISO(`${FALL}T12:00`, { zone: NY }).offset).toBe(-300);
  });

  it("keeps wall-clock hours on transition days (09:00-17:00 is always 16 slots, starting at 09:00 local)", () => {
    const rules = weekdays(EVERY_DAY, 9 * 60, 17 * 60);
    const spring = computeSlots(query({ timezone: NY, rules, date: SPRING }));
    const fall = computeSlots(query({ timezone: NY, rules, date: FALL }));
    expect(spring).toHaveLength(16);
    expect(fall).toHaveLength(16);
    expect(iso(spring[0])).toBe("2026-03-08T13:00Z"); // 09:00 EDT
    expect(iso(fall[0])).toBe("2026-11-01T14:00Z"); // 09:00 EST
    // the day before / after use the old / new offset
    expect(iso(computeSlots(query({ timezone: NY, rules, date: "2026-03-07" }))[0])).toBe("2026-03-07T14:00Z");
  });

  it("spring forward: a 00:00-06:00 window contains only 5 real hours -> 10 half-hour slots, none duplicated or invented", () => {
    const rules = weekdays(EVERY_DAY, 0, 6 * 60);
    const s = computeSlots(query({ timezone: NY, rules, date: SPRING }));
    expect(s).toHaveLength(10);
    expect(new Set(s).size).toBe(10);
    const local = hhmm(s, NY);
    expect(local).toContain("01:30");
    expect(local).not.toContain("02:00"); // that wall time does not exist
    expect(local).not.toContain("02:30");
    expect(local).toContain("03:00");
    // consecutive slots are exactly 30 real minutes apart, including across the jump
    for (let i = 1; i < s.length; i++) expect(s[i] - s[i - 1]).toBe(30 * MINUTE);
  });

  it("spring forward: a window that STARTS inside the gap begins when the gap ends", () => {
    const rules = weekdays(EVERY_DAY, 2 * 60, 4 * 60); // 02:00-04:00 -> really 03:00-04:00
    const s = computeSlots(query({ timezone: NY, rules, date: SPRING }));
    expect(s.map(iso)).toEqual(["2026-03-08T07:00Z", "2026-03-08T07:30Z"]); // 03:00 + 03:30 EDT
  });

  it("spring forward: a window that ENDS inside the gap stops where the gap starts", () => {
    const rules = weekdays(EVERY_DAY, 60, 2 * 60 + 30); // 01:00-02:30 -> really 01:00-02:00 (EST)
    const s = computeSlots(query({ timezone: NY, rules, date: SPRING }));
    expect(hhmm(s, NY)).toEqual(["01:00", "01:30"]);
  });

  it("fall back: a 00:00-06:00 window contains 7 real hours -> 14 slots; the repeated 01:xx hour is offered once each", () => {
    const rules = weekdays(EVERY_DAY, 0, 6 * 60);
    const s = computeSlots(query({ timezone: NY, rules, date: FALL }));
    expect(s).toHaveLength(14);
    expect(new Set(s).size).toBe(14);
    for (let i = 1; i < s.length; i++) expect(s[i] - s[i - 1]).toBe(30 * MINUTE);
    const offsets = s.map((m) => DateTime.fromMillis(m, { zone: NY }).offset);
    expect(offsets.filter((o) => o === -240)).toHaveLength(4); // 00:00,00:30,01:00,01:30 EDT
    expect(offsets.filter((o) => o === -300)).toHaveLength(10); // 01:00 EST .. 05:30 EST
  });

  it("fall back: a window starting at an ambiguous time begins at the FIRST occurrence and covers the repeated hour", () => {
    const rules = weekdays(EVERY_DAY, 60, 2 * 60); // 01:00-02:00 wall = 01:00 EDT .. 02:00 EST = 2 real hours
    const s = computeSlots(query({ timezone: NY, rules, date: FALL }));
    expect(s.map(iso)).toEqual(["2026-11-01T05:00Z", "2026-11-01T05:30Z", "2026-11-01T06:00Z", "2026-11-01T06:30Z"]);
  });

  it("fall back: a window ending at an ambiguous time ends at the LAST occurrence", () => {
    const rules = weekdays(EVERY_DAY, 0, 90); // 00:00-01:30 wall = 00:00 EDT .. 01:30 EST = 2.5 real hours
    const s = computeSlots(query({ timezone: NY, rules, date: FALL }));
    expect(s).toHaveLength(5);
    expect(iso(s.at(-1)!)).toBe("2026-11-01T06:00Z"); // last start 01:00 EST, ends 01:30 EST
  });

  it("a booking made before the spring-forward still blocks the right real time", () => {
    const rules = weekdays(EVERY_DAY, 0, 6 * 60);
    const busy = [{ start: utc("2026-03-08T06:30:00Z"), end: utc("2026-03-08T07:00:00Z") }]; // 01:30-03:00 EDT... (01:30 EST = 06:30Z)
    const h = hhmm(computeSlots(query({ timezone: NY, rules, date: SPRING, busy })), NY);
    expect(h).not.toContain("01:30");
    expect(h).toContain("03:00");
  });

  it("wallToUtc agrees with Luxon for ordinary times and snaps gap times to the transition", () => {
    expect(wallToUtc("2026-06-01", 9 * 60, NY)).toBe(utc("2026-06-01T13:00:00Z"));
    expect(wallToUtc(SPRING, 2 * 60 + 30, NY)).toBe(utc("2026-03-08T07:00:00Z"));
    expect(wallToUtc(SPRING, 1440, NY)).toBe(wallToUtc("2026-03-09", 0, NY));
  });

  it("works for zones with DST in the other hemisphere (Australia/Sydney, spring forward 2026-10-04)", () => {
    const rules = weekdays(EVERY_DAY, 9 * 60, 17 * 60);
    const before = computeSlots(query({ timezone: "Australia/Sydney", rules, date: "2026-10-03" }));
    const after = computeSlots(query({ timezone: "Australia/Sydney", rules, date: "2026-10-05" }));
    expect(iso(before[0])).toBe("2026-10-02T23:00Z"); // 09:00 AEST (+10)
    expect(iso(after[0])).toBe("2026-10-04T22:00Z"); // 09:00 AEDT (+11)
  });
});

describe("isSlotOffered", () => {
  it("accepts exactly the offered starts and rejects everything else", () => {
    const q = query({ busy: [{ start: utc("2026-06-01T10:00:00Z"), end: utc("2026-06-01T10:30:00Z") }] });
    expect(isSlotOffered(q, utc("2026-06-01T09:30:00Z"))).toBe(true);
    expect(isSlotOffered(q, utc("2026-06-01T10:00:00Z"))).toBe(false); // busy
    expect(isSlotOffered(q, utc("2026-06-01T09:10:00Z"))).toBe(false); // off-grid
    expect(isSlotOffered(q, utc("2026-06-01T17:00:00Z"))).toBe(false); // after hours
  });
});
