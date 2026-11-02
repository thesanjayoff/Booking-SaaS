import { DateTime } from "luxon";
import { apiError } from "@/lib/api";
import { isAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { listCustomers, searchBookings, type BookingFilter } from "@/lib/admin-queries";
import { toCsv } from "@/lib/csv";

export const dynamic = "force-dynamic";

const STATUSES = ["upcoming", "all", "confirmed", "pending_payment", "completed", "no_show", "cancelled"];

export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  if (!(await isAdmin())) return apiError(401, "unauthorized", "Sign in required");
  const { kind } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const db = getDb();
  const tz = getSettings(db).timezone;
  const money = (m: number) => (m / 100).toFixed(2);
  const when = (ms: number | null) => (ms ? DateTime.fromMillis(ms, { zone: tz }).toFormat("yyyy-MM-dd HH:mm") : "");
  const headers = (name: string) => ({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}-${DateTime.now().setZone(tz).toISODate()}.csv"`,
    "Cache-Control": "no-store",
  });

  if (kind === "bookings") {
    const status = STATUSES.includes(sp.get("status") ?? "") ? (sp.get("status") as BookingFilter["status"]) : "all";
    const q = (sp.get("q") ?? "").slice(0, 100) || undefined;
    const { rows } = searchBookings(db, { status, q }, 100_000, 0);
    const csv = toCsv(
      ["Booking ID", `Start (${tz})`, `End (${tz})`, "Service", "Status", "Customer", "Email", "Phone", "Price", "Currency", "Deposit", "Payment", "Notes", "Customer time zone", "Cancelled by", "Cancel reason", "Created"],
      rows.map((b) => [
        b.id, when(b.startAt), when(b.endAt), b.serviceName, b.status, b.name, b.email, b.phone, money(b.priceMinor), b.currency,
        money(b.depositMinor), b.paymentStatus, b.notes, b.customerTz, b.cancelledBy ?? "", b.cancelReason ?? "", when(b.createdAt),
      ]),
    );
    return new Response(csv, { headers: headers("bookings") });
  }

  if (kind === "customers") {
    const csv = toCsv(
      ["Name", "Email", "Phone", "Completed visits", "Cancelled", "No-shows", "Total spent", "Last visit", "Next visit", "Customer since"],
      listCustomers(db, (sp.get("q") ?? "").slice(0, 100)).map((c) => [c.name, c.email, c.phone, c.visits, c.cancelled, c.noShows, money(c.spentMinor), when(c.lastVisit), when(c.nextVisit), when(c.createdAt)]),
    );
    return new Response(csv, { headers: headers("customers") });
  }

  return apiError(404, "not_found", "Unknown export");
}
