import { requireAdmin } from "@/lib/auth";
import { getDb, all } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { Flash, PageHeader } from "@/components/admin";
import { retryFailedJobsAction, saveSettingsAction } from "../../actions";
import { paymentsEnabled } from "@/lib/payments/config";
import { env, has } from "@/lib/env";
import { IntegrationsPanel } from "./integrations";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const db = getDb();
  const s = getSettings(db);
  const zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  if (!zones.includes(s.timezone)) zones.push(s.timezone);
  const jobs = all<{ status: string; n: number }>(db, "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status");
  const failed = all<{ id: number; type: string; last_error: string | null; attempts: number }>(db, "SELECT id, type, last_error, attempts FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 5");
  const e = env();

  return (
    <>
      <PageHeader title="Settings" />
      <Flash ok={sp.ok} error={sp.error} />

      <form action={saveSettingsAction} className="card grid gap-4 p-5 sm:grid-cols-2">
        <h2 className="text-lg font-semibold sm:col-span-2">Business</h2>
        <div><label className="label" htmlFor="businessName">Business name</label><input id="businessName" name="businessName" required maxLength={100} defaultValue={s.businessName} className="input" /></div>
        <div><label className="label" htmlFor="tagline">Tagline</label><input id="tagline" name="tagline" maxLength={200} defaultValue={s.tagline} className="input" /></div>
        <div><label className="label" htmlFor="address">Address</label><input id="address" name="address" maxLength={300} defaultValue={s.address} className="input" /></div>
        <div><label className="label" htmlFor="phone">Phone</label><input id="phone" name="phone" maxLength={40} defaultValue={s.phone} className="input" /></div>
        <div><label className="label" htmlFor="ownerEmail">Your email (new-booking alerts)</label><input id="ownerEmail" name="ownerEmail" type="email" defaultValue={s.ownerEmail} className="input" /></div>
        <div>
          <label className="label" htmlFor="timezone">Business time zone</label>
          <select id="timezone" name="timezone" defaultValue={s.timezone} className="input">{zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</select>
          <p className="mt-1 text-xs text-slate-500">Weekly hours and holidays are interpreted in this zone. Bookings are stored in UTC.</p>
        </div>

        <h2 className="mt-2 text-lg font-semibold sm:col-span-2">Booking rules</h2>
        <div><label className="label" htmlFor="minNoticeHours">Minimum notice (hours)</label><input id="minNoticeHours" name="minNoticeHours" type="number" min={0} step="0.5" defaultValue={s.minNoticeMin / 60} className="input" /></div>
        <div><label className="label" htmlFor="maxAdvanceDays">Book up to (days ahead)</label><input id="maxAdvanceDays" name="maxAdvanceDays" type="number" min={1} max={3650} defaultValue={s.maxAdvanceDays} className="input" /></div>
        <div><label className="label" htmlFor="slotIntervalMin">Default slot spacing (minutes)</label><input id="slotIntervalMin" name="slotIntervalMin" type="number" min={5} max={240} step={5} defaultValue={s.slotIntervalMin} className="input" /></div>
        <div><label className="label" htmlFor="cancelCutoffHours">Customers can cancel / reschedule until (hours before)</label><input id="cancelCutoffHours" name="cancelCutoffHours" type="number" min={0} defaultValue={s.cancelCutoffHours} className="input" /></div>
        <div><label className="label" htmlFor="holdMinutes">Hold unpaid deposit bookings for (minutes)</label><input id="holdMinutes" name="holdMinutes" type="number" min={5} max={120} defaultValue={s.holdMinutes} className="input" /></div>

        <h2 className="mt-2 text-lg font-semibold sm:col-span-2">Reminders</h2>
        <div>
          <label className="label" htmlFor="reminderOffsets">Send reminders this many hours before</label>
          <input id="reminderOffsets" name="reminderOffsets" defaultValue={s.reminderOffsetsMin.map((m) => m / 60).join(", ")} className="input" placeholder="24, 2" />
          <p className="mt-1 text-xs text-slate-500">Comma separated, up to 4. Example: <code>24, 2</code></p>
        </div>
        <fieldset className="text-sm">
          <legend className="label">Channels</legend>
          <div className="space-y-1">
            {(["email", "sms", "whatsapp"] as const).map((c) => (
              <label key={c} className="flex items-center gap-2"><input type="checkbox" name={`ch_${c}`} defaultChecked={s.reminderChannels.includes(c)} /> <span className="capitalize">{c === "sms" ? "SMS" : c}</span>
                <span className="text-xs text-slate-500">{c === "email" ? (has(e.SMTP_HOST) ? "SMTP configured" : "no SMTP: written to data/outbox") : c === "sms" ? (has(e.TWILIO_ACCOUNT_SID) ? "Twilio configured" : "not configured") : (has(e.WHATSAPP_ACCESS_TOKEN) ? "WhatsApp Cloud API configured" : "not configured")}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="sm:col-span-2"><button className="btn-primary">Save settings</button></div>
      </form>

      <IntegrationsPanel paymentsOn={paymentsEnabled()} />

      <section className="card mt-6 p-5" aria-labelledby="queue">
        <h2 id="queue" className="text-lg font-semibold">Background jobs</h2>
        <p className="text-sm text-slate-500">{jobs.length ? jobs.map((j) => `${j.n} ${j.status}`).join(" · ") : "Queue is empty."}</p>
        {failed.length > 0 && (
          <>
            <ul className="mt-3 space-y-1 text-sm">
              {failed.map((j) => <li key={j.id} className="rounded bg-red-50 px-3 py-2 text-red-800"><strong>{j.type}</strong> failed after {j.attempts} attempts: {j.last_error}</li>)}
            </ul>
            <form action={retryFailedJobsAction} className="mt-3"><button className="btn-secondary">Retry failed jobs</button></form>
          </>
        )}
      </section>
    </>
  );
}
