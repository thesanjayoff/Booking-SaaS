import Link from "next/link";
import type { Booking } from "@/lib/bookings";
import { cancelBookingAction, outcomeAction, rescheduleAction, retryRefundAction } from "@/app/admin/actions";
import { fmtShort, fmtTime } from "@/lib/format";
import { formatMoney } from "@/lib/services";

export const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  confirmed: { label: "Confirmed", cls: "bg-emerald-50 text-emerald-700" },
  pending_payment: { label: "Awaiting deposit", cls: "bg-amber-50 text-amber-800" },
  cancelled: { label: "Cancelled", cls: "bg-slate-100 text-slate-600" },
  completed: { label: "Completed", cls: "bg-sky-50 text-sky-700" },
  no_show: { label: "No-show", cls: "bg-rose-50 text-rose-700" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.confirmed;
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}

export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  return (
    <div
      role={error ? "alert" : "status"}
      className={`mb-6 rounded-[var(--radius-card)] border px-4 py-3 text-sm font-semibold ${error ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}
    >
      {error ?? ok}
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
      <h1 className="text-fluid-xl font-medium tracking-[-0.045em] text-gold-100">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" }) {
  return (
    <div className="card p-5">
      <div className="eyebrow !text-gold-400">{label}</div>
      <div className={`mt-3 text-fluid-xl font-medium tracking-[-0.04em] ${tone === "warn" ? "text-rose-600" : "text-gold-100"}`}>{value}</div>
      {sub && <div className="mt-1 text-sm text-slate-500">{sub}</div>}
    </div>
  );
}

/** Row with the per-booking quick actions. `returnTo` keeps the owner on the page they came from. */
export function BookingRow({ b, tz, returnTo, showDate }: { b: Booking; tz: string; returnTo: string; showDate?: boolean }) {
  const active = b.status === "confirmed" || b.status === "pending_payment";
  const started = b.startAt <= Date.now();
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3" data-booking={b.id}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{showDate ? fmtShort(b.startAt, tz) : `${fmtTime(b.startAt, tz)} – ${fmtTime(b.endAt, tz)}`}</span>
          <StatusBadge status={b.status} />
          {b.paymentStatus === "refund_needed" && <span className="badge bg-rose-50 text-rose-700">Refund due</span>}
          {b.depositMinor > 0 && b.paymentStatus === "paid" && <span className="badge bg-emerald-50 text-emerald-700">Deposit paid</span>}
          {b.meetUrl && <a href={b.meetUrl} target="_blank" rel="noopener noreferrer" className="badge bg-sky-50 text-sky-700 hover:underline">Meet</a>}
        </div>
        <div className="mt-0.5 text-sm text-slate-700">{b.serviceName} · {b.name}</div>
        <div className="text-xs text-slate-500">{[b.email, b.phone].filter(Boolean).join(" · ")}{b.notes ? ` · “${b.notes}”` : ""}</div>
        {b.priceMinor > 0 && <div className="text-xs text-slate-500">{formatMoney(b.priceMinor, b.currency)}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {b.status === "confirmed" && started && (
          <>
            <form action={outcomeAction}>
              <input type="hidden" name="id" value={b.id} /><input type="hidden" name="status" value="completed" /><input type="hidden" name="returnTo" value={returnTo} />
              <button className="btn-secondary !px-3 !py-1.5 !text-xs">Mark done</button>
            </form>
            <form action={outcomeAction}>
              <input type="hidden" name="id" value={b.id} /><input type="hidden" name="status" value="no_show" /><input type="hidden" name="returnTo" value={returnTo} />
              <button className="btn-secondary !px-3 !py-1.5 !text-xs">No-show</button>
            </form>
          </>
        )}
        {(b.status === "completed" || b.status === "no_show") && (
          <form action={outcomeAction}>
            <input type="hidden" name="id" value={b.id} /><input type="hidden" name="status" value="confirmed" /><input type="hidden" name="returnTo" value={returnTo} />
            <button className="btn-secondary !px-3 !py-1.5 !text-xs">Undo</button>
          </form>
        )}
        {b.paymentStatus === "refund_needed" && (
          <form action={retryRefundAction}>
            <input type="hidden" name="id" value={b.id} /><input type="hidden" name="returnTo" value={returnTo} />
            <button className="btn-secondary !px-3 !py-1.5 !text-xs">Retry refund</button>
          </form>
        )}
        {b.status === "confirmed" && !started && (
          <details className="relative">
            <summary className="btn-secondary cursor-pointer list-none !px-3 !py-1.5 !text-xs">Move…</summary>
            <form action={rescheduleAction} className="absolute right-0 z-10 mt-1 w-64 rounded-[var(--radius-card)] border border-slate-300 bg-ink-850 p-4 shadow-2xl shadow-black/60">
              <input type="hidden" name="id" value={b.id} /><input type="hidden" name="returnTo" value={returnTo} />
              <label className="label" htmlFor={`m-${b.id}`}>New time ({tz.replace(/_/g, " ")})</label>
              <input id={`m-${b.id}`} name="when" type="datetime-local" step={300} required className="input" />
              <button className="btn-primary mt-2 w-full !py-1.5 !text-xs">Move booking</button>
            </form>
          </details>
        )}
        {active && (
          <details className="relative">
            <summary className="btn-secondary cursor-pointer list-none !px-3 !py-1.5 !text-xs">Cancel…</summary>
            <form action={cancelBookingAction} className="absolute right-0 z-10 mt-1 w-64 rounded-[var(--radius-card)] border border-slate-300 bg-ink-850 p-4 shadow-2xl shadow-black/60">
              <input type="hidden" name="id" value={b.id} /><input type="hidden" name="returnTo" value={returnTo} />
              <label className="label" htmlFor={`r-${b.id}`}>Reason (sent to customer)</label>
              <input id={`r-${b.id}`} name="reason" className="input" maxLength={300} />
              <button className="btn-danger mt-2 w-full !py-1.5 !text-xs">Cancel booking</button>
            </form>
          </details>
        )}
      </div>
    </li>
  );
}

export function Pager({ page, pages, hrefFor }: { page: number; pages: number; hrefFor: (p: number) => string }) {
  if (pages <= 1) return null;
  return (
    <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
      {page > 1 ? <Link className="btn-secondary" href={hrefFor(page - 1)}>← Newer</Link> : <span />}
      <span className="text-slate-500">Page {page} of {pages}</span>
      {page < pages ? <Link className="btn-secondary" href={hrefFor(page + 1)}>Older →</Link> : <span />}
    </nav>
  );
}
