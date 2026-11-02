import { getDb, run, type Db } from "../db";
import { env } from "../env";
import { getSettings } from "../settings";
import type { Booking } from "../bookings";
import { createOrder } from "./razorpay";

export type CheckoutParams = {
  provider: "razorpay";
  keyId: string;
  orderId: string;
  amount: number;
  currency: string;
  businessName: string;
  description: string;
  prefill: { name: string; email: string; contact: string };
  holdExpiresAt: number | null;
};

/**
 * Creates (once) the Razorpay order for a booking's deposit and returns what Checkout.js needs.
 * Safe to call again: an existing order is reused, never duplicated. The browser only ever
 * sees the public key id; the secret stays on the server.
 */
export async function startDepositPayment(booking: Booking, db: Db = getDb()): Promise<CheckoutParams> {
  let orderId = booking.razorpayOrderId;
  if (!orderId) {
    const order = await createOrder({
      amountMinor: booking.depositMinor,
      currency: booking.currency,
      receipt: booking.id,
      notes: { booking_id: booking.id, service: booking.serviceName },
    });
    // Conditional update: if two requests raced, the first order wins and we adopt it.
    run(db, "UPDATE bookings SET razorpay_order_id = ? WHERE id = ? AND razorpay_order_id IS NULL", order.id, booking.id);
    const row = db.prepare("SELECT razorpay_order_id AS o FROM bookings WHERE id = ?").get(booking.id) as { o: string };
    orderId = row.o;
  }
  return {
    provider: "razorpay",
    keyId: env().RAZORPAY_KEY_ID!,
    orderId,
    amount: booking.depositMinor,
    currency: booking.currency,
    businessName: getSettings(db).businessName,
    description: `Deposit – ${booking.serviceName}`,
    prefill: { name: booking.name, email: booking.email, contact: booking.phone },
    holdExpiresAt: booking.holdExpiresAt,
  };
}
