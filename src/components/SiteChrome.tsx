import Link from "next/link";
import { MapPin, Phone } from "@/components/icons";
import type { Settings } from "@/lib/settings";

/** Square monogram: the first letter of the business in a thin gold frame. */
export function Monogram({ name, size = "2.5rem" }: { name: string; size?: string }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[0.8rem] font-bold text-ink-950"
      style={{ width: size, height: size, backgroundImage: "var(--gold-gradient)", fontSize: `calc(${size} * 0.46)` }}
    >
      {name.trim().charAt(0).toUpperCase() || "B"}
    </span>
  );
}

export function SiteHeader({ settings, back }: { settings: Pick<Settings, "businessName" | "phone">; back?: { href: string; label: string } }) {
  return (
    <header className="glass sticky top-0 z-40 border-b border-[rgba(247,237,213,0.07)]" style={{ minHeight: "var(--header-h)" }}>
      <div className="gutter mx-auto flex w-full max-w-[1280px] items-center justify-between gap-4" style={{ minHeight: "var(--header-h)" }}>
        <Link href="/" className="group flex min-w-0 items-center gap-3 rounded-lg" aria-label={`${settings.businessName} home`}>
          <Monogram name={settings.businessName} />
          <span className="truncate text-[1.0625rem] font-bold tracking-[-0.03em] text-gold-100">{settings.businessName}</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm font-semibold" aria-label="Site">
          {back ? (
            <Link href={back.href} className="rounded-full px-3 py-2 text-gold-200 transition-colors hover:text-gold-100">{back.label}</Link>
          ) : null}
          {settings.phone ? (
            <a href={`tel:${settings.phone.replace(/[^+\d]/g, "")}`} className="inline-flex items-center gap-2 rounded-full border border-[rgba(247,237,213,0.14)] px-4 py-2 text-gold-100 transition-colors hover:border-gold-400/60 hover:bg-gold-250/10">
              <Phone className="size-4 text-gold-250" />
              <span className="hidden sm:inline">{settings.phone}</span>
              <span className="sm:hidden">Call</span>
            </a>
          ) : null}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter({ settings }: { settings: Pick<Settings, "businessName" | "address" | "phone" | "timezone"> }) {
  return (
    <footer className="mt-[var(--section-y)] border-t border-[rgba(247,237,213,0.07)]">
      <div className="gutter mx-auto grid w-full max-w-[1280px] gap-8 py-12 sm:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-3">
            <Monogram name={settings.businessName} size="2.25rem" />
            <p className="text-lg font-bold tracking-[-0.03em]">{settings.businessName}</p>
          </div>
          <p className="mt-4 max-w-sm text-sm text-slate-500">Times are shown in your own time zone. {settings.businessName} is in {settings.timezone.replace(/_/g, " ")}.</p>
        </div>
        <div className="text-sm">
          <p className="eyebrow">Visit</p>
          {settings.address ? (
            <address className="mt-3 flex gap-2 not-italic text-gold-200"><MapPin className="mt-0.5 size-4 shrink-0 text-gold-250" />{settings.address}</address>
          ) : (
            <p className="mt-3 text-slate-500">Address on your confirmation email.</p>
          )}
        </div>
        <div className="text-sm">
          <p className="eyebrow">Contact</p>
          {settings.phone ? (
            <a href={`tel:${settings.phone.replace(/[^+\d]/g, "")}`} className="mt-3 inline-flex items-center gap-2 text-gold-200 hover:text-gold-100"><Phone className="size-4 text-gold-250" />{settings.phone}</a>
          ) : (
            <p className="mt-3 text-slate-500">Reply to your confirmation email.</p>
          )}
        </div>
      </div>
      <div className="gutter mx-auto flex w-full max-w-[1280px] items-center justify-between border-t border-[rgba(247,237,213,0.05)] py-5 text-xs text-slate-400">
        <span>© {new Date().getFullYear()} {settings.businessName}</span>
        <Link href="/admin" className="rounded px-1 py-1 hover:text-gold-200">Owner sign in</Link>
      </div>
    </footer>
  );
}
