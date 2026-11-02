import Link from "next/link";
import { getDb } from "@/lib/db";
import { listServices, formatMoney } from "@/lib/services";
import { getSettings } from "@/lib/settings";
import { fmtDuration } from "@/lib/format";
import { paymentsEnabled } from "@/lib/payments/config";

export const dynamic = "force-dynamic";

export default function Home() {
  const db = getDb();
  const settings = getSettings(db);
  const services = listServices({ activeOnly: true }, db);
  const payOn = paymentsEnabled();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-16">
      <header className="mb-10 text-center">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-brand-600 text-2xl text-white" aria-hidden>
          {settings.businessName.slice(0, 1).toUpperCase()}
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">{settings.businessName}</h1>
        {settings.tagline && <p className="mt-2 text-slate-600">{settings.tagline}</p>}
        {(settings.address || settings.phone) && (
          <p className="mt-1 text-sm text-slate-500">{[settings.address, settings.phone].filter(Boolean).join(" · ")}</p>
        )}
      </header>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Choose a service</h2>
      {services.length === 0 ? (
        <p className="card p-6 text-center text-slate-600">No services are open for booking right now.</p>
      ) : (
        <ul className="space-y-3">
          {services.map((s) => (
            <li key={s.id}>
              <Link
                href={`/book/${s.slug}`}
                className="card group flex items-center justify-between gap-4 p-5 transition hover:border-brand-500 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-slate-900">{s.name}</h3>
                  {s.description && <p className="mt-1 line-clamp-2 text-sm text-slate-600">{s.description}</p>}
                  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
                    <span>{fmtDuration(s.durationMin)}</span>
                    {s.createMeet && <span className="badge bg-sky-50 text-sky-700">Video call</span>}
                    {payOn && s.depositMinor > 0 && (
                      <span className="badge bg-amber-50 text-amber-800">{formatMoney(s.depositMinor, s.currency)} deposit</span>
                    )}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-lg font-semibold text-slate-900">{s.priceMinor > 0 ? formatMoney(s.priceMinor, s.currency) : "Free"}</div>
                  <div className="text-sm font-medium text-brand-700 group-hover:underline">Book →</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
