import { z } from "zod";
import { DateTime } from "luxon";
import { getDb, all, get, run, type Db } from "../db";
import { getSettings } from "../settings";
import { getServiceById, type Service } from "../services";
import {
  computeSlots, isSlotOffered, MINUTE,
  type DateException, type Interval, type SlotQuery, type WeeklyRule,
} from "./engine";

/** Bookings in these states occupy time. (Cancelled ones released their slot_locks.) */
export const ACTIVE_STATUSES = ["pending_payment", "confirmed", "completed", "no_show"] as const;

export function loadRules(db: Db = getDb()): (WeeklyRule & { id: number })[] {
  return all<any>(db, "SELECT id, weekday, start_min, end_min, kind, service_id FROM availability_rules ORDER BY weekday, start_min").map((r) => ({
    id: r.id, weekday: r.weekday, startMin: r.start_min, endMin: r.end_min, kind: r.kind, serviceId: r.service_id,
  }));
}

export function loadExceptions(db: Db = getDb()): (DateException & { id: number; label: string })[] {
  return all<any>(db, "SELECT id, date, kind, start_min, end_min, label, yearly FROM date_exceptions ORDER BY date, start_min").map((r) => ({
    id: r.id, date: r.date, kind: r.kind, startMin: r.start_min, endMin: r.end_min, label: r.label, yearly: !!r.yearly,
  }));
}

/**
 * Time that is already taken in [from, to): booking blocks (appointment + buffers) and
 * events from the connected Google calendar. Expired unpaid holds do not count.
 */
export function loadBusy(db: Db, from: number, to: number, opts: { excludeBookingId?: string; now?: number } = {}): Interval[] {
  const now = opts.now ?? Date.now();
  const bookings = all<{ block_start: number; block_end: number }>(
    db,
    `SELECT block_start, block_end FROM bookings
     WHERE status != 'cancelled' AND block_end > ? AND block_start < ? AND id != ?
       AND NOT (status = 'pending_payment' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?)`,
    from, to, opts.excludeBookingId ?? "", now,
  ).map((r) => ({ start: r.block_start, end: r.block_end }));
  const external = all<{ start_at: number; end_at: number }>(
    db,
    "SELECT start_at, end_at FROM external_busy WHERE end_at > ? AND start_at < ?",
    from, to,
  ).map((r) => ({ start: r.start_at, end: r.end_at }));
  return [...bookings, ...external];
}

export function buildQuery(
  db: Db,
  service: Service,
  range: { from: number; to: number },
  opts: { excludeBookingId?: string; now?: number; ignoreNotice?: boolean } = {},
): SlotQuery {
  const s = getSettings(db);
  const now = opts.now ?? Date.now();
  // Look a little wider for busy time so buffers/overlaps at the edges are caught.
  const pad = 24 * 60 * MINUTE;
  return {
    timezone: s.timezone,
    rules: loadRules(db),
    exceptions: loadExceptions(db),
    serviceId: service.id,
    durationMin: service.durationMin,
    bufferBeforeMin: service.bufferBeforeMin,
    bufferAfterMin: service.bufferAfterMin,
    intervalMin: service.slotIntervalMin ?? s.slotIntervalMin,
    busy: loadBusy(db, range.from - pad, range.to + pad, { ...opts, now }),
    now,
    minNoticeMin: opts.ignoreNotice ? 0 : s.minNoticeMin,
    maxAdvanceDays: s.maxAdvanceDays,
    rangeStart: range.from,
    rangeEnd: range.to,
  };
}

export function getSlots(
  serviceId: string,
  range: { from: number; to: number },
  opts: { db?: Db; excludeBookingId?: string; now?: number } = {},
): number[] {
  const db = opts.db ?? getDb();
  const service = getServiceById(serviceId, db);
  if (!service || !service.active) return [];
  return computeSlots(buildQuery(db, service, range, opts));
}

export function slotIsOffered(db: Db, service: Service, start: number, opts: { excludeBookingId?: string; now?: number; ignoreNotice?: boolean } = {}): boolean {
  return isSlotOffered(buildQuery(db, service, { from: start, to: start + 1 }, opts), start);
}

/* ------------------------------------------------------------------ admin editing */

const minutes = z.number().int().min(0).max(1440);

export const ruleInputSchema = z
  .object({
    weekday: z.number().int().min(1).max(7),
    startMin: minutes,
    endMin: minutes,
    kind: z.enum(["work", "break"]),
    serviceId: z.string().max(40).nullable().default(null),
  })
  .refine((r) => r.endMin > r.startMin, { path: ["endMin"], message: "End must be after start" });

export function addRule(input: z.input<typeof ruleInputSchema>, db: Db = getDb()) {
  const r = ruleInputSchema.parse(input);
  run(db, "INSERT INTO availability_rules (weekday, start_min, end_min, kind, service_id) VALUES (?,?,?,?,?)", r.weekday, r.startMin, r.endMin, r.kind, r.serviceId);
}
export const deleteRule = (id: number, db: Db = getDb()) => void run(db, "DELETE FROM availability_rules WHERE id = ?", id);

export const exceptionInputSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => DateTime.fromISO(d).isValid, "Invalid date"),
    kind: z.enum(["closed", "open"]),
    startMin: minutes.nullable().default(null),
    endMin: minutes.nullable().default(null),
    label: z.string().trim().max(100).default(""),
    yearly: z.boolean().default(false),
  })
  .refine((e) => (e.kind === "closed" ? e.startMin == null && e.endMin == null : e.startMin != null && e.endMin != null && e.endMin > e.startMin), {
    message: "Custom hours need a start and an end after it",
  });

export function addException(input: z.input<typeof exceptionInputSchema>, db: Db = getDb()) {
  const e = exceptionInputSchema.parse(input);
  run(db, "INSERT INTO date_exceptions (date, kind, start_min, end_min, label, yearly) VALUES (?,?,?,?,?,?)", e.date, e.kind, e.startMin, e.endMin, e.label, e.yearly ? 1 : 0);
}
export const deleteException = (id: number, db: Db = getDb()) => void run(db, "DELETE FROM date_exceptions WHERE id = ?", id);

/** Replace all global weekly hours for the given weekday (admin "weekly hours" editor). */
export function replaceDayRules(weekday: number, ranges: { startMin: number; endMin: number; kind: "work" | "break" }[], db: Db = getDb()) {
  const parsed = ranges.map((r) => ruleInputSchema.parse({ ...r, weekday, serviceId: null }));
  db.exec("BEGIN IMMEDIATE");
  try {
    run(db, "DELETE FROM availability_rules WHERE weekday = ? AND service_id IS NULL", weekday);
    for (const r of parsed) addRule(r, db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const hasAnyRules = (db: Db = getDb()) => !!get(db, "SELECT 1 FROM availability_rules LIMIT 1");
