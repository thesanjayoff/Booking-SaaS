import Link from "next/link";
import type { Metadata } from "next";
import AdminNav from "@/components/AdminNav";
import { Monogram } from "@/components/SiteChrome";
import { ArrowUpRight } from "@/components/icons";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { logoutAction } from "../actions";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin" }, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  const s = getSettings();
  return (
    <div className="min-h-screen">
      <header className="glass sticky top-0 z-40 border-b border-[rgba(247,237,213,0.07)]">
        <div className="gutter mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-6 gap-y-1 py-2">
          <Link href="/admin" className="flex shrink-0 items-center gap-3 rounded-lg py-1">
            <Monogram name={s.businessName} size="2.25rem" />
            <span className="font-bold tracking-[-0.03em] text-gold-100">{s.businessName}</span>
          </Link>
          <div className="order-last flex w-full min-w-0 lg:order-none lg:w-auto lg:flex-1"><AdminNav /></div>
          <div className="ml-auto flex items-center gap-2 lg:ml-0">
            <Link href="/" target="_blank" className="hidden min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-slate-500 hover:text-gold-100 sm:inline-flex">
              View booking page <ArrowUpRight className="size-4" />
            </Link>
            <form action={logoutAction}><button className="btn-secondary !min-h-10 !px-4 !py-1.5 !text-sm">Sign out</button></form>
          </div>
        </div>
      </header>
      <main className="gutter mx-auto w-full max-w-[1280px] py-8 sm:py-10">{children}</main>
    </div>
  );
}
