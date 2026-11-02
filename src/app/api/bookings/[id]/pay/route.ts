import { apiError, json, limit, readBody } from "@/lib/api";
import { getBooking } from "@/lib/bookings";
import { getDb } from "@/lib/db";
import { paymentsEnabled } from "@/lib/payments/config";
import { startDepositPayment } from "@/lib/payments/checkout";
import { verifyManageToken } from "@/lib/tokens";
import { manageSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** (Re)open the deposit checkout for a booking that is still waiting for payment. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const limited = limit(req, "pay", 20, 10 * 60_000);
  if (limited) return limited;
  if (!paymentsEnabled()) return apiError(404, "not_found", "Payments are not enabled");
  const { id } = await ctx.params;
  const body = await readBody(req, manageSchema);
  if (!body.ok) return body.res;
  if (!verifyManageToken(id, body.data.t)) return apiError(403, "forbidden", "This link is not valid.");

  const db = getDb();
  const b = getBooking(id, db);
  if (!b) return apiError(404, "not_found", "Booking not found");
  if (b.status !== "pending_payment" || (b.holdExpiresAt && b.holdExpiresAt <= Date.now())) {
    return apiError(409, "invalid_state", "This booking is no longer waiting for payment.");
  }
  try {
    return json({ payment: await startDepositPayment(b, db) });
  } catch (e) {
    console.error("order creation failed", e);
    return apiError(502, "payment_provider_error", "Could not start the payment. Please try again.");
  }
}
