import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { listServices } from "@/lib/services";
import { loadExceptions, loadRules } from "@/lib/availability/store";
import { Flash, PageHeader } from "@/components/admin";
import { addExceptionAction, addServiceRuleAction, deleteExceptionAction, deleteRuleAction, saveHoursAction } from "../../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Availability" };

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function TimePair({ name, def, label }: { name: string; def?: { startMin: number; endMin: number }; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <input type="time" name={`${name}_s`} defaultValue={def ? hhmm(def.startMin) : ""} className="input !w-28 !px-2 !py-1.5" aria-label={`${label} start`} />
      <span className="text-slate-400">–</span>
      <input type="time" name={`${name}_e`} defaultValue={def ? hhmm(def.endMin) : ""} className="input !w-28 !px-2 !py-1.5" aria-label={`${label} end`} />
    </span>
  );
}

export default async function AvailabilityPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const db = getDb();
  const tz = getSettings(db).timezone;
  const rules = loadRules(db);
  const exceptions = loadExceptions(db);
  const services = listServices({}, db);
  const svcName = new Map(services.map((s) => [s.id, s.name]));
  const globalRules = rules.filter((r) => r.serviceId === null);
  const serviceRules = rules.filter((r) => r.serviceId !== null);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader title="Availability" />
      <Flash ok={sp.ok} error={sp.error} />

      <section className="card p-5" aria-labelledby="weekly">
        <h2 id="weekly" className="text-lg font-semibold">Weekly hours</h2>
        <p className="mb-4 text-sm text-slate-500">
          All times are in <strong>{tz.replace(/_/g, " ")}</strong> (change in Settings). Leave a row empty for a day off. Overlapping ranges are merged; breaks are removed from working hours.
        </p>
        <form action={saveHoursAction} className="space-y-3">
          {DAYS.map((name, i) => {
            const d = i + 1;
            const work = globalRules.filter((r) => r.weekday === d && r.kind === "work");
            const brk = globalRules.filter((r) => r.weekday === d && r.kind === "break");
            return (
              <div key={d} className="grid gap-2 border-t border-slate-100 pt-3 lg:grid-cols-[7rem_1fr_1fr]">
                <div className="pt-2 text-sm font-semibold">{name}</div>
                <div>
                  <div className="mb-1 text-xs font-medium uppercase text-slate-500">Working hours</div>
                  <div className="flex flex-wrap gap-2">{[0, 1, 2].map((k) => <TimePair key={k} name={`w${d}_${k}`} def={work[k]} label={`${name} work ${k + 1}`} />)}</div>
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium uppercase text-slate-500">Breaks</div>
                  <div className="flex flex-wrap gap-2">{[0, 1].map((k) => <TimePair key={k} name={`b${d}_${k}`} def={brk[k]} label={`${name} break ${k + 1}`} />)}</div>
                </div>
              </div>
            );
          })}
          <button className="btn-primary mt-2">Save weekly hours</button>
        </form>
      </section>

      <section className="card mt-6 p-5" aria-labelledby="holidays">
        <h2 id="holidays" className="text-lg font-semibold">Holidays &amp; date overrides</h2>
        <p className="mb-4 text-sm text-slate-500">Close a day (or a range), or set custom hours for specific dates. Custom hours replace that day's weekly hours and breaks.</p>
        <form action={addExceptionAction} className="grid gap-3 sm:grid-cols-6">
          <div className="sm:col-span-2"><label className="label" htmlFor="ex-from">From</label><input id="ex-from" type="date" name="from" required min={today} className="input" /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="ex-to">To (optional)</label><input id="ex-to" type="date" name="to" min={today} className="input" /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="ex-kind">Type</label>
            <select id="ex-kind" name="kind" className="input"><option value="closed">Closed all day</option><option value="open">Custom hours</option></select></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="ex-start">Custom start</label><input id="ex-start" type="time" name="start" className="input" /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="ex-end">Custom end</label><input id="ex-end" type="time" name="end" className="input" /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="ex-label">Label</label><input id="ex-label" name="label" maxLength={100} className="input" placeholder="Diwali" /></div>
          <label className="flex items-center gap-2 text-sm sm:col-span-4"><input type="checkbox" name="yearly" /> Repeat every year (e.g. national holidays)</label>
          <div className="sm:col-span-2 sm:text-right"><button className="btn-primary">Add</button></div>
        </form>

        <ul className="mt-5 divide-y divide-slate-100 text-sm">
          {exceptions.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                <span className="font-medium">{e.yearly ? `${e.date.slice(5)} (every year)` : e.date}</span>{" "}
                {e.kind === "closed" ? <span className="badge bg-rose-50 text-rose-700">Closed</span> : <span className="badge bg-sky-50 text-sky-700">{hhmm(e.startMin!)}–{hhmm(e.endMin!)}</span>}{" "}
                <span className="text-slate-500">{e.label}</span>
              </span>
              <form action={deleteExceptionAction}><input type="hidden" name="id" value={e.id} /><button className="text-red-600 hover:underline">Remove</button></form>
            </li>
          ))}
          {exceptions.length === 0 && <li className="py-3 text-slate-500">No holidays or overrides yet.</li>}
        </ul>
      </section>

      <section className="card mt-6 p-5" aria-labelledby="svc-hours">
        <h2 id="svc-hours" className="text-lg font-semibold">Service-specific hours</h2>
        <p className="mb-4 text-sm text-slate-500">A service with its own hours is offered <em>only</em> then (e.g. screenings in the mornings). Global breaks and holidays still apply.</p>
        <form action={addServiceRuleAction} className="flex flex-wrap items-end gap-3">
          <div><label className="label" htmlFor="sr-svc">Service</label>
            <select id="sr-svc" name="serviceId" required className="input !w-56">{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          <fieldset className="flex flex-wrap gap-2 text-sm"><legend className="label">Days</legend>
            {DAYS.map((n, i) => <label key={n} className="flex items-center gap-1"><input type="checkbox" name="weekday" value={i + 1} /> {n.slice(0, 3)}</label>)}</fieldset>
          <div><label className="label" htmlFor="sr-s">From</label><input id="sr-s" type="time" name="start" required className="input !w-32" /></div>
          <div><label className="label" htmlFor="sr-e">To</label><input id="sr-e" type="time" name="end" required className="input !w-32" /></div>
          <button className="btn-primary">Add</button>
        </form>
        <ul className="mt-5 divide-y divide-slate-100 text-sm">
          {serviceRules.map((r) => (
            <li key={r.id} className="flex items-center justify-between py-2">
              <span><span className="font-medium">{svcName.get(r.serviceId!) ?? "Service"}</span> · {DAYS[r.weekday - 1]} {hhmm(r.startMin)}–{hhmm(r.endMin)}</span>
              <form action={deleteRuleAction}><input type="hidden" name="id" value={r.id} /><button className="text-red-600 hover:underline">Remove</button></form>
            </li>
          ))}
          {serviceRules.length === 0 && <li className="py-3 text-slate-500">All services follow the weekly hours above.</li>}
        </ul>
      </section>
    </>
  );
}
