import { apiError, json, limit, readBody } from "@/lib/api";
import { getDb } from "@/lib/db";
import { createBooking, SlotUnavailableError } from "@/lib/bookings";
import { getServiceBySlug } from "@/lib/services";
import { rateLimit } from "@/lib/ratelimit";
import { manageToken } from "@/lib/tokens";
import { createBookingSchema } from "@/lib/validation";
import { startDepositPayment } from "@/lib/payments/checkout";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const limited = limit(req, "book", 12, 10 * 60_000);
  if (limited) return limited;

  const body = await readBody(req, createBookingSchema);
  if (!body.ok) return body.res;
  const d = body.data;

  // Spoof-proof dimension: an attacker can rotate headers but not the address they claim.
  const perEmail = rateLimit(`book-email:${d.email}`, 6, 60 * 60_000);
  if (!perEmail.ok) return apiError(429, "rate_limited", "Too many booking attempts for this email address. Try again later.", { "Retry-After": String(perEmail.retryAfterSec) });

  const db = getDb();
  const service = getServiceBySlug(d.service, db);
  if (!service || !service.active) return apiError(404, "not_found", "Service not found");

  try {
    const { booking } = createBooking(
      { serviceId: service.id, startAt: Date.parse(d.start), name: d.name, email: d.email, phone: d.phone, notes: d.notes, timezone: d.timezone, idempotencyKey: d.idempotencyKey },
      { db },
    );
    const token = manageToken(booking.id);
    const payment = booking.status === "pending_payment" ? await startDepositPayment(booking, db) : null;
    return json(
      { id: booking.id, token, status: booking.status, manageUrl: `/booking/${booking.id}?t=${token}`, payment },
      201,
    );
  } catch (e) {
    if (e instanceof SlotUnavailableError) return apiError(409, e.reason === "taken" ? "slot_taken" : "slot_unavailable", e.message);
    console.error("create booking failed", e);
    return apiError(500, "server_error", "Something went wrong. Please try again.");
  }
}
