/**
 * Booking lifecycle. The invariant "no two active bookings overlap" is enforced by the
 * DATABASE, in two layers:
 *   1. every write runs in BEGIN IMMEDIATE, so concurrent writers (other requests or other
 *      processes) serialize and each re-checks availability against committed state;
 *   2. each booking claims one `slot_locks` row per 5-minute unit it blocks (appointment +
 *      buffers). unit_start is the PRIMARY KEY, so even if layer 1 were bypassed, an
 *      overlapping insert fails with a constraint violation and the transaction rolls back.
 */
import { getDb, all, get, run, tx, isUniqueViolation, type Db } from "./db";
import { newId } from "./ids";
import { MINUTE } from "./availability/engine";
import { slotIsOffered } from "./availability/store";
import { getServiceById, type Service } from "./services";
import { getSettings } from "./settings";
import { enqueue, cancelQueued } from "./queue";
import { scheduleReminders, cancelReminders } from "./reminders";
import { paymentsEnabled } from "./payments/config";

export const UNIT_MS = 5 * MINUTE;

export type BookingStatus = "pending_payment" | "confirmed" | "cancelled" | "completed" | "no_show";
export type PaymentStatus = "none" | "pending" | "paid" | "refunded" | "refund_needed";

export type Booking = {
  id: string;
  serviceId: string;
  serviceName: string;
  serviceSlug: string;
  location: string;
  customerId: string;
  name: string;
  email: string;
  phone: string;
  startAt: number;
  endAt: number;
  blockStart: number;
  blockEnd: number;
  status: BookingStatus;
  customerTz: string;
  notes: string;
  priceMinor: number;
  depositMinor: number;
  currency: string;
  paymentStatus: PaymentStatus;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  holdExpiresAt: number | null;
  googleEventId: string | null;
  meetUrl: string | null;
  cancelledAt: number | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  rescheduleCount: number;
  createdAt: number;
};

export class SlotUnavailableError extends Error {
  constructor(public reason: "taken" | "not_offered" = "taken") {
    super(reason === "taken" ? "That time was just taken. Please pick another slot." : "That time is not available.");
  }
}
export class BookingNotFoundError extends Error {
  constructor() {
    super("Booking not found");
  }
}
export class BookingStateError extends Error {}
export class CutoffError extends Error {
  constructor(public hours: number) {
    super(`Changes are only possible up to ${hours} hours before the appointment. Please contact us directly.`);
  }
}

const SELECT = `
  SELECT b.*, s.name AS service_name, s.slug AS service_slug, s.location AS service_location
  FROM bookings b JOIN services s ON s.id = b.service_id`;

const toBooking = (r: any): Booking => ({
  id: r.id,
  serviceId: r.service_id,
  serviceName: r.service_name,
  serviceSlug: r.service_slug,
  location: r.service_location,
  customerId: r.customer_id,
  name: r.contact_name,
  email: r.contact_email,
  phone: r.contact_phone,
  startAt: r.start_at,
  endAt: r.end_at,
  blockStart: r.block_start,
  blockEnd: r.block_end,
  status: r.status,
  customerTz: r.customer_tz,
  notes: r.notes,
  priceMinor: r.price_minor,
  depositMinor: r.deposit_minor,
  currency: r.currency,
  paymentStatus: r.payment_status,
  razorpayOrderId: r.razorpay_order_id,
  razorpayPaymentId: r.razorpay_payment_id,
  holdExpiresAt: r.hold_expires_at,
  googleEventId: r.google_event_id,
  meetUrl: r.meet_url,
  cancelledAt: r.cancelled_at,
  cancelReason: r.cancel_reason,
  cancelledBy: r.cancelled_by,
  rescheduleCount: r.reschedule_count,
  createdAt: r.created_at,
});

export function getBooking(id: string, db: Db = getDb()): Booking | null {
  const r = get(db, `${SELECT} WHERE b.id = ?`, id);
  return r ? toBooking(r) : null;
}

/* ------------------------------------------------------------------ slot locks */

function claimUnits(db: Db, bookingId: string, blockStart: number, blockEnd: number) {
  if (blockStart % UNIT_MS !== 0 || blockEnd % UNIT_MS !== 0) throw new SlotUnavailableError("not_offered");
  const insert = db.prepare("INSERT INTO slot_locks (unit_start, booking_id) VALUES (?, ?)");
  try {
    for (let u = blockStart; u < blockEnd; u += UNIT_MS) insert.run(u, bookingId);
  } catch (e) {
    if (isUniqueViolation(e)) throw new SlotUnavailableError("taken");
    throw e;
  }
}

const releaseUnits = (db: Db, bookingId: string) => void run(db, "DELETE FROM slot_locks WHERE booking_id = ?", bookingId);

/** Cancels unpaid holds whose time ran out and frees their slots. Safe to call anywhere inside/outside a tx. */
export function releaseExpiredHolds(db: Db, now = Date.now()): number {
  const expired = all<{ id: string }>(db, "SELECT id FROM bookings WHERE status = 'pending_payment' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?", now);
  for (const { id } of expired) {
    run(
      db,
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'system',
         cancel_reason = 'Deposit not paid in time', payment_status = 'none', updated_at = ? WHERE id = ?`,
      now, now, id,
    );
    releaseUnits(db, id);
  }
  return expired.length;
}

/* ------------------------------------------------------------------ side effects (outbox) */

/** Everything that must happen once a booking is confirmed. Idempotent via dedupe keys. */
export function afterConfirmed(db: Db, b: Booking, now = Date.now()) {
  const v = b.rescheduleCount;
  enqueue(db, { type: "notify", payload: { bookingId: b.id, kind: "confirmed" }, dedupeKey: `notify:confirmed:${b.id}:${v}` }, now);
  enqueue(db, { type: "notify", payload: { bookingId: b.id, kind: "owner_new" }, dedupeKey: `notify:owner_new:${b.id}:${v}` }, now);
  scheduleReminders(db, b, getSettings(db), now);
  queueCalendarSync(db, b.id, now);
}

export function queueCalendarSync(db: Db, bookingId: string, now = Date.now()) {
  enqueue(db, { type: "gcal.push", payload: { bookingId }, dedupeKey: `gcal.push:${bookingId}:${now}`, maxAttempts: 6 }, now);
}

/* ------------------------------------------------------------------ create */

export type CreateBookingInput = {
  serviceId: string;
  startAt: number;
  name: string;
  email: string;
  phone?: string;
  notes?: string;
  timezone: string;
  /** Client-generated; replaying the same key returns the original booking instead of a second one. */
  idempotencyKey?: string;
};

export function createBooking(
  input: CreateBookingInput,
  opts: { db?: Db; now?: number; paymentsEnabled?: boolean } = {},
): { booking: Booking; created: boolean } {
  const db = opts.db ?? getDb();
  const now = opts.now ?? Date.now();
  const payOn = opts.paymentsEnabled ?? paymentsEnabled();

  const id = tx(db, () => {
    if (input.idempotencyKey) {
      const prior = get<{ id: string }>(db, "SELECT id FROM bookings WHERE idempotency_key = ?", input.idempotencyKey);
      if (prior) return { id: prior.id, created: false };
    }
    releaseExpiredHolds(db, now);

    const service = getServiceById(input.serviceId, db);
    if (!service || !service.active) throw new SlotUnavailableError("not_offered");
    // Re-validate against hours, notice, horizon, breaks, holidays, Google events and committed bookings.
    if (!slotIsOffered(db, service, input.startAt, { now })) throw new SlotUnavailableError("not_offered");

    const email = input.email.trim().toLowerCase();
    const existing = get<{ id: string }>(db, "SELECT id FROM customers WHERE email = ?", email);
    let customerId = existing?.id;
    if (!customerId) {
      customerId = newId();
      run(db, "INSERT INTO customers (id, name, email, phone, created_at) VALUES (?,?,?,?,?)", customerId, input.name, email, input.phone ?? "", now);
    } else if (input.phone) {
      run(db, "UPDATE customers SET phone = ? WHERE id = ? AND phone = ''", input.phone, customerId);
    }

    const needsDeposit = payOn && service.depositMinor > 0;
    const bookingId = newId();
    const endAt = input.startAt + service.durationMin * MINUTE;
    const blockStart = input.startAt - service.bufferBeforeMin * MINUTE;
    const blockEnd = endAt + service.bufferAfterMin * MINUTE;
    const hold = needsDeposit ? now + getSettings(db).holdMinutes * MINUTE : null;

    run(
      db,
      `INSERT INTO bookings (id, service_id, customer_id, contact_name, contact_email, contact_phone, start_at, end_at,
         block_start, block_end, status, customer_tz, notes, price_minor, deposit_minor, currency, payment_status,
         hold_expires_at, idempotency_key, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      bookingId, service.id, customerId, input.name, email, input.phone ?? "", input.startAt, endAt, blockStart, blockEnd,
      needsDeposit ? "pending_payment" : "confirmed", input.timezone, input.notes ?? "", service.priceMinor,
      needsDeposit ? service.depositMinor : 0, service.currency, needsDeposit ? "pending" : "none", hold,
      input.idempotencyKey ?? null, now, now,
    );
    claimUnits(db, bookingId, blockStart, blockEnd); // <- the constraint that makes double-booking impossible

    if (!needsDeposit) afterConfirmed(db, getBooking(bookingId, db)!, now);
    return { id: bookingId, created: true };
  });

  return { booking: getBooking(id.id, db)!, created: id.created };
}

/* ------------------------------------------------------------------ cancel / reschedule */

function loadForChange(db: Db, id: string): Booking {
  const b = getBooking(id, db);
  if (!b) throw new BookingNotFoundError();
  return b;
}

function checkCutoff(db: Db, b: Booking, now: number) {
  const hours = getSettings(db).cancelCutoffHours;
  if (b.startAt <= now) throw new BookingStateError("This appointment has already started.");
  if (hours > 0 && b.startAt - now < hours * 60 * MINUTE) throw new CutoffError(hours);
}

export function cancelBooking(
  id: string,
  opts: { by: "customer" | "owner" | "system" | "google"; reason?: string; db?: Db; now?: number } = { by: "owner" },
): Booking {
  const db = opts.db ?? getDb();
  const now = opts.now ?? Date.now();
  tx(db, () => {
    const b = loadForChange(db, id);
    if (b.status === "cancelled") return; // idempotent
    if (b.status !== "confirmed" && b.status !== "pending_payment") throw new BookingStateError(`A ${b.status.replace("_", " ")} booking cannot be cancelled.`);
    if (opts.by === "customer") checkCutoff(db, b, now);

    const refund = b.paymentStatus === "paid";
    run(
      db,
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?,
         payment_status = ?, hold_expires_at = NULL, updated_at = ? WHERE id = ?`,
      now, opts.by, (opts.reason ?? "").slice(0, 300), refund ? "refund_needed" : b.paymentStatus === "pending" ? "none" : b.paymentStatus, now, id,
    );
    releaseUnits(db, id);
    cancelReminders(db, id, now);
    cancelQueued(db, `gcal.push:${id}:`, now);

    if (refund) enqueue(db, { type: "refund", payload: { bookingId: id }, dedupeKey: `refund:${id}`, maxAttempts: 8 }, now);
    // The cancellation notice must not be skipped just because the confirmation was.
    enqueue(db, { type: "notify", payload: { bookingId: id, kind: "cancelled" }, dedupeKey: `notify:cancelled:${id}` }, now);
    if (b.status === "confirmed") enqueue(db, { type: "notify", payload: { bookingId: id, kind: "owner_cancelled" }, dedupeKey: `notify:owner_cancelled:${id}` }, now);
    queueCalendarSync(db, id, now);
  });
  return getBooking(id, db)!;
}

export function rescheduleBooking(
  id: string,
  newStartAt: number,
  opts: { by: "customer" | "owner"; db?: Db; now?: number } = { by: "owner" },
): Booking {
  const db = opts.db ?? getDb();
  const now = opts.now ?? Date.now();
  tx(db, () => {
    releaseExpiredHolds(db, now);
    const b = loadForChange(db, id);
    if (b.status !== "confirmed") throw new BookingStateError(b.status === "pending_payment" ? "Finish the deposit payment first, or cancel and rebook." : "This booking can no longer be changed.");
    if (opts.by === "customer") checkCutoff(db, b, now);
    if (newStartAt === b.startAt) return;

    const service = getServiceById(b.serviceId, db) as Service;
    // The booking's own old slot must not block its new one: free it (rolled back with the tx if the move fails).
    releaseUnits(db, id);
    if (!slotIsOffered(db, service, newStartAt, { now, excludeBookingId: id })) throw new SlotUnavailableError("not_offered");

    const endAt = newStartAt + service.durationMin * MINUTE;
    const blockStart = newStartAt - service.bufferBeforeMin * MINUTE;
    const blockEnd = endAt + service.bufferAfterMin * MINUTE;
    run(
      db,
      `UPDATE bookings SET start_at = ?, end_at = ?, block_start = ?, block_end = ?, reschedule_count = reschedule_count + 1, updated_at = ? WHERE id = ?`,
      newStartAt, endAt, blockStart, blockEnd, now, id,
    );
    claimUnits(db, id, blockStart, blockEnd);

    cancelReminders(db, id, now);
    const updated = getBooking(id, db)!;
    scheduleReminders(db, updated, getSettings(db), now);
    enqueue(db, { type: "notify", payload: { bookingId: id, kind: "rescheduled" }, dedupeKey: `notify:rescheduled:${id}:${updated.rescheduleCount}` }, now);
    enqueue(db, { type: "notify", payload: { bookingId: id, kind: "owner_rescheduled" }, dedupeKey: `notify:owner_rescheduled:${id}:${updated.rescheduleCount}` }, now);
    queueCalendarSync(db, id, now);
  });
  return getBooking(id, db)!;
}

/** Owner marks a past/confirmed appointment as done or a no-show. Slot stays reserved (history). */
export function setOutcome(id: string, status: "completed" | "no_show" | "confirmed", db: Db = getDb(), now = Date.now()): Booking {
  tx(db, () => {
    const b = loadForChange(db, id);
    if (!["confirmed", "completed", "no_show"].includes(b.status)) throw new BookingStateError("Only confirmed bookings can be marked.");
    run(db, "UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?", status, now, id);
  });
  return getBooking(id, db)!;
}
