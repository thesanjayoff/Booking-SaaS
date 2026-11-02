/**
 * Applies payment facts to bookings. Every function here is IDEMPOTENT and state-based:
 * the checkout callback, the webhook, and webhook retries can all arrive (in any order,
 * any number of times) and converge on the same result.
 */
import { get, run, tx, type Db } from "../db";
import { afterConfirmed, getBooking, UNIT_MS, type Booking } from "../bookings";
import { slotIsOffered } from "../availability/store";
import { getServiceById } from "../services";
import { enqueue } from "../queue";
import { isUniqueViolation } from "../db";

export type PaymentOutcome =
  | "confirmed"
  | "already_paid"
  | "reconfirmed_after_expiry"
  | "refund_queued"
  | "amount_mismatch"
  | "unknown_order";

export function applyPaymentCaptured(
  db: Db,
  p: { orderId: string; paymentId: string; amountMinor: number; now?: number },
): { outcome: PaymentOutcome; bookingId?: string } {
  const now = p.now ?? Date.now();
  return tx(db, () => {
    const row = get<{ id: string }>(db, "SELECT id FROM bookings WHERE razorpay_order_id = ?", p.orderId);
    if (!row) return { outcome: "unknown_order" as const };
    const b = getBooking(row.id, db)!;

    if (b.paymentStatus === "paid" || b.paymentStatus === "refunded") return { outcome: "already_paid" as const, bookingId: b.id };
    if (p.amountMinor < b.depositMinor) {
      // Someone paid less than the deposit: do not confirm. Surface it for the owner.
      run(db, "UPDATE bookings SET razorpay_payment_id = ?, updated_at = ? WHERE id = ?", p.paymentId, now, b.id);
      return { outcome: "amount_mismatch" as const, bookingId: b.id };
    }

    if (b.status === "pending_payment") {
      run(db, `UPDATE bookings SET status = 'confirmed', payment_status = 'paid', razorpay_payment_id = ?, hold_expires_at = NULL, updated_at = ? WHERE id = ?`, p.paymentId, now, b.id);
      afterConfirmed(db, getBooking(b.id, db)!, now);
      return { outcome: "confirmed" as const, bookingId: b.id };
    }

    if (b.status === "confirmed" || b.status === "completed" || b.status === "no_show") {
      run(db, "UPDATE bookings SET payment_status = 'paid', razorpay_payment_id = ?, updated_at = ? WHERE id = ?", p.paymentId, now, b.id);
      return { outcome: "confirmed" as const, bookingId: b.id };
    }

    if (b.status === "cancelled" && b.cancelledBy === "system") {
      // Paid after the hold expired. If the slot is still free, honour the booking; otherwise refund.
      if (tryReclaim(db, b, now)) {
        run(db, `UPDATE bookings SET status = 'confirmed', payment_status = 'paid', razorpay_payment_id = ?, hold_expires_at = NULL,
                  cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL, updated_at = ? WHERE id = ?`, p.paymentId, now, b.id);
        afterConfirmed(db, getBooking(b.id, db)!, now);
        return { outcome: "reconfirmed_after_expiry" as const, bookingId: b.id };
      }
    }

    // Cancelled by someone, or the slot is gone: money must go back.
    run(db, "UPDATE bookings SET payment_status = 'refund_needed', razorpay_payment_id = ?, updated_at = ? WHERE id = ?", p.paymentId, now, b.id);
    enqueue(db, { type: "refund", payload: { bookingId: b.id }, dedupeKey: `refund:${b.id}`, maxAttempts: 8 }, now);
    return { outcome: "refund_queued" as const, bookingId: b.id };
  });
}

function tryReclaim(db: Db, b: Booking, now: number): boolean {
  const service = getServiceById(b.serviceId, db);
  if (!service) return false;
  // Minimum notice is deliberately waived (the customer already committed and paid); the slot just has to be free.
  if (!slotIsOffered(db, service, b.startAt, { now, ignoreNotice: true })) return false;
  try {
    for (let u = b.blockStart; u < b.blockEnd; u += UNIT_MS) db.prepare("INSERT INTO slot_locks (unit_start, booking_id) VALUES (?, ?)").run(u, b.id);
    return true;
  } catch (e) {
    run(db, "DELETE FROM slot_locks WHERE booking_id = ?", b.id); // no half-claimed windows
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

export function applyRefundProcessed(db: Db, paymentId: string, now = Date.now()) {
  run(db, "UPDATE bookings SET payment_status = 'refunded', updated_at = ? WHERE razorpay_payment_id = ? AND payment_status != 'paid'", now, paymentId);
}
