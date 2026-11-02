"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Clock, Globe, Lock, MapPin, Spinner, Video, Wallet } from "@/components/icons";
import Stepper from "@/components/Stepper";

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

/** Short zone name for a given instant, e.g. "GMT+5:30". */
const zoneName = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")?.value ?? tz;

const FIELD_LABELS: Record<string, string> = { name: "Full name", email: "Email", phone: "Phone", notes: "Notes" };

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 flex items-start gap-1.5 text-sm text-red-600">
      <Alert className="mt-0.5 size-4 shrink-0" />
      {message}
    </p>
  );
}

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
  const summaryRef = useRef<HTMLDivElement>(null);

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

  // Send keyboard and screen-reader focus to the error summary when validation fails.
  useEffect(() => {
    if (Object.keys(fieldErrors).length) summaryRef.current?.focus();
  }, [fieldErrors]);

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
          theme: { color: "#e0b972" },
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
  const todayKey = dateKey(today.toISOString(), tz);
  const errorFields = Object.keys(fieldErrors).filter((k) => k in FIELD_LABELS);

  return (
    <div className="panel overflow-hidden lg:grid lg:grid-cols-[19rem_minmax(0,1fr)]">
      {/* ---- left: what you're booking ---- */}
      <aside className="relative border-b border-[rgba(247,237,213,0.07)] bg-[rgba(224,185,114,0.04)] p-6 sm:p-8 lg:border-b-0 lg:border-r">
        <p className="text-sm font-semibold text-gold-400">{businessName}</p>
        <h1 className="mt-2 text-fluid-xl font-medium text-gold-100">{reschedule ? "Reschedule: " : ""}{service.name}</h1>
        <ul className="mt-6 space-y-3 text-[0.9375rem] text-gold-200">
          <li className="flex items-center gap-3"><Clock className="size-5 shrink-0 text-gold-250" />{service.durationMin} minutes</li>
          <li className="flex items-center gap-3"><Wallet className="size-5 shrink-0 text-gold-250" />{service.priceLabel}{service.depositLabel ? ` · ${service.depositLabel} deposit to confirm` : ""}</li>
          {service.createMeet && <li className="flex items-center gap-3"><Video className="size-5 shrink-0 text-gold-250" />Video link provided after booking</li>}
          {service.location && <li className="flex items-start gap-3"><MapPin className="mt-0.5 size-5 shrink-0 text-gold-250" />{service.location}</li>}
        </ul>
        {service.description && <p className="mt-6 text-[0.9375rem] text-slate-500">{service.description}</p>}

        {selectedSlot && (
          <div
            className="mt-7 rounded-[var(--radius-card)] border border-gold-250/40 bg-gold-250/10 p-4"
            data-testid="selected-summary"
            style={{ animation: "rise-in 0.5s var(--ease-out-expo) both" }}
          >
            <p className="eyebrow">Your time</p>
            <p className="mt-2 text-lg font-semibold tracking-[-0.02em] text-gold-100">{longDate(dateKey(selectedSlot, tz))}</p>
            <p className="text-gold-200">{timeLabel(selectedSlot, tz)} <span className="text-slate-500">({zoneName(selectedSlot, tz)})</span></p>
          </div>
        )}

        <div className="mt-7">
          <label htmlFor="tz" className="label flex items-center gap-2"><Globe className="size-4 text-gold-250" />Your time zone</label>
          <select id="tz" className="input" value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>{z.replace(/_/g, " ")}</option>
            ))}
          </select>
          {tz !== businessTimezone && <p className="mt-2 text-sm text-slate-500">Clinic time zone: {businessTimezone.replace(/_/g, " ")}</p>}
        </div>
      </aside>

      {/* ---- right: picker or form ---- */}
      <section className="p-6 sm:p-8 lg:p-10" aria-busy={submitting}>
        <div className="mb-8">
          <Stepper steps={reschedule ? ["Pick a new time", "Confirmed"] : ["Pick a time", "Your details", "Confirmed"]} current={step === "pick" ? 0 : 1} />
        </div>

        {step === "pick" && (
          <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_12.5rem]">
            <div>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-fluid-lg font-semibold tracking-[-0.03em]">{monthLabel}</h2>
                <div className="flex gap-2">
                  <button type="button" className="btn-secondary !min-h-11 !w-11 !p-0" onClick={() => goMonth(-1)} disabled={curIdx <= minCursor} aria-label="Previous month"><ChevronLeft className="size-5" /></button>
                  <button type="button" className="btn-secondary !min-h-11 !w-11 !p-0" onClick={() => goMonth(1)} disabled={curIdx >= maxCursor} aria-label="Next month"><ChevronRight className="size-5" /></button>
                </div>
              </div>
              <div className="grid grid-cols-7 gap-1.5 text-center text-xs font-semibold text-slate-500" aria-hidden="true">
                {WEEKDAYS.map((w) => <div key={w} className="py-1">{w}</div>)}
              </div>
              <div className={`mt-1.5 grid grid-cols-7 gap-1.5 transition-opacity duration-300 ${loading ? "opacity-50" : ""}`} role="group" aria-label={monthLabel} aria-busy={loading}>
                {grid.map((key, i) =>
                  key === null ? (
                    <div key={`b${i}`} />
                  ) : (
                    <button
                      key={key}
                      type="button"
                      data-date={key}
                      data-today={key === todayKey}
                      disabled={!byDate.has(key)}
                      onClick={() => { setSelectedDate(key); setSelectedSlot(null); }}
                      aria-pressed={selectedDate === key}
                      aria-label={`${longDate(key)}${byDate.has(key) ? "" : ", no times available"}`}
                      className="day"
                    >
                      {Number(key.slice(8))}
                    </button>
                  ),
                )}
              </div>
              {loading && <p className="mt-4 flex items-center gap-2 text-sm text-slate-500" role="status"><Spinner className="size-4 text-gold-250" />Loading availability…</p>}
              {loadError && (
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-[var(--radius-tile)] border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
                  <Alert className="size-5 shrink-0" />
                  <span className="min-w-0 flex-1">{loadError}</span>
                  <button type="button" className="btn-secondary !min-h-9 !px-4 !py-1 !text-sm" onClick={() => void fetchSlots()}>Try again</button>
                </div>
              )}
              {!loading && !loadError && byDate.size === 0 && (
                <p className="mt-4 text-sm text-slate-500">No openings this month. Try the next month.</p>
              )}
            </div>

            <div>
              <h2 className="mb-4 text-fluid-lg font-semibold tracking-[-0.03em]">{selectedDate ? longDate(selectedDate) : "Pick a date"}</h2>
              {selectedDate ? (
                <ul className="-m-1 grid max-h-80 grid-cols-3 gap-2 overflow-y-auto p-1 md:grid-cols-1" data-testid="slot-list">
                  {daySlots.map((s) => (
                    <li key={s}>
                      <button type="button" data-slot={s} onClick={() => pickSlot(s)} aria-pressed={selectedSlot === s} className="slot w-full">
                        {timeLabel(s, tz)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">Choose a highlighted date to see its times.</p>
              )}
            </div>

            {selectedSlot && (
              <div className="md:col-span-2" style={{ animation: "rise-in 0.5s var(--ease-out-expo) both" }}>
                {submitError && (
                  <p className="mb-3 flex items-start gap-2 text-sm text-red-600" role="alert"><Alert className="mt-0.5 size-4 shrink-0" />{submitError}</p>
                )}
                {reschedule ? (
                  <button type="button" className="btn-primary w-full sm:w-auto sm:min-w-64" disabled={submitting || selectedSlot === reschedule.currentStart} onClick={submitReschedule}>
                    {submitting ? <><Spinner className="size-4" />Moving…</> : "Confirm new time"}
                  </button>
                ) : (
                  <button type="button" className="btn-primary w-full sm:w-auto sm:min-w-64" onClick={() => setStep("details")}>
                    Continue <ArrowRight className="size-4" />
                  </button>
                )}
              </div>
            )}
            {!selectedSlot && submitError && (
              <p className="flex items-start gap-2 text-sm text-red-600 md:col-span-2" role="alert"><Alert className="mt-0.5 size-4 shrink-0" />{submitError}</p>
            )}
          </div>
        )}

        {step === "details" && selectedSlot && (
          <form onSubmit={submitBooking} className="max-w-xl space-y-5" noValidate>
            <button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-full pr-3 text-sm font-semibold text-gold-200 transition-colors hover:text-gold-100" onClick={() => setStep("pick")}>
              <ArrowLeft className="size-4" /> Change time
            </button>
            <h2 className="text-fluid-xl font-medium tracking-[-0.04em]">Your details</h2>

            {errorFields.length > 0 && (
              <div ref={summaryRef} tabIndex={-1} role="alert" className="rounded-[var(--radius-card)] border border-red-200 bg-red-50 p-4 text-sm text-red-700 outline-none focus-visible:ring-2 focus-visible:ring-red-600">
                <p className="flex items-center gap-2 font-semibold"><Alert className="size-4" />Check {errorFields.length === 1 ? "this field" : "these fields"} to continue</p>
                <ul className="mt-2 list-inside list-disc">
                  {errorFields.map((k) => (
                    <li key={k}><a href={`#${k}`} className="font-semibold underline underline-offset-2">{FIELD_LABELS[k]}</a></li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <label htmlFor="name" className="label">Full name</label>
              <input id="name" className="input" autoComplete="name" required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-invalid={!!fieldErrors.name} aria-describedby={fieldErrors.name ? "name-error" : undefined} />
              <FieldError id="name-error" message={fieldErrors.name} />
            </div>
            <div>
              <label htmlFor="email" className="label">Email</label>
              <input id="email" type="email" className="input" autoComplete="email" required maxLength={254} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-invalid={!!fieldErrors.email} aria-describedby={fieldErrors.email ? "email-error" : undefined} />
              <FieldError id="email-error" message={fieldErrors.email} />
            </div>
            <div>
              <label htmlFor="phone" className="label">Phone <span className="font-normal text-slate-500">(for SMS / WhatsApp reminders)</span></label>
              <input id="phone" type="tel" className="input" autoComplete="tel" placeholder="+91 98765 43210" maxLength={30} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} aria-invalid={!!fieldErrors.phone} aria-describedby={fieldErrors.phone ? "phone-error" : undefined} />
              <FieldError id="phone-error" message={fieldErrors.phone} />
            </div>
            <div>
              <label htmlFor="notes" className="label">Anything we should know? <span className="font-normal text-slate-500">(optional)</span></label>
              <textarea id="notes" className="input min-h-28" maxLength={1000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            {/* Honeypot: hidden from people, irresistible to form-filling bots. */}
            <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
              <label>Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></label>
            </div>

            {submitError && errorFields.length === 0 && (
              <p className="flex items-start gap-2 text-sm text-red-600" role="alert"><Alert className="mt-0.5 size-4 shrink-0" />{submitError}</p>
            )}
            <button type="submit" className="btn-primary w-full" disabled={submitting}>
              {submitting ? <><Spinner className="size-4" />Booking…</> : service.depositLabel ? <>Continue to pay {service.depositLabel} deposit</> : "Confirm booking"}
            </button>
            <p className="flex items-center justify-center gap-2 text-center text-sm text-slate-500">
              <Lock className="size-4" /> You&apos;ll get a link to cancel or reschedule.
            </p>
          </form>
        )}
      </section>
    </div>
  );
}
