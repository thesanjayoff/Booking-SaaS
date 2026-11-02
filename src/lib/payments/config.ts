import { env, has } from "../env";

/**
 * Payments are OFF unless PAYMENTS_ENABLED=1 *and* Razorpay credentials exist.
 * When off, deposits are ignored entirely and bookings confirm immediately.
 */
export function paymentsEnabled(): boolean {
  const e = env();
  return e.PAYMENTS_ENABLED && has(e.RAZORPAY_KEY_ID) && has(e.RAZORPAY_KEY_SECRET);
}
