import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { CancelButton, PayDepositButton } from "@/components/ManageActions";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { Calendar, Check, Refresh } from "@/components/icons";
import { getBooking } from "@/lib/bookings";
import { fmtDate, fmtDuration, fmtTime, fmtTz } from "@/lib/format";
import { formatMoney } from "@/lib/services";
import { getSettings } from "@/lib/settings";
import { verifyManageToken } from "@/lib/tokens";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your appointment", robots: { index: false, follow: false } };

const STATUS: Record<string, { label: string; cls: string }> = {
  confirmed: { label: "Confirmed", cls: "bg-emerald-50 text-emerald-700" },
  pending_payment: { label: "Awaiting deposit", cls: "bg-amber-50 text-amber-800" },
  cancelled: { label: "Cancelled", cls: "bg-slate-100 text-slate-600" },
  completed: { label: "Completed", cls: "bg-sky-50 text-sky-700" },
  no_show: { label: "Missed", cls: "bg-slate-100 text-slate-600" },
};

function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="grid gap-1 border-t border-[rgba(247,237,213,0.07)] py-4 sm:grid-cols-[8rem_1fr] sm:gap-6">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="min-w-0 text-gold-100" data-testid={testId}>{children}</dd>
    </div>
  );
}

export default async function ManageBooking({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string; new?: string; moved?: string; pay?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const token = typeof sp.t === "string" ? sp.t : "";
  if (!verifyManageToken(id, token)) notFound();
  const b = getBooking(id);
  if (!b) notFound();
  const settings = getSettings();

  const st = STATUS[b.status] ?? STATUS.confirmed;
  const upcoming = b.startAt > Date.now();
  const active = b.status === "confirmed" || b.status === "pending_payment";
  const t = encodeURIComponent(token);
  const holdLeftMin = b.holdExpiresAt ? Math.max(0, Math.ceil((b.holdExpiresAt - Date.now()) / 60000)) : 0;

  return (
    <>
      <SiteHeader settings={settings} />
      <main className="gutter mx-auto w-full max-w-2xl py-10 sm:py-14">
        {sp.new && b.status === "confirmed" && (
          <div className="panel mb-6 flex items-start gap-4 border-gold-250/40 p-5 sm:p-6" role="status" style={{ animation: "rise-in 0.7s var(--ease-out-expo) both" }}>
            <span className="grid size-11 shrink-0 place-items-center rounded-full text-ink-950" style={{ backgroundImage: "var(--gold-gradient)" }} aria-hidden>
              <Check className="size-6" />
            </span>
            <div>
              <p className="text-fluid-lg font-semibold tracking-[-0.03em]">You&apos;re booked!</p>
              <p className="mt-1 text-slate-500">We&apos;ve emailed you the details. Keep this page&apos;s link to cancel or reschedule.</p>
            </div>
          </div>
        )}
        {sp.moved && (
          <div className="panel mb-6 flex items-center gap-3 border-gold-250/40 p-4 text-gold-100" role="status">
            <Check className="size-5 shrink-0 text-gold-250" />
            <p>Your appointment was moved.</p>
          </div>
        )}

        <article className="panel p-6 sm:p-9">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gold-400">{settings.businessName}</p>
              <h1 className="mt-2 text-fluid-2xl font-medium text-gold-100">{b.serviceName}</h1>
            </div>
            <span className={`badge shrink-0 ${st.cls}`} data-testid="status">{st.label}</span>
          </div>

          <dl className="mt-8">
            <Row label="When" testId="when">
              <span className="text-lg font-semibold tracking-[-0.02em]">{fmtDate(b.startAt, b.customerTz)}</span>
              <br />
              {fmtTime(b.startAt, b.customerTz)} – {fmtTime(b.endAt, b.customerTz)}{" "}
              <span className="font-normal text-slate-500">({fmtTz(b.startAt, b.customerTz)}, {fmtDuration(Math.round((b.endAt - b.startAt) / 60000))})</span>
              {b.customerTz !== settings.timezone && (
                <span className="mt-1 block text-sm font-normal text-slate-500">Clinic time: {fmtTime(b.startAt, settings.timezone)} ({settings.timezone.replace(/_/g, " ")})</span>
              )}
            </Row>
            <Row label="Name">{b.name} <span className="text-slate-500">· {b.email}</span></Row>
            {b.location && <Row label="Where">{b.location}</Row>}
            {b.meetUrl && (
              <Row label="Video link">
                <a className="font-semibold text-gold-250 underline underline-offset-4 hover:text-gold-100" href={b.meetUrl} rel="noopener noreferrer" target="_blank">{b.meetUrl}</a>
              </Row>
            )}
            <Row label="Price">
              {b.priceMinor > 0 ? formatMoney(b.priceMinor, b.currency) : "Free"}
              {b.depositMinor > 0 && (
                <span className="text-slate-500"> · deposit {formatMoney(b.depositMinor, b.currency)} ({b.paymentStatus === "paid" ? "paid" : b.paymentStatus === "refunded" ? "refunded" : b.paymentStatus === "refund_needed" ? "refund in progress" : "due"})</span>
              )}
            </Row>
            {b.status === "cancelled" && b.cancelReason && <Row label="Reason">{b.cancelReason}</Row>}
          </dl>

          {b.status === "pending_payment" && (
            <div className="mt-4 rounded-[var(--radius-card)] border border-amber-200 bg-amber-50 p-5">
              <p className="text-amber-900">Pay the {formatMoney(b.depositMinor, b.currency)} deposit to confirm. Your time is held for about {holdLeftMin} more minute{holdLeftMin === 1 ? "" : "s"}.</p>
              <div className="mt-4"><PayDepositButton id={b.id} token={token} label={`Pay ${formatMoney(b.depositMinor, b.currency)} deposit`} autoOpen={!!sp.pay} /></div>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-3 border-t border-[rgba(247,237,213,0.07)] pt-6">
            {b.status === "confirmed" && <a className="btn-secondary" href={`/api/bookings/${b.id}/ics?t=${t}`}><Calendar className="size-4" />Add to calendar</a>}
            {b.status === "confirmed" && upcoming && <Link className="btn-secondary" href={`/booking/${b.id}/reschedule?t=${t}`}><Refresh className="size-4" />Reschedule</Link>}
            {active && upcoming && <CancelButton id={b.id} token={token} />}
            {b.status === "cancelled" && <Link className="btn-primary" href={`/book/${b.serviceSlug}`}>Book again</Link>}
          </div>
          {active && upcoming && settings.cancelCutoffHours > 0 && (
            <p className="mt-5 text-sm text-slate-500">Online changes are possible until {settings.cancelCutoffHours} hours before the appointment.</p>
          )}
        </article>
      </main>
      <SiteFooter settings={settings} />
    </>
  );
}
