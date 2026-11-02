import { apiError, json, limit, readBody } from "@/lib/api";
import { BookingNotFoundError, BookingStateError, CutoffError, cancelBooking } from "@/lib/bookings";
import { verifyManageToken } from "@/lib/tokens";
import { cancelSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const limited = limit(req, "cancel", 20, 10 * 60_000);
  if (limited) return limited;
  const { id } = await ctx.params;
  const body = await readBody(req, cancelSchema);
  if (!body.ok) return body.res;
  if (!verifyManageToken(id, body.data.t)) return apiError(403, "forbidden", "This link is not valid.");

  try {
    const b = cancelBooking(id, { by: "customer", reason: body.data.reason });
    return json({ id: b.id, status: b.status });
  } catch (e) {
    if (e instanceof CutoffError) return apiError(403, "too_late", e.message);
    if (e instanceof BookingStateError) return apiError(409, "invalid_state", e.message);
    if (e instanceof BookingNotFoundError) return apiError(404, "not_found", e.message);
    console.error("cancel failed", e);
    return apiError(500, "server_error", "Something went wrong. Please try again.");
  }
}
