import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listServices, formatMoney, type Service } from "@/lib/services";
import { Flash, PageHeader } from "@/components/admin";
import { deleteServiceAction, saveServiceAction } from "../../actions";
import { fmtDuration } from "@/lib/format";
import { paymentsEnabled } from "@/lib/payments/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Services" };

const major = (minor: number) => (minor / 100).toFixed(2);

function ServiceForm({ s, payOn }: { s?: Service; payOn: boolean }) {
  const id = s?.id ?? "new";
  const f = (name: string) => `${name}-${id}`;
  return (
    <form action={saveServiceAction} className="grid gap-4 sm:grid-cols-2">
      {s && <input type="hidden" name="id" value={s.id} />}
      <div className="sm:col-span-2 grid gap-4 sm:grid-cols-2">
        <div><label className="label" htmlFor={f("name")}>Name</label><input id={f("name")} name="name" required maxLength={100} defaultValue={s?.name} className="input" /></div>
        <div><label className="label" htmlFor={f("slug")}>URL slug</label><input id={f("slug")} name="slug" required maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" defaultValue={s?.slug} className="input" placeholder="general-consultation" /></div>
      </div>
      <div className="sm:col-span-2"><label className="label" htmlFor={f("description")}>Description</label><textarea id={f("description")} name="description" maxLength={1000} defaultValue={s?.description} className="input min-h-20" /></div>
      <div><label className="label" htmlFor={f("duration")}>Duration (minutes)</label><input id={f("duration")} name="durationMin" type="number" min={5} max={720} step={5} required defaultValue={s?.durationMin ?? 30} className="input" /></div>
      <div><label className="label" htmlFor={f("interval")}>Slot spacing (minutes, optional)</label><input id={f("interval")} name="slotIntervalMin" type="number" min={5} max={240} step={5} defaultValue={s?.slotIntervalMin ?? ""} className="input" placeholder="uses the global default" /></div>
      <div><label className="label" htmlFor={f("price")}>Price</label><input id={f("price")} name="price" type="number" min={0} step="0.01" required defaultValue={major(s?.priceMinor ?? 0)} className="input" /></div>
      <div><label className="label" htmlFor={f("currency")}>Currency</label><input id={f("currency")} name="currency" maxLength={3} required defaultValue={s?.currency ?? "INR"} className="input uppercase" /></div>
      <div><label className="label" htmlFor={f("bb")}>Buffer before (min)</label><input id={f("bb")} name="bufferBeforeMin" type="number" min={0} max={240} step={5} defaultValue={s?.bufferBeforeMin ?? 0} className="input" /></div>
      <div><label className="label" htmlFor={f("ba")}>Buffer after (min)</label><input id={f("ba")} name="bufferAfterMin" type="number" min={0} max={240} step={5} defaultValue={s?.bufferAfterMin ?? 0} className="input" /></div>
      <div>
        <label className="label" htmlFor={f("deposit")}>Deposit (optional)</label>
        <input id={f("deposit")} name="deposit" type="number" min={0} step="0.01" defaultValue={major(s?.depositMinor ?? 0)} className="input" />
        <p className="mt-1 text-xs text-slate-500">{payOn ? "Collected via Razorpay to confirm the booking." : "Online payments are off, so deposits are not collected yet (see Settings)."}</p>
      </div>
      <div><label className="label" htmlFor={f("location")}>Location</label><input id={f("location")} name="location" maxLength={200} defaultValue={s?.location} className="input" /></div>
      <div><label className="label" htmlFor={f("sort")}>Sort order</label><input id={f("sort")} name="sortOrder" type="number" min={0} defaultValue={s?.sortOrder ?? 0} className="input" /></div>
      <div className="flex flex-col justify-end gap-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="createMeet" defaultChecked={s?.createMeet} /> Add a Google Meet link</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={s ? s.active : true} /> Visible on the booking page</label>
      </div>
      <div className="sm:col-span-2 flex gap-2"><button className="btn-primary">{s ? "Save changes" : "Create service"}</button></div>
    </form>
  );
}

export default async function ServicesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const services = listServices({}, getDb());
  const payOn = paymentsEnabled();

  return (
    <>
      <PageHeader title="Services" />
      <Flash ok={sp.ok} error={sp.error} />
      <ul className="space-y-3">
        {services.map((s) => (
          <li key={s.id} className="card p-4">
            <details>
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-semibold">{s.name}</span>{" "}
                  {!s.active && <span className="badge bg-slate-100 text-slate-600">Hidden</span>}
                  <span className="block text-sm text-slate-500">
                    {fmtDuration(s.durationMin)} · {s.priceMinor ? formatMoney(s.priceMinor, s.currency) : "Free"}
                    {s.depositMinor > 0 && ` · ${formatMoney(s.depositMinor, s.currency)} deposit`}
                    {(s.bufferBeforeMin || s.bufferAfterMin) ? ` · buffer ${s.bufferBeforeMin}/${s.bufferAfterMin} min` : ""}
                    {s.createMeet && " · Meet"}
                  </span>
                </span>
                <span className="text-sm font-medium text-brand-700">Edit</span>
              </summary>
              <div className="mt-4 border-t border-slate-100 pt-4">
                <ServiceForm s={s} payOn={payOn} />
                <form action={deleteServiceAction} className="mt-3">
                  <input type="hidden" name="id" value={s.id} />
                  <button className="text-sm text-red-600 hover:underline">Delete (hidden instead if it has bookings)</button>
                </form>
              </div>
            </details>
          </li>
        ))}
      </ul>

      <section className="card mt-6 p-5">
        <h2 className="mb-4 text-lg font-semibold">Add a service</h2>
        <ServiceForm payOn={payOn} />
      </section>
    </>
  );
}
