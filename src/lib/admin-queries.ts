import { DateTime } from "luxon";
import { all, get, getDb, type Db } from "./db";
import { getBooking, type Booking, type BookingStatus } from "./bookings";

const SELECT = `
  SELECT b.id FROM bookings b
  JOIN services s ON s.id = b.service_id`;

export function bookingsBetween(db: Db, from: number, to: number, opts: { includeCancelled?: boolean } = {}): Booking[] {
  const ids = all<{ id: string }>(
    db,
    `${SELECT} WHERE b.start_at >= ? AND b.start_at < ? ${opts.includeCancelled ? "" : "AND b.status != 'cancelled'"} ORDER BY b.start_at`,
    from, to,
  );
  return ids.map((r) => getBooking(r.id, db)!);
}

export function dayBounds(tz: string, now = Date.now()) {
  const d = DateTime.fromMillis(now, { zone: tz }).startOf("day");
  return { start: d.toMillis(), end: d.plus({ days: 1 }).toMillis(), date: d.toISODate()! };
}

export type Stats = {
  days: number;
  from: number;
  to: number;
  revenueMinor: number;
  depositsCollectedMinor: number;
  refundsPendingMinor: number;
  appointments: number;
  completed: number;
  noShows: number;
  cancellations: number;
  cancellationRate: number;
  upcoming: number;
  upcomingValueMinor: number;
  newCustomers: number;
  revenueByDay: { date: string; revenueMinor: number; count: number }[];
  byService: { name: string; count: number; revenueMinor: number }[];
};

/** Revenue = price of COMPLETED appointments that started in the window (money for work actually done). */
export function computeStats(db: Db, tz: string, days: number, now = Date.now()): Stats {
  const end = DateTime.fromMillis(now, { zone: tz }).startOf("day").plus({ days: 1 });
  const start = end.minus({ days });
  const from = start.toMillis();
  const to = end.toMillis();
  const n = (sql: string, ...p: number[]) => (get<{ n: number }>(db, sql, ...p)?.n ?? 0);

  const completedRows = all<{ start_at: number; price_minor: number }>(
    db, "SELECT start_at, price_minor FROM bookings WHERE status = 'completed' AND start_at >= ? AND start_at < ?", from, to,
  );
  const buckets = new Map<string, { revenueMinor: number; count: number }>();
  for (let i = 0; i < days; i++) buckets.set(start.plus({ days: i }).toISODate()!, { revenueMinor: 0, count: 0 });
  for (const r of completedRows) {
    const k = DateTime.fromMillis(r.start_at, { zone: tz }).toISODate()!;
    const b = buckets.get(k);
    if (b) {
      b.revenueMinor += r.price_minor;
      b.count++;
    }
  }

  const cancellations = n("SELECT COUNT(*) AS n FROM bookings WHERE status = 'cancelled' AND cancelled_by != 'system' AND start_at >= ? AND start_at < ?", from, to);
  const held = n("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('confirmed','completed','no_show') AND start_at >= ? AND start_at < ?", from, to);

  return {
    days, from, to,
    revenueMinor: completedRows.reduce((a, r) => a + r.price_minor, 0),
    depositsCollectedMinor: n("SELECT COALESCE(SUM(deposit_minor),0) AS n FROM bookings WHERE payment_status = 'paid' AND start_at >= ? AND start_at < ?", from, to),
    refundsPendingMinor: n("SELECT COALESCE(SUM(deposit_minor),0) AS n FROM bookings WHERE payment_status = 'refund_needed'"),
    appointments: held,
    completed: completedRows.length,
    noShows: n("SELECT COUNT(*) AS n FROM bookings WHERE status = 'no_show' AND start_at >= ? AND start_at < ?", from, to),
    cancellations,
    cancellationRate: held + cancellations ? cancellations / (held + cancellations) : 0,
    upcoming: n("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('confirmed','pending_payment') AND start_at >= ?", now),
    upcomingValueMinor: n("SELECT COALESCE(SUM(price_minor),0) AS n FROM bookings WHERE status = 'confirmed' AND start_at >= ?", now),
    newCustomers: n("SELECT COUNT(*) AS n FROM customers WHERE created_at >= ? AND created_at < ?", from, to),
    revenueByDay: [...buckets].map(([date, v]) => ({ date, ...v })),
    byService: all<any>(
      db,
      `SELECT s.name AS name, COUNT(*) AS count, COALESCE(SUM(CASE WHEN b.status = 'completed' THEN b.price_minor ELSE 0 END),0) AS revenue
       FROM bookings b JOIN services s ON s.id = b.service_id
       WHERE b.status IN ('confirmed','completed','no_show') AND b.start_at >= ? AND b.start_at < ?
       GROUP BY s.id ORDER BY revenue DESC, count DESC`, from, to,
    ).map((r) => ({ name: r.name, count: r.count, revenueMinor: r.revenue })),
  };
}

export type BookingFilter = { status?: BookingStatus | "all" | "upcoming"; q?: string; from?: number; to?: number };

export function searchBookings(db: Db, f: BookingFilter, limit = 50, offset = 0, now = Date.now()): { rows: Booking[]; total: number } {
  const where: string[] = [];
  const p: (string | number)[] = [];
  if (f.status === "upcoming") {
    where.push("b.status IN ('confirmed','pending_payment') AND b.start_at >= ?");
    p.push(now);
  } else if (f.status && f.status !== "all") {
    where.push("b.status = ?");
    p.push(f.status);
  }
  if (f.q) {
    where.push("(b.contact_name LIKE ? ESCAPE '\\' OR b.contact_email LIKE ? ESCAPE '\\' OR b.contact_phone LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')");
    const like = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
    p.push(like, like, like, like);
  }
  if (f.from != null) {
    where.push("b.start_at >= ?");
    p.push(f.from);
  }
  if (f.to != null) {
    where.push("b.start_at < ?");
    p.push(f.to);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM bookings b JOIN services s ON s.id = b.service_id ${w}`, ...p)!.n;
  const order = f.status === "upcoming" ? "ASC" : "DESC";
  const ids = all<{ id: string }>(db, `${SELECT} ${w} ORDER BY b.start_at ${order} LIMIT ? OFFSET ?`, ...p, limit, offset);
  return { rows: ids.map((r) => getBooking(r.id, db)!), total };
}

export type CustomerRow = {
  id: string;
  name: string;
  email: string;
  phone: string;
  createdAt: number;
  visits: number;
  cancelled: number;
  noShows: number;
  spentMinor: number;
  lastVisit: number | null;
  nextVisit: number | null;
};

export function listCustomers(db: Db, q = "", now = Date.now()): CustomerRow[] {
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  return all<any>(
    db,
    `SELECT c.id, c.name, c.email, c.phone, c.created_at,
       SUM(CASE WHEN b.status IN ('completed') THEN 1 ELSE 0 END) AS visits,
       SUM(CASE WHEN b.status = 'cancelled' AND b.cancelled_by != 'system' THEN 1 ELSE 0 END) AS cancelled,
       SUM(CASE WHEN b.status = 'no_show' THEN 1 ELSE 0 END) AS no_shows,
       COALESCE(SUM(CASE WHEN b.status = 'completed' THEN b.price_minor ELSE 0 END), 0) AS spent,
       MAX(CASE WHEN b.status = 'completed' THEN b.start_at END) AS last_visit,
       MIN(CASE WHEN b.status IN ('confirmed','pending_payment') AND b.start_at >= ? THEN b.start_at END) AS next_visit
     FROM customers c LEFT JOIN bookings b ON b.customer_id = c.id
     WHERE (? = '' OR c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')
     GROUP BY c.id ORDER BY MAX(b.start_at) DESC NULLS LAST, c.name`,
    now, q, like, like, like,
  ).map((r) => ({
    id: r.id, name: r.name, email: r.email, phone: r.phone, createdAt: r.created_at,
    visits: r.visits ?? 0, cancelled: r.cancelled ?? 0, noShows: r.no_shows ?? 0, spentMinor: r.spent ?? 0,
    lastVisit: r.last_visit ?? null, nextVisit: r.next_visit ?? null,
  }));
}

export const externalBusyBetween = (db: Db, from: number, to: number) =>
  all<{ event_id: string; start_at: number; end_at: number; summary: string }>(
    db, "SELECT event_id, start_at, end_at, summary FROM external_busy WHERE end_at > ? AND start_at < ? ORDER BY start_at", from, to,
  );

export { getDb };
