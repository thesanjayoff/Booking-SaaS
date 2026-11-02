import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { searchBookings, type BookingFilter } from "@/lib/admin-queries";
import { BookingRow, Flash, PageHeader, Pager } from "@/components/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bookings" };

const PAGE = 25;
const STATUSES = ["upcoming", "all", "confirmed", "pending_payment", "completed", "no_show", "cancelled"] as const;

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; page?: string; ok?: string; error?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as BookingFilter["status"]) : "upcoming";
  const q = (sp.q ?? "").slice(0, 100);
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const db = getDb();
  const tz = getSettings(db).timezone;
  const { rows, total } = searchBookings(db, { status, q: q || undefined }, PAGE, (page - 1) * PAGE);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const qs = (over: Record<string, string | number>) => {
    const p = new URLSearchParams({ status: status ?? "upcoming", ...(q ? { q } : {}), ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) });
    return `/admin/bookings?${p}`;
  };
  const exportQs = new URLSearchParams({ status: status ?? "upcoming", ...(q ? { q } : {}) });

  return (
    <>
      <PageHeader title="Bookings">
        <a className="btn-secondary" href={`/api/admin/export/bookings?${exportQs}`}>Export CSV</a>
      </PageHeader>
      <Flash ok={sp.ok} error={sp.error} />

      <form className="mb-4 flex flex-wrap gap-2" role="search">
        <select name="status" defaultValue={status} className="input !w-auto" aria-label="Status">
          {STATUSES.map((s) => <option key={s} value={s}>{s === "all" ? "All statuses" : s.replace("_", " ")}</option>)}
        </select>
        <input name="q" defaultValue={q} placeholder="Search name, email, phone, service" className="input !w-72" aria-label="Search" />
        <button className="btn-primary">Filter</button>
        {(q || status !== "upcoming") && <Link href="/admin/bookings" className="btn-secondary">Reset</Link>}
      </form>

      <div className="card p-5">
        <p className="text-sm text-slate-500">{total} booking{total === 1 ? "" : "s"}</p>
        {rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">No bookings match.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((b) => <BookingRow key={b.id} b={b} tz={tz} showDate returnTo={`/admin/bookings?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ""}`} />)}
          </ul>
        )}
        <Pager page={page} pages={pages} hrefFor={(p) => qs({ page: p })} />
      </div>
    </>
  );
}
