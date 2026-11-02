"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type FlowService = {
  slug: string;
  name: string;
  description: string;
  durationMin: number;
  priceLabel: string;
  depositLabel: string | null;
  createMeet: boolean;
  location: string;
};

type Props = {
  service: FlowService;
  businessName: string;
  businessTimezone: string;
  maxAdvanceDays: number;
  /** Present when rescheduling an existing booking. */
  reschedule?: { id: string; token: string; currentStart: string };
};

type FieldErrors = Record<string, string>;

const dateKeyFmt = new Map<string, Intl.DateTimeFormat>();
function dateKey(iso: string, tz: string): string {
  let f = dateKeyFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dateKeyFmt.set(tz, f);
  }
  return f.format(new Date(iso)); // YYYY-MM-DD
}

const timeLabel = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));

const longDate = (key: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${key}T00:00:00Z`));

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function loadRazorpay(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

export default function BookingFlow({ service, businessName, businessTimezone, maxAdvanceDays, reschedule }: Props) {
  const router = useRouter();
  const [tz, setTz] = useState(businessTimezone);
  const [zones, setZones] = useState<string[]>([businessTimezone]);
  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState({ y: today.getUTCFullYear(), m: today.getUTCMonth() });
  const [slots, setSlots] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [step, setStep] = useState<"pick" | "details">("pick");
  const [form, setForm] = useState({ name: "", email: "", phone: "", notes: "", website: "" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const idemKey = useRef<string>("");

  // Detect the visitor's zone after hydration (avoids server/client mismatch).
  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || businessTimezone;
    let all: string[] = [];
    try {
      all = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
    } catch {
      all = [];
    }
    const set = new Set([detected, businessTimezone, "UTC", ...all]);
    setZones([...set].sort());
    setTz(detected);
  }, [businessTimezone]);

  const fetchSlots = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const from = new Date(Date.UTC(cursor.y, cursor.m, 1) - 14 * 3600_000).toISOString();
    const to = new Date(Date.UTC(cursor.y, cursor.m + 1, 1) + 14 * 3600_000).toISOString();
    const qs = new URLSearchParams({ service: service.slug, from, to });
    if (reschedule) {
      qs.set("reschedule", reschedule.id);
      qs.set("t", reschedule.token);
    }
    try {
      const res = await fetch(`/api/slots?${qs}`, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? "Could not load available times.");
      }
      const data = (await res.json()) as { slots: string[] };
      setSlots(data.slots);
    } catch (e) {
      setSlots([]);
      setLoadError(e instanceof Error ? e.message : "Could not load available times.");
    } finally {
      setLoading(false);
    }
  }, [cursor, service.slug, reschedule]);

  useEffect(() => {
    void fetchSlots();
  }, [fetchSlots]);

  const byDate = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of slots) {
      const k = dateKey(s, tz);
      (map.get(k) ?? map.set(k, []).get(k)!).push(s);
    }
    return map;
  }, [slots, tz]);

  // Keep the selection valid when the zone / month changes.
  useEffect(() => {
    if (selectedDate && !byDate.has(selectedDate)) setSelectedDate(null);
    if (selectedSlot && !slots.includes(selectedSlot)) setSelectedSlot(null);
  }, [byDate, slots, selectedDate, selectedSlot]);

  const grid = useMemo(() => {
    const first = new Date(Date.UTC(cursor.y, cursor.m, 1));
    const offset = (first.getUTCDay() + 6) % 7; // Monday first
    const days = new Date(Date.UTC(cursor.y, cursor.m + 1, 0)).getUTCDate();
    const cells: (string | null)[] = Array(offset).fill(null);
    for (let d = 1; d <= days; d++) cells.push(`${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    return cells;
  }, [cursor]);

  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(cursor.y, cursor.m, 1)));
  const minCursor = today.getUTCFullYear() * 12 + today.getUTCMonth();
  const maxDate = new Date(today.getTime() + maxAdvanceDays * 86_400_000);
  const maxCursor = maxDate.getUTCFullYear() * 12 + maxDate.getUTCMonth();
  const curIdx = cursor.y * 12 + cursor.m;
  const goMonth = (delta: number) => {
    const idx = curIdx + delta;
    setCursor({ y: Math.floor(idx / 12), m: idx % 12 });
  };

  const pickSlot = (iso: string) => {
    setSelectedSlot(iso);
    idemKey.current = crypto.randomUUID();
  };

  async function submitReschedule() {
    if (!reschedule || !selectedSlot) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/bookings/${reschedule.id}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: reschedule.token, start: selectedSlot }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(body?.error?.message ?? "Could not reschedule.");
        if (res.status === 409) {
          setSelectedSlot(null);
          void fetchSlots();
        }
        return;
      }
      router.push(`/booking/${reschedule.id}?t=${encodeURIComponent(reschedule.token)}&moved=1`);
    } catch {
      setSubmitError("Network problem. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitBooking(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSlot || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: service.slug,
          start: selectedSlot,
          name: form.name,
          email: form.email,
          phone: form.phone,
          notes: form.notes,
          timezone: tz,
          idempotencyKey: idemKey.current,
          website: form.website,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 422 && body?.error?.fields) {
        setFieldErrors(body.error.fields);
        setSubmitError(body.error.message);
        return;
      }
      if (!res.ok) {
        setSubmitError(body?.error?.message ?? "Could not complete the booking.");
        if (res.status === 409) {
          setStep("pick");
          setSelectedSlot(null);
          void fetchSlots();
        }
        return;
      }
      if (body.payment) {
        const ok = await loadRazorpay();
        if (!ok || !window.Razorpay) {
          router.push(`${body.manageUrl}&pay=1`);
          return;
        }
        const rzp = new window.Razorpay({
          key: body.payment.keyId,
          order_id: body.payment.orderId,
          amount: body.payment.amount,
          currency: body.payment.currency,
          name: body.payment.businessName,
          description: body.payment.description,
          prefill: body.payment.prefill,
          theme: { color: "#0d9488" },
          handler: async (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
            await fetch(`/api/bookings/${body.id}/pay/verify`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ t: body.token, ...r }),
            }).catch(() => null);
            router.push(`${body.manageUrl}&new=1`);
          },
          modal: { ondismiss: () => router.push(`${body.manageUrl}&pay=1`) },
        });
        rzp.open();
        return;
      }
      router.push(`${body.manageUrl}&new=1`);
    } catch {
      setSubmitError("Network problem. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const daySlots = selectedDate ? (byDate.get(selectedDate) ?? []) : [];

  return (
    <div className="card overflow-hidden lg:grid lg:grid-cols-[18rem_1fr]">
      {/* ---- left: summary ---- */}
      <aside className="border-b border-slate-200 bg-slate-50 p-6 lg:border-b-0 lg:border-r">
        <p className="text-sm font-medium text-slate-500">{businessName}</p>
        <h1 className="mt-1 text-xl font-bold text-slate-900">{reschedule ? "Reschedule: " : ""}{service.name}</h1>
        <ul className="mt-4 space-y-2 text-sm text-slate-700">
          <li>⏱ {service.durationMin} minutes</li>
          <li>💳 {service.priceLabel}{service.depositLabel ? ` · ${service.depositLabel} deposit to confirm` : ""}</li>
          {service.createMeet && <li>🎥 Video link provided after booking</li>}
          {service.location && <li>📍 {service.location}</li>}
        </ul>
        {service.description && <p className="mt-4 text-sm text-slate-600">{service.description}</p>}

        {selectedSlot && (
          <div className="mt-5 rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm text-brand-800" data-testid="selected-summary">
            <div className="font-semibold">{longDate(dateKey(selectedSlot, tz))}</div>
            <div>{timeLabel(selectedSlot, tz)}</div>
          </div>
        )}

        <div className="mt-6">
          <label htmlFor="tz" className="label">Your time zone</label>
          <select id="tz" className="input" value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>{z.replace(/_/g, " ")}</option>
            ))}
          </select>
          {tz !== businessTimezone && <p className="mt-1 text-xs text-slate-500">Clinic time zone: {businessTimezone.replace(/_/g, " ")}</p>}
        </div>
      </aside>

      {/* ---- right: picker or form ---- */}
      <section className="p-6">
        {step === "pick" && (
          <div className="grid gap-6 md:grid-cols-[1fr_12rem]">
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold">{monthLabel}</h2>
                <div className="flex gap-1">
                  <button type="button" className="btn-secondary !px-3 !py-1.5" onClick={() => goMonth(-1)} disabled={curIdx <= minCursor} aria-label="Previous month">‹</button>
                  <button type="button" className="btn-secondary !px-3 !py-1.5" onClick={() => goMonth(1)} disabled={curIdx >= maxCursor} aria-label="Next month">›</button>
                </div>
              </div>
              <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-slate-500">
                {WEEKDAYS.map((w) => <div key={w} className="py-1">{w}</div>)}
              </div>
              <div className="mt-1 grid grid-cols-7 gap-1" role="grid" aria-label={monthLabel} aria-busy={loading}>
                {grid.map((key, i) =>
                  key === null ? (
                    <div key={`b${i}`} />
                  ) : (
                    <button
                      key={key}
                      type="button"
                      data-date={key}
                      disabled={!byDate.has(key)}
                      onClick={() => { setSelectedDate(key); setSelectedSlot(null); }}
                      aria-pressed={selectedDate === key}
                      className={[
                        "aspect-square rounded-lg text-sm font-medium transition",
                        selectedDate === key
                          ? "bg-brand-600 text-white"
                          : byDate.has(key)
                            ? "bg-brand-50 text-brand-800 hover:bg-brand-100"
                            : "cursor-not-allowed text-slate-300",
                      ].join(" ")}
                    >
                      {Number(key.slice(8))}
                    </button>
                  ),
                )}
              </div>
              {loading && <p className="mt-3 text-sm text-slate-500" role="status">Loading availability…</p>}
              {loadError && <p className="mt-3 text-sm text-red-600" role="alert">{loadError}</p>}
              {!loading && !loadError && byDate.size === 0 && (
                <p className="mt-3 text-sm text-slate-500">No openings this month. Try the next month.</p>
              )}
            </div>

            <div>
              <h2 className="mb-3 text-base font-semibold">{selectedDate ? longDate(selectedDate) : "Pick a date"}</h2>
              {selectedDate ? (
                <ul className="max-h-80 space-y-2 overflow-y-auto pr-1" data-testid="slot-list">
                  {daySlots.map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        data-slot={s}
                        onClick={() => pickSlot(s)}
                        aria-pressed={selectedSlot === s}
                        className={[
                          "w-full rounded-lg border px-3 py-2 text-sm font-semibold transition",
                          selectedSlot === s ? "border-brand-600 bg-brand-600 text-white" : "border-brand-200 text-brand-700 hover:border-brand-600",
                        ].join(" ")}
                      >
                        {timeLabel(s, tz)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">Highlighted dates have openings.</p>
              )}
            </div>

            {selectedSlot && (
              <div className="md:col-span-2">
                {submitError && <p className="mb-2 text-sm text-red-600" role="alert">{submitError}</p>}
                {reschedule ? (
                  <button type="button" className="btn-primary w-full" disabled={submitting || selectedSlot === reschedule.currentStart} onClick={submitReschedule}>
                    {submitting ? "Moving…" : "Confirm new time"}
                  </button>
                ) : (
                  <button type="button" className="btn-primary w-full" onClick={() => setStep("details")}>Continue</button>
                )}
              </div>
            )}
            {!selectedSlot && submitError && <p className="text-sm text-red-600 md:col-span-2" role="alert">{submitError}</p>}
          </div>
        )}

        {step === "details" && selectedSlot && (
          <form onSubmit={submitBooking} className="space-y-4" noValidate>
            <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => setStep("pick")}>← Change time</button>
            <h2 className="text-lg font-semibold">Your details</h2>

            <div>
              <label htmlFor="name" className="label">Full name</label>
              <input id="name" className="input" autoComplete="name" required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-invalid={!!fieldErrors.name} />
              {fieldErrors.name && <p className="mt-1 text-xs text-red-600">{fieldErrors.name}</p>}
            </div>
            <div>
              <label htmlFor="email" className="label">Email</label>
              <input id="email" type="email" className="input" autoComplete="email" required maxLength={254} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-invalid={!!fieldErrors.email} />
              {fieldErrors.email && <p className="mt-1 text-xs text-red-600">{fieldErrors.email}</p>}
            </div>
            <div>
              <label htmlFor="phone" className="label">Phone <span className="font-normal text-slate-400">(for SMS / WhatsApp reminders)</span></label>
              <input id="phone" type="tel" className="input" autoComplete="tel" placeholder="+91 98765 43210" maxLength={30} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} aria-invalid={!!fieldErrors.phone} />
              {fieldErrors.phone && <p className="mt-1 text-xs text-red-600">{fieldErrors.phone}</p>}
            </div>
            <div>
              <label htmlFor="notes" className="label">Anything we should know? <span className="font-normal text-slate-400">(optional)</span></label>
              <textarea id="notes" className="input min-h-24" maxLength={1000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            {/* Honeypot: hidden from people, irresistible to form-filling bots. */}
            <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
              <label>Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></label>
            </div>

            {submitError && <p className="text-sm text-red-600" role="alert">{submitError}</p>}
            <button type="submit" className="btn-primary w-full" disabled={submitting}>
              {submitting ? "Booking…" : service.depositLabel ? `Continue to pay ${service.depositLabel} deposit` : "Confirm booking"}
            </button>
            <p className="text-center text-xs text-slate-500">You'll get a link to cancel or reschedule.</p>
          </form>
        )}
      </section>
    </div>
  );
}
