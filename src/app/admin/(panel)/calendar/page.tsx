import Link from "next/link";
import { DateTime } from "luxon";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { bookingsBetween, externalBusyBetween } from "@/lib/admin-queries";
import { loadRules } from "@/lib/availability/store";
import { PageHeader } from "@/components/admin";
import { fmtTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Calendar" };

const BLOCK: Record<string, string> = {
  confirmed: "bg-emerald-100 border-emerald-500 text-emerald-900",
  pending_payment: "bg-amber-100 border-amber-500 text-amber-900",
  completed: "bg-sky-100 border-sky-500 text-sky-900",
  no_show: "bg-rose-100 border-rose-500 text-rose-900",
};

const PX_PER_MIN = 0.9;

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ view?: string; date?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const db = getDb();
  const tz = getSettings(db).timezone;
  const now = DateTime.now().setZone(tz);
  const parsed = sp.date ? DateTime.fromISO(sp.date, { zone: tz }) : now;
  const anchor = parsed.isValid ? parsed : now;
  const view = sp.view === "month" ? "month" : "week";
  const todayKey = now.toISODate()!;

  const nav = (unit: "week" | "month", dir: -1 | 1) => `/admin/calendar?view=${view}&date=${anchor.plus({ [unit === "week" ? "weeks" : "months"]: dir }).toISODate()}`;

  /* ---------------------------------------------------------------- month */
  if (view === "month") {
    const first = anchor.startOf("month");
    const gridStart = first.startOf("week");
    const gridEnd = first.endOf("month").endOf("week").plus({ milliseconds: 1 });
    const bookings = bookingsBetween(db, gridStart.toMillis(), gridEnd.toMillis());
    const byDay = new Map<string, typeof bookings>();
    for (const b of bookings) {
      const k = DateTime.fromMillis(b.startAt, { zone: tz }).toISODate()!;
      byDay.set(k, [...(byDay.get(k) ?? []), b]);
    }
    const cells: DateTime[] = [];
    for (let d = gridStart; d < gridEnd; d = d.plus({ days: 1 })) cells.push(d);
    return (
      <>
        <PageHeader title={anchor.toFormat("LLLL yyyy")}>
          <ViewSwitch view={view} date={anchor.toISODate()!} />
          <Link className="btn-secondary !px-3 !py-1.5" href={nav("month", -1)} aria-label="Previous month">‹</Link>
          <Link className="btn-secondary !px-3 !py-1.5" href={`/admin/calendar?view=month`}>Today</Link>
          <Link className="btn-secondary !px-3 !py-1.5" href={nav("month", 1)} aria-label="Next month">›</Link>
        </PageHeader>
        <div className="card overflow-hidden">
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs font-semibold uppercase text-slate-500">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="py-2">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((d) => {
              const key = d.toISODate()!;
              const list = byDay.get(key) ?? [];
              return (
                <div key={key} className={`min-h-28 border-b border-r border-slate-100 p-1.5 ${d.month !== anchor.month ? "bg-slate-50/60 text-slate-400" : ""}`}>
                  <Link href={`/admin/calendar?view=week&date=${key}`} className={`inline-grid h-6 min-w-6 place-items-center rounded-full px-1 text-xs font-semibold ${key === todayKey ? "bg-brand-600 text-white" : "hover:bg-slate-100"}`}>{d.day}</Link>
                  <ul className="mt-1 space-y-0.5">
                    {list.slice(0, 3).map((b) => (
                      <li key={b.id} className={`truncate rounded border-l-2 px-1 text-[11px] ${BLOCK[b.status] ?? BLOCK.confirmed}`} title={`${fmtTime(b.startAt, tz)} ${b.serviceName} – ${b.name}`}>
                        {fmtTime(b.startAt, tz)} {b.name}
                      </li>
                    ))}
                    {list.length > 3 && <li className="px-1 text-[11px] text-slate-500">+{list.length - 3} more</li>}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  }

  /* ---------------------------------------------------------------- week */
  const weekStart = anchor.startOf("week");
  const weekEnd = weekStart.plus({ weeks: 1 });
  const bookings = bookingsBetween(db, weekStart.toMillis(), weekEnd.toMillis());
  const externals = externalBusyBetween(db, weekStart.toMillis(), weekEnd.toMillis());

  const rules = loadRules(db).filter((r) => r.kind === "work");
  const localMin = (ms: number) => {
    const t = DateTime.fromMillis(ms, { zone: tz });
    return t.hour * 60 + t.minute;
  };
  let gridStart = Math.min(8 * 60, ...rules.map((r) => r.startMin), ...bookings.map((b) => localMin(b.startAt)));
  let gridEnd = Math.max(18 * 60, ...rules.map((r) => r.endMin), ...bookings.map((b) => Math.min(24 * 60, localMin(b.endAt) || 24 * 60)));
  gridStart = Math.floor(gridStart / 60) * 60;
  gridEnd = Math.min(24 * 60, Math.ceil(gridEnd / 60) * 60);
  const total = gridEnd - gridStart;
  const hours: number[] = [];
  for (let m = gridStart; m < gridEnd; m += 60) hours.push(m);
  const days = Array.from({ length: 7 }, (_, i) => weekStart.plus({ days: i }));
  const place = (startMs: number, endMs: number) => {
    const top = Math.max(0, localMin(startMs) - gridStart);
    const dur = Math.max(10, (endMs - startMs) / 60000);
    return { top: top * PX_PER_MIN, height: Math.min(dur, total - top) * PX_PER_MIN };
  };

  return (
    <>
      <PageHeader title={`${weekStart.toFormat("d LLL")} – ${weekEnd.minus({ days: 1 }).toFormat("d LLL yyyy")}`}>
        <ViewSwitch view={view} date={anchor.toISODate()!} />
        <Link className="btn-secondary !px-3 !py-1.5" href={nav("week", -1)} aria-label="Previous week">‹</Link>
        <Link className="btn-secondary !px-3 !py-1.5" href="/admin/calendar">Today</Link>
        <Link className="btn-secondary !px-3 !py-1.5" href={nav("week", 1)} aria-label="Next week">›</Link>
      </PageHeader>

      <div className="card overflow-x-auto">
        <div className="min-w-[760px]">
          <div className="grid grid-cols-[3.5rem_repeat(7,1fr)] border-b border-slate-200 bg-slate-50 text-center text-xs">
            <div />
            {days.map((d) => {
              const key = d.toISODate()!;
              const n = bookings.filter((b) => DateTime.fromMillis(b.startAt, { zone: tz }).toISODate() === key).length;
              return (
                <div key={key} className={`py-2 ${key === todayKey ? "font-bold text-brand-700" : "text-slate-600"}`}>
                  <div className="uppercase">{d.toFormat("ccc")}</div>
                  <div className="text-base">{d.day}</div>
                  <div className="text-[11px] text-slate-400">{n ? `${n} booked` : "—"}</div>
                </div>
              );
            })}
          </div>
          <div className="relative grid grid-cols-[3.5rem_repeat(7,1fr)]" style={{ height: total * PX_PER_MIN }}>
            <div className="relative">
              {hours.map((m) => (
                <div key={m} className="absolute right-1 -translate-y-1/2 text-[11px] text-slate-400" style={{ top: (m - gridStart) * PX_PER_MIN }}>
                  {DateTime.fromObject({ hour: m / 60 }).toFormat("h a")}
                </div>
              ))}
            </div>
            {days.map((d) => {
              const key = d.toISODate()!;
              const dayStart = d.startOf("day").toMillis();
              const dayEnd = d.plus({ days: 1 }).startOf("day").toMillis();
              return (
                <div key={key} className={`relative border-l border-slate-100 ${key === todayKey ? "bg-brand-50/40" : ""}`}>
                  {hours.map((m) => <div key={m} className="absolute inset-x-0 border-t border-slate-100" style={{ top: (m - gridStart) * PX_PER_MIN }} />)}
                  {externals.filter((e) => e.start_at < dayEnd && e.end_at > dayStart).map((e) => {
                    const p = place(Math.max(e.start_at, dayStart), Math.min(e.end_at, dayEnd));
                    return (
                      <div key={e.event_id} className="absolute inset-x-0.5 overflow-hidden rounded border border-slate-300 bg-[repeating-linear-gradient(45deg,#f1f5f9,#f1f5f9_6px,#e2e8f0_6px,#e2e8f0_12px)] px-1 text-[11px] text-slate-600" style={p} title={`Google Calendar: ${e.summary || "Busy"}`}>
                        {e.summary || "Busy"}
                      </div>
                    );
                  })}
                  {bookings.filter((b) => b.startAt >= dayStart && b.startAt < dayEnd).map((b) => (
                    <Link
                      key={b.id}
                      href={`/admin/bookings?q=${encodeURIComponent(b.email)}`}
                      className={`absolute inset-x-0.5 z-[1] overflow-hidden rounded border-l-4 px-1 py-0.5 text-[11px] leading-tight shadow-sm ${BLOCK[b.status] ?? BLOCK.confirmed}`}
                      style={place(b.startAt, b.endAt)}
                      title={`${fmtTime(b.startAt, tz)}–${fmtTime(b.endAt, tz)} ${b.serviceName} – ${b.name}`}
                      data-booking={b.id}
                    >
                      <span className="font-semibold">{fmtTime(b.startAt, tz)}</span> {b.name}
                      <div className="truncate opacity-80">{b.serviceName}</div>
                    </Link>
                  ))}
                  {key === todayKey && now.toMillis() >= dayStart && (() => {
                    const m = localMin(now.toMillis());
                    return m >= gridStart && m <= gridEnd ? <div className="absolute inset-x-0 z-[2] border-t-2 border-rose-500" style={{ top: (m - gridStart) * PX_PER_MIN }} aria-hidden /> : null;
                  })()}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-500">Times in {tz.replace(/_/g, " ")}. Hatched blocks are events from your connected Google Calendar.</p>
    </>
  );
}

function ViewSwitch({ view, date }: { view: "week" | "month"; date: string }) {
  return (
    <div className="mr-2 flex rounded-lg bg-slate-200 p-0.5 text-sm font-medium">
      {(["week", "month"] as const).map((v) => (
        <Link key={v} href={`/admin/calendar?view=${v}&date=${date}`} className={`rounded-md px-3 py-1 capitalize ${v === view ? "bg-white shadow-sm" : "text-slate-600"}`}>{v}</Link>
      ))}
    </div>
  );
}
