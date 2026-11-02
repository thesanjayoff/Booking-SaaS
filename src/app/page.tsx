import Link from "next/link";
import Copy from "@/components/Copy";
import LocalTime from "@/components/LocalTime";
import RevealList from "@/components/RevealList";
import SmoothScroll from "@/components/SmoothScroll";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { ArrowDown, ArrowRight, Calendar, Clock, Globe, MapPin, Refresh, Shield, Video } from "@/components/icons";
import { getDb } from "@/lib/db";
import { nextOpenings } from "@/lib/nextslot";
import { paymentsEnabled } from "@/lib/payments/config";
import { fmtDuration } from "@/lib/format";
import { formatMoney, listServices } from "@/lib/services";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default function Home() {
  const db = getDb();
  const settings = getSettings(db);
  const services = listServices({ activeOnly: true }, db);
  const depositsOn = paymentsEnabled();
  const now = Date.now();
  const openings = nextOpenings(services, db, now);

  // The single soonest opening across all services, for the hero.
  let soonest: { service: (typeof services)[number]; at: number } | null = null;
  for (const s of services) {
    const at = openings.get(s.id);
    if (at !== undefined && (!soonest || at < soonest.at)) soonest = { service: s, at };
  }

  const cutoff = settings.cancelCutoffHours;

  return (
    <>
      <SmoothScroll />
      <SiteHeader settings={settings} />

      <main id="top">
        {/* ------------------------------------------------------------ hero */}
        <section className="gutter mx-auto grid w-full max-w-[1280px] items-end gap-[var(--stack)] pb-[var(--section-y)] pt-[clamp(2.5rem,6vw,6rem)] lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
          <div>
            <Copy animateOnScroll={false} delay={0.15}>
              <p className="eyebrow">Book online · no account needed</p>
            </Copy>
            <div className="mt-5">
              <Copy animateOnScroll={false} delay={0.25}>
                <h1 className="text-fluid-3xl font-medium text-gold-100">{settings.businessName}</h1>
              </Copy>
            </div>
            {settings.tagline ? (
              <div className="mt-6 max-w-[34rem]">
                <Copy animateOnScroll={false} delay={0.4}>
                  <p className="text-fluid-lg text-gold-200">{settings.tagline}</p>
                </Copy>
              </div>
            ) : null}
            <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-4" style={{ animation: "rise-in 0.9s 0.6s var(--ease-out-expo) both" }}>
              <a href="#services" className="cta">
                <span className="cta-circle" aria-hidden />
                <ArrowDown className="cta-icon" />
                <span className="cta-text">Choose a service</span>
              </a>
              {settings.address ? (
                <p className="flex max-w-xs items-start gap-2 text-sm text-slate-500">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-gold-400" />
                  {settings.address}
                </p>
              ) : null}
            </div>
          </div>

          {/* The one memorable thing: what the calendar can actually offer right now. */}
          <aside
            aria-label="Next available time"
            className="panel relative overflow-hidden p-6 sm:p-8"
            style={{ animation: "rise-in 1s 0.7s var(--ease-out-expo) both" }}
          >
            <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-gold-250/15 blur-3xl" />
            {soonest ? (
              <>
                <p className="eyebrow flex items-center gap-2">
                  <span className="size-2 rounded-full bg-gold-250" style={{ animation: "pulse-dot 2.4s ease-out infinite" }} aria-hidden />
                  Next opening
                </p>
                <p className="mt-4 text-fluid-xl font-medium tracking-[-0.04em] text-gold-100">
                  <LocalTime ms={soonest.at} businessTz={settings.timezone} serverNow={now} />
                </p>
                <p className="mt-1 text-gold-200">{soonest.service.name}</p>
                <p className="mt-1 flex items-center gap-2 text-sm text-slate-500">
                  <Clock className="size-4" />
                  {fmtDuration(soonest.service.durationMin)}
                  {soonest.service.createMeet ? (
                    <>
                      <span aria-hidden>·</span>
                      <Video className="size-4" /> Video call
                    </>
                  ) : null}
                </p>
                <Link href={`/book/${soonest.service.slug}`} className="btn-primary mt-7 w-full">
                  Book this time
                  <ArrowRight className="size-4" />
                </Link>
              </>
            ) : (
              <>
                <p className="eyebrow">Availability</p>
                <p className="mt-4 text-fluid-xl font-medium tracking-[-0.04em]">Check back soon</p>
                <p className="mt-2 text-slate-500">
                  {services.length ? "Nothing is open in the next three weeks. New times are added regularly." : "Services will appear here once they are set up."}
                </p>
              </>
            )}
          </aside>
        </section>

        {/* -------------------------------------------------------- services */}
        <section id="services" aria-labelledby="services-title" className="gutter mx-auto w-full max-w-[1280px] scroll-mt-[calc(var(--header-h)+1rem)]">
          <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
            <Copy>
              <h2 id="services-title" className="text-fluid-2xl font-semibold">Choose a service</h2>
            </Copy>
            <p className="text-sm text-slate-500">{services.length} {services.length === 1 ? "service" : "services"} · pick a time on the next step</p>
          </div>

          {services.length === 0 ? (
            <div className="card p-10 text-center text-slate-500">No services are open for booking yet.</div>
          ) : (
            <RevealList className="border-b border-[rgba(247,237,213,0.08)]">
              {services.map((s) => {
                const at = openings.get(s.id);
                const deposit = depositsOn && s.depositMinor > 0;
                return (
                  <li key={s.id} className="service-row">
                    <Link
                      href={`/book/${s.slug}`}
                      className="grid items-center gap-x-8 gap-y-3 rounded-lg py-7 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:py-8"
                    >
                      <div className="min-w-0">
                        <h3 className="text-fluid-xl font-medium text-gold-100">{s.name}</h3>
                        {s.description ? <p className="mt-2 line-clamp-2 max-w-xl text-slate-500">{s.description}</p> : null}
                        <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gold-200">
                          <li className="inline-flex items-center gap-1.5"><Clock className="size-4 text-gold-400" />{fmtDuration(s.durationMin)}</li>
                          {s.createMeet ? <li className="inline-flex items-center gap-1.5"><Video className="size-4 text-gold-400" />Video call</li> : null}
                          {deposit ? <li><span className="badge bg-amber-50 text-amber-800">{formatMoney(s.depositMinor, s.currency)} deposit</span></li> : null}
                        </ul>
                      </div>
                      <div className="sm:text-right">
                        <p className="text-fluid-lg font-semibold tracking-[-0.03em] text-gold-100">{s.priceMinor > 0 ? formatMoney(s.priceMinor, s.currency) : "Free"}</p>
                        <p className="mt-1 text-sm text-slate-500">
                          {at !== undefined ? (
                            <>Next: <LocalTime ms={at} businessTz={settings.timezone} serverNow={now} /></>
                          ) : (
                            "No openings soon"
                          )}
                        </p>
                      </div>
                      <span className="go hidden size-12 place-items-center rounded-full border border-[rgba(247,237,213,0.18)] text-gold-100 sm:grid" aria-hidden>
                        <ArrowRight className="size-5" />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </RevealList>
          )}
        </section>

        {/* ------------------------------------------------------ good to know */}
        <section aria-labelledby="know-title" className="gutter mx-auto mt-[var(--section-y)] w-full max-w-[1280px]">
          <Copy>
            <h2 id="know-title" className="max-w-2xl text-fluid-2xl font-semibold">Booking, without the back and forth</h2>
          </Copy>
          <RevealList as="div" className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-media)] border border-[rgba(247,237,213,0.08)] bg-[rgba(247,237,213,0.08)] md:grid-cols-3">
            {[
              { icon: Globe, title: "Your time zone", text: "Every time is shown in your own zone, with the clinic's zone alongside, so nothing gets lost across borders." },
              {
                icon: Refresh,
                title: "Change of plans",
                text: cutoff > 0 ? `Cancel or reschedule from the link in your confirmation email, up to ${cutoff} hours before.` : "Cancel or reschedule any time from the link in your confirmation email.",
              },
              depositsOn
                ? { icon: Shield, title: "Secure deposits", text: "Where a visit needs a deposit, you pay it by card or UPI at the end. Your time is held while you pay." }
                : { icon: Calendar, title: "Straight to your calendar", text: "Your confirmation comes with a calendar file, so the visit lands in whichever calendar you use." },
            ].map(({ icon: Icon, title, text }) => (
              <div key={title} className="bg-ink-900 p-7 sm:p-9">
                <Icon className="size-6 text-gold-250" />
                <h3 className="mt-5 text-fluid-lg font-semibold">{title}</h3>
                <p className="mt-2 text-slate-500">{text}</p>
              </div>
            ))}
          </RevealList>
        </section>
      </main>

      <SiteFooter settings={settings} />
    </>
  );
}
