import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { makeTestDb, seedBasic } from "./helpers";
import { all, get, run } from "@/lib/db";
import { createService } from "@/lib/services";
import { saveSettings } from "@/lib/settings";
import {
  createBooking, cancelBooking, rescheduleBooking, getBooking, releaseExpiredHolds,
  SlotUnavailableError, CutoffError, BookingStateError,
} from "@/lib/bookings";
import { getSlots } from "@/lib/availability/store";

const MIN = 60_000;
const HOUR = 60 * MIN;
const day = (iso: string) => Date.parse(`${iso}Z`);
// Monday 2030-06-03, "now" is the Monday before so min-notice etc. never interfere
const NOW = day("2030-05-27T08:00:00");
const at = (hhmm: string, date = "2030-06-03") => day(`${date}T${hhmm}:00`);

const t = makeTestDb("booking");
let svc: ReturnType<typeof seedBasic>;
let n = 0;
const who = () => ({ name: "Asha Rao", email: `asha${++n}@example.com`, timezone: "Asia/Kolkata" });
const book = (startAt: number, serviceId = svc.id, extra: Record<string, unknown> = {}) =>
  createBooking({ serviceId, startAt, ...who(), ...extra }, { db: t.db, now: NOW, paymentsEnabled: false });

beforeAll(() => {
  svc = seedBasic(t.db, { settings: { maxAdvanceDays: 3650, cancelCutoffHours: 12 } });
});
afterAll(() => t.cleanup());

const locksFor = (id: string) => get<{ n: number }>(t.db, "SELECT COUNT(*) AS n FROM slot_locks WHERE booking_id = ?", id)!.n;

describe("creating bookings", () => {
  it("confirms a booking, stores UTC, claims one lock per 5-minute unit and enqueues follow-up jobs", () => {
    const { booking, created } = book(at("10:00"));
    expect(created).toBe(true);
    expect(booking).toMatchObject({ status: "confirmed", startAt: at("10:00"), endAt: at("10:30"), paymentStatus: "none", customerTz: "Asia/Kolkata" });
    expect(locksFor(booking.id)).toBe(6); // 30 min / 5
    const jobs = all<{ type: string }>(t.db, "SELECT type FROM jobs WHERE dedupe_key LIKE ?", `%${booking.id}%`).map((j) => j.type);
    expect(jobs).toEqual(expect.arrayContaining(["notify", "gcal.push"]));
  });

  it("rejects starts outside working hours, off the grid, on weekends and inside the notice window", () => {
    const attempt = (s: number) => () => book(s);
    expect(attempt(at("08:00"))).toThrow(SlotUnavailableError);
    expect(attempt(at("17:00"))).toThrow(SlotUnavailableError);
    expect(attempt(at("10:10"))).toThrow(SlotUnavailableError);
    expect(attempt(at("10:00", "2030-06-01"))).toThrow(SlotUnavailableError); // Saturday
    saveSettings({ minNoticeMin: 24 * 60 }, t.db);
    expect(() => createBooking({ serviceId: svc.id, startAt: at("09:00", "2030-05-27"), ...who() }, { db: t.db, now: NOW, paymentsEnabled: false })).toThrow(SlotUnavailableError);
    saveSettings({ minNoticeMin: 0 }, t.db);
  });

  it("rejects unknown and inactive services", () => {
    expect(() => book(at("11:00"), "nope")).toThrow(SlotUnavailableError);
    const off = createService({ name: "Retired", slug: "retired", durationMin: 30, priceMinor: 0, active: false }, t.db);
    expect(() => book(at("11:00"), off.id)).toThrow(SlotUnavailableError);
  });

  it("refuses a second booking of the same slot, but lets a different slot through", () => {
    book(at("11:00"));
    expect(() => book(at("11:00"))).toThrow(SlotUnavailableError);
    expect(() => book(at("11:30"))).not.toThrow();
  });

  it("refuses ANY overlap, however the bookings are shaped (long visit vs. short visit)", () => {
    const long = createService({ name: "Long", slug: "long", durationMin: 60, priceMinor: 0 }, t.db);
    book(at("13:00"), long.id); // 13:00-14:00
    expect(() => book(at("13:30"))).toThrow(SlotUnavailableError); // 30-min visit inside it
    expect(() => book(at("12:30"), long.id)).toThrow(SlotUnavailableError); // 12:30-13:30 overlaps its head
    expect(() => book(at("14:00"))).not.toThrow(); // touching is fine
  });

  it("buffers: a booking's after-buffer keeps the next one away, and neighbours' buffers are respected", () => {
    const b = createService({ name: "Buffered", slug: "buffered", durationMin: 30, priceMinor: 0, bufferBeforeMin: 10, bufferAfterMin: 20, slotIntervalMin: 10 }, t.db);
    const first = book(at("15:00"), b.id).booking; // blocks 14:50-15:50
    expect([first.blockStart, first.blockEnd]).toEqual([at("14:50"), at("15:50")]);
    expect(locksFor(first.id)).toBe(12);
    expect(() => book(at("15:30"), b.id)).toThrow(SlotUnavailableError); // its before-buffer 15:20 collides
    expect(() => book(at("16:00"), b.id)).not.toThrow(); // blocks 15:50-16:50 -> touches, no overlap
  });

  it("is idempotent for a repeated submission (same idempotency key)", () => {
    const key = crypto.randomUUID();
    const one = book(at("16:00", "2030-06-04"), svc.id, { idempotencyKey: key });
    const two = book(at("16:00", "2030-06-04"), svc.id, { idempotencyKey: key });
    expect(two.created).toBe(false);
    expect(two.booking.id).toBe(one.booking.id);
    expect(get<{ n: number }>(t.db, "SELECT COUNT(*) AS n FROM bookings WHERE idempotency_key = ?", key)!.n).toBe(1);
  });

  it("reuses the customer record per email but keeps each booking's own contact details", () => {
    const a = createBooking({ serviceId: svc.id, startAt: at("09:00", "2030-06-05"), name: "Sam", email: "Sam@Example.com", phone: "+911111111111", timezone: "UTC" }, { db: t.db, now: NOW, paymentsEnabled: false }).booking;
    const b = createBooking({ serviceId: svc.id, startAt: at("09:30", "2030-06-05"), name: "Mallory", email: "sam@example.com", phone: "+922222222222", timezone: "UTC" }, { db: t.db, now: NOW, paymentsEnabled: false }).booking;
    expect(b.customerId).toBe(a.customerId);
    expect(a.phone).toBe("+911111111111");
    expect(b.phone).toBe("+922222222222");
    expect(get<{ phone: string }>(t.db, "SELECT phone FROM customers WHERE id = ?", a.customerId)!.phone).toBe("+911111111111");
  });

  it("does not offer slots that are taken", () => {
    const from = at("00:00", "2030-06-03");
    const slots = getSlots(svc.id, { from, to: from + 24 * HOUR }, { db: t.db, now: NOW });
    expect(slots).not.toContain(at("10:00"));
    expect(slots).not.toContain(at("11:00"));
    expect(slots).toContain(at("09:00"));
  });
});

describe("cancelling", () => {
  it("frees the slot, cancels reminders and is idempotent", () => {
    const { booking } = book(at("09:00", "2030-06-06"));
    const done = cancelBooking(booking.id, { by: "customer", db: t.db, now: NOW });
    expect(done.status).toBe("cancelled");
    expect(locksFor(booking.id)).toBe(0);
    expect(() => cancelBooking(booking.id, { by: "customer", db: t.db, now: NOW })).not.toThrow();
    expect(() => book(at("09:00", "2030-06-06"))).not.toThrow(); // rebookable
  });

  it("enforces the cancellation cutoff for customers but not for the owner", () => {
    const { booking } = book(at("14:00", "2030-06-07"));
    const lateNow = booking.startAt - 2 * HOUR;
    expect(() => cancelBooking(booking.id, { by: "customer", db: t.db, now: lateNow })).toThrow(CutoffError);
    expect(cancelBooking(booking.id, { by: "owner", db: t.db, now: lateNow }).status).toBe("cancelled");
  });

  it("cannot cancel a completed booking; unknown ids 404", () => {
    const { booking } = book(at("10:00", "2030-06-07"));
    run(t.db, "UPDATE bookings SET status = 'completed' WHERE id = ?", booking.id);
    expect(() => cancelBooking(booking.id, { by: "owner", db: t.db, now: NOW })).toThrow(BookingStateError);
    expect(() => cancelBooking("missing", { by: "owner", db: t.db })).toThrow(/not found/i);
  });
});

describe("rescheduling", () => {
  it("moves the booking atomically: old slot freed, new slot claimed, reminders re-planned", () => {
    const { booking } = book(at("09:00", "2030-06-10"));
    const moved = rescheduleBooking(booking.id, at("15:00", "2030-06-10"), { by: "customer", db: t.db, now: NOW });
    expect(moved).toMatchObject({ startAt: at("15:00", "2030-06-10"), rescheduleCount: 1, status: "confirmed" });
    expect(locksFor(booking.id)).toBe(6);
    expect(() => book(at("15:00", "2030-06-10"))).toThrow(SlotUnavailableError);
    expect(() => book(at("09:00", "2030-06-10"))).not.toThrow();
  });

  it("a failed move leaves the original booking completely intact", () => {
    const { booking } = book(at("09:00", "2030-06-11"));
    book(at("10:00", "2030-06-11"));
    expect(() => rescheduleBooking(booking.id, at("10:00", "2030-06-11"), { by: "customer", db: t.db, now: NOW })).toThrow(SlotUnavailableError);
    const after = getBooking(booking.id, t.db)!;
    expect(after.startAt).toBe(at("09:00", "2030-06-11"));
    expect(after.rescheduleCount).toBe(0);
    expect(locksFor(booking.id)).toBe(6);
  });

  it("may shift into a window overlapping its own current slot", () => {
    const long = createService({ name: "Hour", slug: "hour", durationMin: 60, priceMinor: 0 }, t.db);
    const { booking } = book(at("10:00", "2030-06-12"), long.id);
    expect(rescheduleBooking(booking.id, at("10:30", "2030-06-12"), { by: "customer", db: t.db, now: NOW }).startAt).toBe(at("10:30", "2030-06-12"));
  });

  it("applies the cutoff for customers and refuses to move cancelled bookings", () => {
    const { booking } = book(at("12:00", "2030-06-13"));
    expect(() => rescheduleBooking(booking.id, at("13:00", "2030-06-13"), { by: "customer", db: t.db, now: booking.startAt - HOUR })).toThrow(CutoffError);
    cancelBooking(booking.id, { by: "owner", db: t.db, now: NOW });
    expect(() => rescheduleBooking(booking.id, at("13:00", "2030-06-13"), { by: "owner", db: t.db, now: NOW })).toThrow(BookingStateError);
  });
});

describe("deposit holds (payments on)", () => {
  it("holds the slot as pending_payment until it expires, then releases it", () => {
    const dep = createService({ name: "Deposit", slug: "deposit", durationMin: 30, priceMinor: 100000, depositMinor: 20000 }, t.db);
    const { booking } = createBooking({ serviceId: dep.id, startAt: at("09:00", "2030-06-14"), ...who() }, { db: t.db, now: NOW, paymentsEnabled: true });
    expect(booking).toMatchObject({ status: "pending_payment", paymentStatus: "pending", depositMinor: 20000 });
    expect(booking.holdExpiresAt).toBe(NOW + 15 * MIN);
    // still held
    expect(() => createBooking({ serviceId: dep.id, startAt: at("09:00", "2030-06-14"), ...who() }, { db: t.db, now: NOW + 5 * MIN, paymentsEnabled: true })).toThrow(SlotUnavailableError);
    // hold lapses -> slot free again, the stale booking becomes cancelled
    const later = NOW + 16 * MIN;
    const next = createBooking({ serviceId: dep.id, startAt: at("09:00", "2030-06-14"), ...who() }, { db: t.db, now: later, paymentsEnabled: true });
    expect(next.booking.status).toBe("pending_payment");
    expect(getBooking(booking.id, t.db)).toMatchObject({ status: "cancelled", cancelledBy: "system" });
    expect(locksFor(booking.id)).toBe(0);
  });

  it("services without a deposit confirm immediately even when payments are on; with payments off the deposit is ignored", () => {
    expect(createBooking({ serviceId: svc.id, startAt: at("09:00", "2030-06-17"), ...who() }, { db: t.db, now: NOW, paymentsEnabled: true }).booking.status).toBe("confirmed");
    const dep = createService({ name: "Deposit2", slug: "deposit2", durationMin: 30, priceMinor: 50000, depositMinor: 10000 }, t.db);
    expect(createBooking({ serviceId: dep.id, startAt: at("10:00", "2030-06-17"), ...who() }, { db: t.db, now: NOW, paymentsEnabled: false }).booking.status).toBe("confirmed");
  });

  it("releaseExpiredHolds is a no-op when nothing expired", () => {
    expect(releaseExpiredHolds(t.db, NOW - 1000 * HOUR)).toBe(0);
  });
});

describe("database-level guarantees", () => {
  it("slot_locks rejects an overlapping unit even when application checks are bypassed", () => {
    const { booking } = book(at("09:00", "2030-06-18"));
    const other = book(at("10:00", "2030-06-18")).booking;
    expect(() => run(t.db, "UPDATE slot_locks SET unit_start = ? WHERE booking_id = ? AND unit_start = ?", at("09:00", "2030-06-18"), other.id, at("10:00", "2030-06-18"))).toThrow(/UNIQUE/i);
    expect(() => run(t.db, "INSERT INTO slot_locks (unit_start, booking_id) VALUES (?, ?)", at("09:05", "2030-06-18"), other.id)).toThrow(/UNIQUE/i);
    expect(booking.id).not.toBe(other.id);
  });

  it("rejects malformed rows via CHECK constraints", () => {
    expect(() => run(t.db, "INSERT INTO availability_rules (weekday, start_min, end_min) VALUES (9, 0, 60)")).toThrow();
    expect(() => run(t.db, "INSERT INTO availability_rules (weekday, start_min, end_min) VALUES (1, 600, 600)")).toThrow();
    expect(() => run(t.db, "INSERT INTO date_exceptions (date, kind) VALUES ('06/03/2030', 'closed')")).toThrow();
  });
});

describe("time zones end to end", () => {
  it("stores the instant in UTC no matter which zone the customer picked", () => {
    const ny = DateTime.fromISO("2030-06-19T09:00", { zone: "UTC" }).toMillis();
    const a = createBooking({ serviceId: svc.id, startAt: ny, name: "Z", email: "z1@example.com", timezone: "America/New_York" }, { db: t.db, now: NOW, paymentsEnabled: false }).booking;
    expect(a.startAt).toBe(ny);
    expect(DateTime.fromMillis(a.startAt, { zone: a.customerTz }).toFormat("HH:mm")).toBe("05:00"); // EDT = UTC-4
  });
});
