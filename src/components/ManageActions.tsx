"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function CancelButton({ id, token }: { id: string; token: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bookings/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token, reason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body?.error?.message ?? "Could not cancel.");
      router.refresh();
      setOpen(false);
    } catch {
      setError("Network problem. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>Cancel appointment</button>;
  return (
    <div className="w-full rounded-lg border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-medium text-red-900">Cancel this appointment?</p>
      <label htmlFor="reason" className="label mt-3">Reason <span className="font-normal text-slate-500">(optional)</span></label>
      <input id="reason" className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn-danger" onClick={cancel} disabled={busy}>{busy ? "Cancelling…" : "Yes, cancel it"}</button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>Keep it</button>
      </div>
    </div>
  );
}

export function PayDepositButton({ id, token, label, autoOpen }: { id: string; token: string; label: string; autoOpen?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bookings/${id}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body?.error?.message ?? "Could not start payment.");
      if (!window.Razorpay) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://checkout.razorpay.com/v1/checkout.js";
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("load"));
          document.body.appendChild(s);
        });
      }
      const p = body.payment;
      new window.Razorpay!({
        key: p.keyId,
        order_id: p.orderId,
        amount: p.amount,
        currency: p.currency,
        name: p.businessName,
        description: p.description,
        prefill: p.prefill,
        theme: { color: "#0d9488" },
        handler: async (r: Record<string, string>) => {
          await fetch(`/api/bookings/${id}/pay/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ t: token, ...r }),
          }).catch(() => null);
          router.replace(`/booking/${id}?t=${encodeURIComponent(token)}&new=1`);
          router.refresh();
        },
      }).open();
    } catch {
      setError("Could not open the payment window. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (autoOpen) void pay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <button type="button" className="btn-primary" onClick={pay} disabled={busy}>{busy ? "Opening…" : label}</button>
      {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
    </div>
  );
}
