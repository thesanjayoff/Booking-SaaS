import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb, all } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { formatMoney } from "@/lib/services";
import { bookingsBetween, computeStats, dayBounds } from "@/lib/admin-queries";
import { BookingRow, Flash, PageHeader, StatCard } from "@/components/admin";
import { fmtDate } from "@/lib/format";
import { getBooking } from "@/lib/bookings";

export const dynamic = "force-dynamic";

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ days?: string; ok?: string; error?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const days = [7, 30, 90].includes(Number(sp.days)) ? Number(sp.days) : 30;
  const db = getDb();
  const settings = getSettings(db);
  const tz = settings.timezone;
  const now = Date.now();
  const today = dayBounds(tz, now);
  const todays = bookingsBetween(db, today.start, today.end, { includeCancelled: false });
  const stats = computeStats(db, tz, days, now);
  const money = (m: number) => formatMoney(m, "INR");

  const needsAttention = all<{ id: string }>(
    db,
    `SELECT id FROM bookings WHERE payment_status = 'refund_needed' OR (status = 'pending_payment' AND hold_expires_at > ?) ORDER BY start_at LIMIT 10`,
    now,
  ).map((r) => getBooking(r.id, db)!);
  const failedJobs = all<{ n: number }>(db, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'")[0].n;

  const max = Math.max(1, ...stats.revenueByDay.map((d) => d.revenueMinor));
  const returnTo = days === 30 ? "/admin" : `/admin?days=${days}`;

  return (
    <>
      <PageHeader title="Dashboard">
        <nav className="flex gap-1 text-sm" aria-label="Date range">
          {[7, 30, 90].map((d) => (
            <Link key={d} href={`/admin?days=${d}`} className={`rounded-md px-3 py-1.5 font-medium ${d === days ? "bg-brand-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}>
              {d} days
            </Link>
          ))}
        </nav>
      </PageHeader>
      <Flash ok={sp.ok} error={sp.error} />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Key numbers">
        <StatCard label="Today" value={String(todays.length)} sub={todays.length === 1 ? "appointment" : "appointments"} />
        <StatCard label={`Revenue · ${days} days`} value={money(stats.revenueMinor)} sub={`${stats.completed} completed visits`} />
        <StatCard label="Upcoming" value={String(stats.upcoming)} sub={`${money(stats.upcomingValueMinor)} booked value`} />
        <StatCard label={`Cancellations · ${days} days`} value={String(stats.cancellations)} sub={`${(stats.cancellationRate * 100).toFixed(0)}% of bookings · ${stats.noShows} no-shows`} tone={stats.cancellationRate > 0.2 ? "warn" : undefined} />
      </section>

      {(needsAttention.length > 0 || failedJobs > 0) && (
        <section className="card mt-6 border-amber-200 bg-amber-50 p-4" aria-label="Needs attention">
          <h2 className="font-semibold text-amber-900">Needs attention</h2>
          {failedJobs > 0 && <p className="mt-1 text-sm text-amber-900">{failedJobs} background job{failedJobs === 1 ? "" : "s"} failed. <Link href="/admin/settings" className="underline">Review in Settings</Link></p>}
          <ul className="divide-y divide-amber-200">
            {needsAttention.map((b) => <BookingRow key={b.id} b={b} tz={tz} returnTo={returnTo} showDate />)}
          </ul>
        </section>
      )}

      <section className="card mt-6 p-5" aria-labelledby="today-h">
        <div className="flex items-baseline justify-between">
          <h2 id="today-h" className="text-lg font-semibold">Today · {fmtDate(now, tz)}</h2>
          <Link href="/admin/calendar" className="text-sm font-medium text-brand-700 hover:underline">Open calendar →</Link>
        </div>
        {todays.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">Nothing booked for today.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {todays.map((b) => <BookingRow key={b.id} b={b} tz={tz} returnTo={returnTo} />)}
          </ul>
        )}
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="card p-5" aria-labelledby="rev-h">
          <h2 id="rev-h" className="text-lg font-semibold">Revenue by day</h2>
          <p className="text-xs text-slate-500">Completed visits · deposits collected in period: {money(stats.depositsCollectedMinor)}{stats.refundsPendingMinor > 0 ? ` · refunds pending: ${money(stats.refundsPendingMinor)}` : ""}</p>
          <svg viewBox={`0 0 ${stats.revenueByDay.length * 12} 100`} className="mt-4 h-40 w-full" preserveAspectRatio="none" role="img" aria-label={`Daily revenue for the last ${days} days. Total ${money(stats.revenueMinor)}.`}>
            {stats.revenueByDay.map((d, i) => {
              const h = (d.revenueMinor / max) * 92;
              return (
                <rect key={d.date} x={i * 12 + 1.5} y={100 - h} width={9} height={Math.max(h, d.revenueMinor ? 1 : 0)} rx={1.5} className="fill-brand-500">
                  <title>{`${d.date}: ${money(d.revenueMinor)} (${d.count} visits)`}</title>
                </rect>
              );
            })}
            <line x1="0" x2={stats.revenueByDay.length * 12} y1="100" y2="100" className="stroke-slate-300" strokeWidth="0.5" />
          </svg>
          <div className="mt-1 flex justify-between text-xs text-slate-500"><span>{stats.revenueByDay[0]?.date}</span><span>{stats.revenueByDay.at(-1)?.date}</span></div>
        </section>

        <section className="card p-5" aria-labelledby="svc-h">
          <h2 id="svc-h" className="text-lg font-semibold">By service</h2>
          <table className="mt-3 w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="pb-2">Service</th><th className="pb-2 text-right">Visits</th><th className="pb-2 text-right">Revenue</th></tr></thead>
            <tbody>
              {stats.byService.map((s) => (
                <tr key={s.name} className="border-t border-slate-100"><td className="py-2 pr-2">{s.name}</td><td className="py-2 text-right tabular-nums">{s.count}</td><td className="py-2 text-right tabular-nums">{money(s.revenueMinor)}</td></tr>
              ))}
              {stats.byService.length === 0 && <tr><td colSpan={3} className="py-4 text-center text-slate-500">No data yet</td></tr>}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-slate-500">{stats.newCustomers} new customers in this period.</p>
        </section>
      </div>
    </>
  );
}
