import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { listCustomers } from "@/lib/admin-queries";
import { PageHeader } from "@/components/admin";
import { formatMoney } from "@/lib/services";
import { fmtShort } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customers" };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdmin();
  const q = ((await searchParams).q ?? "").slice(0, 100);
  const db = getDb();
  const tz = getSettings(db).timezone;
  const rows = listCustomers(db, q);

  return (
    <>
      <PageHeader title="Customers">
        <a className="btn-secondary" href={`/api/admin/export/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`}>Export CSV</a>
      </PageHeader>
      <form className="mb-4 flex gap-2" role="search">
        <input name="q" defaultValue={q} placeholder="Search name, email, phone" className="input !w-72" aria-label="Search customers" />
        <button className="btn-primary">Search</button>
        {q && <Link href="/admin/customers" className="btn-secondary">Reset</Link>}
      </form>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Customer</th><th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3 text-right">Visits</th><th className="px-4 py-3 text-right">Cancelled</th><th className="px-4 py-3 text-right">No-shows</th>
              <th className="px-4 py-3 text-right">Spent</th><th className="px-4 py-3">Last visit</th><th className="px-4 py-3">Next</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="px-4 py-3 font-medium"><Link className="hover:underline" href={`/admin/bookings?status=all&q=${encodeURIComponent(c.email)}`}>{c.name}</Link></td>
                <td className="px-4 py-3 text-slate-600">{c.email}<div className="text-xs">{c.phone}</div></td>
                <td className="px-4 py-3 text-right tabular-nums">{c.visits}</td>
                <td className="px-4 py-3 text-right tabular-nums">{c.cancelled}</td>
                <td className="px-4 py-3 text-right tabular-nums">{c.noShows}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatMoney(c.spentMinor, "INR")}</td>
                <td className="px-4 py-3 text-slate-600">{c.lastVisit ? fmtShort(c.lastVisit, tz) : "—"}</td>
                <td className="px-4 py-3 text-slate-600">{c.nextVisit ? fmtShort(c.nextVisit, tz) : "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-500">No customers found.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
