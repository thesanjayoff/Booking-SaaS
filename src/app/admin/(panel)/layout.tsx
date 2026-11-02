import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { logoutAction } from "../actions";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin" }, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const NAV = [
  ["/admin", "Dashboard"],
  ["/admin/calendar", "Calendar"],
  ["/admin/bookings", "Bookings"],
  ["/admin/customers", "Customers"],
  ["/admin/services", "Services"],
  ["/admin/availability", "Availability"],
  ["/admin/settings", "Settings"],
] as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  const s = getSettings();
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/admin" className="font-bold text-brand-700">{s.businessName}</Link>
          <nav className="flex flex-1 flex-wrap gap-1 text-sm" aria-label="Admin">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} className="rounded-md px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900">{label}</Link>
            ))}
          </nav>
          <Link href="/" className="text-sm text-slate-500 hover:underline" target="_blank">View booking page ↗</Link>
          <form action={logoutAction}><button className="btn-secondary !px-3 !py-1.5 !text-xs">Sign out</button></form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
