import { apiError, limit } from "@/lib/api";
import { getBooking } from "@/lib/bookings";
import { bookingIcs } from "@/lib/ics";
import { getSettings } from "@/lib/settings";
import { verifyManageToken } from "@/lib/tokens";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const limited = limit(req, "ics", 60, 60_000);
  if (limited) return limited;
  const { id } = await ctx.params;
  const t = new URL(req.url).searchParams.get("t");
  if (!verifyManageToken(id, t)) return apiError(403, "forbidden", "This link is not valid.");
  const b = getBooking(id);
  if (!b) return apiError(404, "not_found", "Booking not found");
  const body = bookingIcs(b, { name: getSettings().businessName });
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="appointment-${id}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
