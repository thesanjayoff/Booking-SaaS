import { z } from "zod";
import { apiError, json, limit, readBody } from "@/lib/api";
import { getBooking } from "@/lib/bookings";
import { getDb } from "@/lib/db";
import { paymentsEnabled } from "@/lib/payments/config";
import { applyPaymentCaptured } from "@/lib/payments/process";
import { verifyCheckoutSignature } from "@/lib/payments/razorpay";
import { verifyManageToken } from "@/lib/tokens";

export const dynamic = "force-dynamic";

const schema = z.object({
  t: z.string().min(1).max(200),
  razorpay_order_id: z.string().min(1).max(64),
  razorpay_payment_id: z.string().min(1).max(64),
  razorpay_signature: z.string().min(1).max(200),
});

/**
 * Checkout.js success callback. The signature proves Razorpay (not the browser) vouches for
 * this payment. The webhook remains the source of truth if the customer closes the tab; both
 * paths call the same idempotent function.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const limited = limit(req, "pay-verify", 30, 10 * 60_000);
  if (limited) return limited;
  if (!paymentsEnabled()) return apiError(404, "not_found", "Payments are not enabled");
  const { id } = await ctx.params;
  const body = await readBody(req, schema);
  if (!body.ok) return body.res;
  const d = body.data;
  if (!verifyManageToken(id, d.t)) return apiError(403, "forbidden", "This link is not valid.");

  const db = getDb();
  const b = getBooking(id, db);
  if (!b || b.razorpayOrderId !== d.razorpay_order_id) return apiError(404, "not_found", "Booking not found");
  if (!verifyCheckoutSignature(d.razorpay_order_id, d.razorpay_payment_id, d.razorpay_signature)) {
    return apiError(400, "bad_signature", "Payment signature could not be verified.");
  }
  // The signed callback does not carry the amount, so trust only our own order amount (set server-side).
  const result = applyPaymentCaptured(db, { orderId: d.razorpay_order_id, paymentId: d.razorpay_payment_id, amountMinor: b.depositMinor });
  return json({ outcome: result.outcome, status: getBooking(id, db)?.status });
}
