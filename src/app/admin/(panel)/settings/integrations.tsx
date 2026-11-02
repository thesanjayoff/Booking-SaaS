import { env, has } from "@/lib/env";
import { getDb } from "@/lib/db";
import { googleStatus } from "@/lib/google/sync";
import { googleConfigured, redirectUri } from "@/lib/google/oauth";
import { fmtShort } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { disconnectGoogleAction, syncGoogleNowAction } from "../../actions";

function Row({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${ok ? "bg-emerald-500" : "bg-slate-300"}`} aria-hidden />
      <span><span className="font-medium">{label}</span>{hint && <span className="text-slate-500"> — {hint}</span>}</span>
    </li>
  );
}

export function IntegrationsPanel({ paymentsOn }: { paymentsOn: boolean }) {
  const e = env();
  const base = e.APP_URL.replace(/\/$/, "");
  const db = getDb();
  const google = googleStatus(db);
  const tz = getSettings(db).timezone;
  return (
    <section className="card mt-6 p-5" aria-labelledby="integrations">
      <h2 id="integrations" className="text-lg font-semibold">Integrations</h2>
      <p className="mb-3 text-sm text-slate-500">Secrets live in environment variables (.env), never in the database or the browser. Restart after changing them.</p>

      <h3 className="mt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">Razorpay deposits</h3>
      <ul className="mt-2 space-y-1.5">
        <Row ok={paymentsOn} label={paymentsOn ? "Payments are ON" : "Payments are OFF"} hint={paymentsOn ? "services with a deposit require it to confirm" : "set PAYMENTS_ENABLED=1 plus the Razorpay keys to turn on"} />
        <Row ok={has(e.RAZORPAY_KEY_ID) && has(e.RAZORPAY_KEY_SECRET)} label="API keys" hint="RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET" />
        <Row ok={has(e.RAZORPAY_WEBHOOK_SECRET)} label="Webhook secret" hint={`add ${base}/api/webhooks/razorpay in the Razorpay dashboard (events: payment.captured, order.paid, refund.processed)`} />
      </ul>

      <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-500">Google Calendar (two-way)</h3>
      {google ? (
        <div className="mt-2 space-y-3 text-sm">
          <ul className="space-y-1.5">
            <Row ok label={`Connected as ${google.email}`} hint={google.lastSyncedAt ? `last sync ${fmtShort(google.lastSyncedAt, tz)}` : "first sync pending"} />
            <Row ok label="Bookings → Google" hint={`${google.linkedBookings} booking${google.linkedBookings === 1 ? "" : "s"} on your calendar; services marked “Meet” get a video link`} />
            <Row ok label="Google → bookings" hint={`${google.mirroredEvents} of your other events block slots; deleting/moving a booking's event updates the booking`} />
          </ul>
          <div className="flex gap-2">
            <form action={syncGoogleNowAction}><button className="btn-secondary">Sync now</button></form>
            <form action={disconnectGoogleAction}><button className="btn-secondary !text-red-700">Disconnect</button></form>
          </div>
        </div>
      ) : (
        <div className="mt-2 space-y-2 text-sm">
          <ul className="space-y-1.5">
            <Row ok={googleConfigured()} label="OAuth client" hint="GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET" />
            <Row ok={false} label="Not connected" hint={`authorised redirect URI to register: ${redirectUri()}`} />
          </ul>
          {googleConfigured() ? <a className="btn-primary" href="/api/google/connect">Connect Google Calendar</a> : <p className="text-slate-500">Create an OAuth client (Web application) in Google Cloud Console, add the redirect URI above, put the credentials in .env, restart, then connect.</p>}
        </div>
      )}
    </section>
  );
}
