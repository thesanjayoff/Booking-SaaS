/**
 * Pure availability engine. No database, no clock, no I/O: everything comes in through
 * `SlotQuery`, so it can be tested exhaustively (DST, overlapping rules, buffers...).
 *
 * Model
 *  - Weekly hours / breaks / holidays are WALL-CLOCK facts in the business time zone
 *    ("Mon 09:00-17:00"). They are resolved to UTC instants per calendar date, so DST
 *    shifts are handled in exactly one place (`wallToUtc`).
 *  - Bookings and external calendar events are UTC intervals.
 *  - Output is a sorted list of UTC start instants (epoch ms). Callers render them in
 *    whatever zone the customer picked.
 *
 * Pipeline per local date (same shape as Easy!Appointments / Cal.com "date ranges"):
 *   exceptions -> work windows -> union -> minus breaks -> UTC -> candidate starts
 *   -> must fit the window, respect notice/horizon, and keep [start-bufBefore, end+bufAfter)
 *   clear of every busy interval.
 */
import { DateTime } from "luxon";

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

export type Interval = { start: number; end: number }; // [start, end) in epoch ms

export type WeeklyRule = {
  weekday: number; // ISO 1=Mon..7=Sun
  startMin: number; // minutes from local midnight
  endMin: number; // up to 1440
  kind: "work" | "break";
  serviceId: string | null;
};

export type DateException = {
  date: string; // YYYY-MM-DD in business tz
  kind: "closed" | "open";
  startMin: number | null;
  endMin: number | null;
  yearly?: boolean;
};

export type SlotQuery = {
  timezone: string;
  rules: WeeklyRule[];
  exceptions: DateException[];
  serviceId: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  /** Gap between offered start times. */
  intervalMin: number;
  /** UTC intervals that are already taken (booking blocks incl. their buffers, external events). */
  busy: Interval[];
  now: number;
  minNoticeMin: number;
  maxAdvanceDays: number;
  /** Only starts inside [rangeStart, rangeEnd) are returned. */
  rangeStart: number;
  rangeEnd: number;
};

/* ------------------------------------------------------------------ interval helpers */

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

/** a minus b. Both are merged first, result is sorted and non-overlapping. */
export function subtractIntervals(a: Interval[], b: Interval[]): Interval[] {
  const base = mergeIntervals(a);
  const cut = mergeIntervals(b);
  const out: Interval[] = [];
  for (const w of base) {
    let cursor = w.start;
    for (const c of cut) {
      if (c.end <= cursor) continue;
      if (c.start >= w.end) break;
      if (c.start > cursor) out.push({ start: cursor, end: Math.min(c.start, w.end) });
      cursor = Math.max(cursor, c.end);
      if (cursor >= w.end) break;
    }
    if (cursor < w.end) out.push({ start: cursor, end: w.end });
  }
  return out;
}

export const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/* ------------------------------------------------------------------ time zone helpers */

const offsetMinutesAt = (ms: number, zone: string) => DateTime.fromMillis(ms, { zone }).offset;

/**
 * The instant at which `zone` jumped forward, given an instant just after the jump.
 * Used when a wall-clock boundary falls inside a spring-forward gap (e.g. 02:30 on the
 * night clocks go 02:00 -> 03:00): the only honest answer is "the moment the gap ends".
 */
function gapEdge(afterMs: number, zone: string): number {
  const offsetAfter = offsetMinutesAt(afterMs, zone);
  let lo = Math.floor((afterMs - 36 * 60 * MINUTE) / MINUTE); // minutes, offset differs here
  let hi = Math.floor(afterMs / MINUTE); // offset === offsetAfter here
  if (offsetMinutesAt(lo * MINUTE, zone) === offsetAfter) return afterMs; // no transition found; be safe
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetMinutesAt(mid * MINUTE, zone) === offsetAfter) hi = mid;
    else lo = mid;
  }
  return hi * MINUTE;
}

/**
 * Wall-clock `minutes` after local midnight of `date` -> UTC instant.
 *
 * A window "[start, end)" means "every instant whose local clock reads inside it", so:
 *  - Normal times: straightforward.
 *  - Ambiguous times (fall-back: 01:30 happens twice): a window START takes the first
 *    occurrence and a window END takes the last, so the repeated hour is fully covered.
 *  - Nonexistent times (spring-forward gap): snapped to the instant the gap starts/ends,
 *    so a window never gains or loses real time it did not have.
 *  - minutes === 1440 means "end of day" = next local midnight.
 */
export function wallToUtc(date: string, minutes: number, zone: string, edge: "start" | "end" = "start"): number {
  let day = DateTime.fromISO(date, { zone });
  let m = minutes;
  if (m >= 1440) {
    day = day.plus({ days: 1 });
    m -= 1440;
  }
  // The wall time as if it were UTC; real candidates are this minus the zone offset.
  const wallAsUtc = Date.UTC(day.year, day.month - 1, day.day, Math.floor(m / 60), m % 60);
  // Sample the offset a day either side: DST transitions are months apart, so these
  // are the "before" and "after" offsets of whichever transition is nearby (or equal).
  const offBefore = offsetMinutesAt(wallAsUtc - DAY, zone);
  const offAfter = offsetMinutesAt(wallAsUtc + DAY, zone);
  const valid = [...new Set([offBefore, offAfter])]
    .map((off) => ({ off, ts: wallAsUtc - off * MINUTE }))
    .filter(({ off, ts }) => offsetMinutesAt(ts, zone) === off)
    .map(({ ts }) => ts);
  if (valid.length > 0) return edge === "start" ? Math.min(...valid) : Math.max(...valid);
  // Spring-forward gap: that wall time never happens.
  return gapEdge(wallAsUtc - Math.min(offBefore, offAfter) * MINUTE, zone);
}

export function localDatesBetween(rangeStart: number, rangeEnd: number, zone: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromMillis(rangeStart, { zone }).startOf("day");
  const last = DateTime.fromMillis(Math.max(rangeStart, rangeEnd - 1), { zone }).startOf("day");
  while (d <= last) {
    out.push(d.toISODate()!);
    d = d.plus({ days: 1 });
  }
  return out;
}

export function localMinuteOfDay(ms: number, zone: string): number {
  const dt = DateTime.fromMillis(ms, { zone });
  return dt.hour * 60 + dt.minute;
}

/* ------------------------------------------------------------------ per-day windows */

type MinRange = { start: number; end: number };

function mergeMin(list: MinRange[]): MinRange[] {
  return mergeIntervals(list);
}

/**
 * The wall-clock work windows (minutes from midnight) for one local date, after applying
 * holidays, custom-hour overrides, per-service schedules and breaks.
 */
export function workMinutesForDate(q: Pick<SlotQuery, "rules" | "exceptions" | "serviceId">, date: string, weekday: number): MinRange[] {
  const md = date.slice(5);
  const todays = q.exceptions.filter((e) => e.date === date || (e.yearly && e.date.slice(5) === md));

  // A closed day always wins, even if custom hours were also added for that date.
  if (todays.some((e) => e.kind === "closed")) return [];

  const opens = todays.filter((e) => e.kind === "open" && e.startMin != null && e.endMin != null);
  if (opens.length > 0) {
    // Custom hours replace the weekly pattern (work AND breaks) for that date.
    return mergeMin(opens.map((e) => ({ start: e.startMin!, end: e.endMin! })));
  }

  const dayRules = q.rules.filter((r) => r.weekday === weekday);
  const own = q.rules.some((r) => r.kind === "work" && r.serviceId === q.serviceId);
  const work = dayRules
    .filter((r) => r.kind === "work" && (own ? r.serviceId === q.serviceId : r.serviceId === null))
    .map((r) => ({ start: r.startMin, end: r.endMin }));
  const breaks = dayRules
    .filter((r) => r.kind === "break" && (r.serviceId === null || r.serviceId === q.serviceId))
    .map((r) => ({ start: r.startMin, end: r.endMin }));

  return subtractIntervals(mergeMin(work), breaks);
}

/** UTC work windows for one local date. */
export function workWindowsForDate(q: SlotQuery, date: string): Interval[] {
  const weekday = DateTime.fromISO(date, { zone: q.timezone }).weekday;
  return workMinutesForDate(q, date, weekday)
    .map((r) => ({ start: wallToUtc(date, r.start, q.timezone, "start"), end: wallToUtc(date, r.end, q.timezone, "end") }))
    .filter((w) => w.end > w.start);
}

/* ------------------------------------------------------------------ slots */

/** Does the grid align on local clock time? Only when it divides the hour or is whole hours. */
const alignsToClock = (interval: number) => 60 % interval === 0 || interval % 60 === 0;

function firstAligned(windowStart: number, interval: number, zone: string): number {
  if (!alignsToClock(interval)) return windowStart;
  let t = windowStart;
  for (let i = 0; i < 288; i++) {
    if (localMinuteOfDay(t, zone) % interval === 0) return t;
    t += 5 * MINUTE;
  }
  return windowStart;
}

export function computeSlots(q: SlotQuery): number[] {
  const dur = q.durationMin * MINUTE;
  const before = q.bufferBeforeMin * MINUTE;
  const after = q.bufferAfterMin * MINUTE;
  const step = Math.max(5, q.intervalMin) * MINUTE;
  const earliest = Math.max(q.rangeStart, q.now + q.minNoticeMin * MINUTE);
  const latest = Math.min(q.rangeEnd - 1, q.now + q.maxAdvanceDays * DAY);
  if (latest < earliest) return [];

  const busy = mergeIntervals(q.busy);
  const slots = new Set<number>();

  // Pad by a day each side: a local date near the range edge can still own an in-range start.
  const dates = localDatesBetween(q.rangeStart - DAY, q.rangeEnd + DAY, q.timezone);
  for (const date of dates) {
    for (const w of workWindowsForDate(q, date)) {
      for (let s = firstAligned(w.start, q.intervalMin, q.timezone); s + dur <= w.end; s += step) {
        if (s < earliest || s > latest) continue;
        const block = { start: s - before, end: s + dur + after };
        if (busy.some((b) => overlaps(b, block))) continue;
        slots.add(s);
      }
    }
  }
  return [...slots].sort((a, b) => a - b);
}

/** Is `start` one of the offered slots? (Server-side re-check used before booking.) */
export function isSlotOffered(q: SlotQuery, start: number): boolean {
  return computeSlots({ ...q, rangeStart: start, rangeEnd: start + 1 }).includes(start);
}
