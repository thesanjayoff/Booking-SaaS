import { apiError, json, limit } from "@/lib/api";
import { getDb } from "@/lib/db";
import { getServiceBySlug } from "@/lib/services";
import { getSettings } from "@/lib/settings";
import { getSlots } from "@/lib/availability/store";
import { getBooking } from "@/lib/bookings";
import { verifyManageToken } from "@/lib/tokens";
import { MAX_SLOT_RANGE_DAYS, slotsQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const limited = limit(req, "slots", 120, 60_000);
  if (limited) return limited;

  const url = new URL(req.url);
  const parsed = slotsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return apiError(422, "validation_failed", "Invalid query: service, from and to (ISO 8601) are required.");
  const q = parsed.data;

  const from = Date.parse(q.from);
  const to = Date.parse(q.to);
  if (!(to > from) || to - from > MAX_SLOT_RANGE_DAYS * 86_400_000) {
    return apiError(422, "bad_range", `Range must be positive and at most ${MAX_SLOT_RANGE_DAYS} days.`);
  }

  const db = getDb();
  const service = getServiceBySlug(q.service, db);
  if (!service || !service.active) return apiError(404, "not_found", "Service not found");

  let excludeBookingId: string | undefined;
  if (q.reschedule) {
    if (!verifyManageToken(q.reschedule, q.t)) return apiError(403, "forbidden", "Invalid link");
    const b = getBooking(q.reschedule, db);
    if (!b || b.serviceId !== service.id) return apiError(404, "not_found", "Booking not found");
    excludeBookingId = b.id;
  }

  const slots = getSlots(service.id, { from, to }, { db, excludeBookingId });
  return json({
    service: service.slug,
    businessTimezone: getSettings(db).timezone,
    slots: slots.map((ms) => new Date(ms).toISOString()),
  });
}
