"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  ["/admin", "Dashboard"],
  ["/admin/calendar", "Calendar"],
  ["/admin/bookings", "Bookings"],
  ["/admin/customers", "Customers"],
  ["/admin/services", "Services"],
  ["/admin/availability", "Availability"],
  ["/admin/settings", "Settings"],
] as const;

/** Section links with the current page marked, scrollable sideways on narrow screens. */
export default function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin" className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 text-sm [scrollbar-width:none]">
      {NAV.map(([href, label]) => {
        const current = href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={`relative inline-flex min-h-11 shrink-0 items-center rounded-full px-4 font-semibold transition-colors duration-300 ${
              current ? "bg-gold-250/12 text-gold-100" : "text-slate-500 hover:bg-gold-250/6 hover:text-gold-100"
            }`}
          >
            {label}
            {current ? <span aria-hidden className="absolute inset-x-4 -bottom-px h-px bg-[image:var(--gold-gradient)]" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}
