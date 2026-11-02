import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { CancelButton, PayDepositButton } from "@/components/ManageActions";
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
    <main className="mx-auto max-w-xl px-4 py-10">
      {sp.new && b.status === "confirmed" && (
        <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900" role="status">
          <p className="font-semibold">You're booked! 🎉</p>
          <p className="text-sm">We've emailed you the details. Keep this page's link to cancel or reschedule.</p>
        </div>
      )}
      {sp.moved && <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" role="status">Your appointment was moved.</div>}

      <div className="card p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-slate-500">{settings.businessName}</p>
            <h1 className="text-2xl font-bold">{b.serviceName}</h1>
          </div>
          <span className={`badge ${st.cls}`} data-testid="status">{st.label}</span>
        </div>

        <dl className="mt-5 space-y-3 text-sm">
          <div>
            <dt className="text-slate-500">When</dt>
            <dd className="text-base font-semibold" data-testid="when">
              {fmtDate(b.startAt, b.customerTz)}<br />
              {fmtTime(b.startAt, b.customerTz)} – {fmtTime(b.endAt, b.customerTz)} <span className="font-normal text-slate-500">({fmtTz(b.startAt, b.customerTz)}, {fmtDuration(Math.round((b.endAt - b.startAt) / 60000))})</span>
            </dd>
            {b.customerTz !== settings.timezone && (
              <dd className="text-slate-500">Clinic time: {fmtTime(b.startAt, settings.timezone)} ({settings.timezone.replace(/_/g, " ")})</dd>
            )}
          </div>
          <div><dt className="text-slate-500">Name</dt><dd>{b.name} · {b.email}</dd></div>
          {b.location && <div><dt className="text-slate-500">Where</dt><dd>{b.location}</dd></div>}
          {b.meetUrl && <div><dt className="text-slate-500">Video link</dt><dd><a className="font-medium text-brand-700 underline" href={b.meetUrl} rel="noopener noreferrer" target="_blank">{b.meetUrl}</a></dd></div>}
          <div>
            <dt className="text-slate-500">Price</dt>
            <dd>
              {b.priceMinor > 0 ? formatMoney(b.priceMinor, b.currency) : "Free"}
              {b.depositMinor > 0 && <> · deposit {formatMoney(b.depositMinor, b.currency)} ({b.paymentStatus === "paid" ? "paid" : b.paymentStatus === "refunded" ? "refunded" : b.paymentStatus === "refund_needed" ? "refund in progress" : "due"})</>}
            </dd>
          </div>
          {b.status === "cancelled" && b.cancelReason && <div><dt className="text-slate-500">Reason</dt><dd>{b.cancelReason}</dd></div>}
        </dl>

        {b.status === "pending_payment" && (
          <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm text-amber-900">Pay the {formatMoney(b.depositMinor, b.currency)} deposit to confirm. Your time is held for about {holdLeftMin} more minute{holdLeftMin === 1 ? "" : "s"}.</p>
            <div className="mt-3"><PayDepositButton id={b.id} token={token} label={`Pay ${formatMoney(b.depositMinor, b.currency)} deposit`} autoOpen={!!sp.pay} /></div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          {b.status === "confirmed" && <a className="btn-secondary" href={`/api/bookings/${b.id}/ics?t=${t}`}>Add to calendar</a>}
          {b.status === "confirmed" && upcoming && <Link className="btn-secondary" href={`/booking/${b.id}/reschedule?t=${t}`}>Reschedule</Link>}
          {active && upcoming && <CancelButton id={b.id} token={token} />}
          {b.status === "cancelled" && <Link className="btn-primary" href={`/book/${b.serviceSlug}`}>Book again</Link>}
        </div>
        {active && upcoming && settings.cancelCutoffHours > 0 && (
          <p className="mt-4 text-xs text-slate-500">Online changes are possible until {settings.cancelCutoffHours} hours before the appointment.</p>
        )}
      </div>
    </main>
  );
}
