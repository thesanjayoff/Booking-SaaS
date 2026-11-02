import { env, has } from "@/lib/env";

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
    </section>
  );
}
