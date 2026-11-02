"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { login, logout, requireAdmin } from "@/lib/auth";
import { clientIdFromHeaders } from "@/lib/ratelimit";
import { getDb, run, get } from "@/lib/db";
import { SlotUnavailableError, cancelBooking, setOutcome, rescheduleBooking } from "@/lib/bookings";
import { createService, deleteOrArchiveService, SlugTakenError, updateService } from "@/lib/services";
import { getSettings, saveSettings, settingsSchema } from "@/lib/settings";
import { addException, addRule, deleteException, deleteRule, replaceDayRules } from "@/lib/availability/store";
import { enqueue } from "@/lib/queue";
import { disconnect } from "@/lib/google/oauth";
import { syncFromGoogle } from "@/lib/google/sync";
import { DateTime } from "luxon";

/* ---------------------------------------------------------------- helpers */

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const has = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true" || fd.get(k) === "1";
const num = (fd: FormData, k: string, d = 0) => {
  const v = Number(str(fd, k));
  return Number.isFinite(v) ? v : d;
};
/** "14:30" -> 870 */
function toMinutes(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins <= 1440 ? mins : null;
}
/** "600.50" -> 60050 (minor units) */
const toMinor = (v: string) => Math.round(Number(v.replace(/,/g, "") || "0") * 100);

function message(e: unknown): string {
  if (e instanceof ZodError) return e.issues[0]?.message ?? "Invalid input";
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

/** Only allow same-site /admin return paths (no open redirects). */
function safeReturn(fd: FormData, fallback: string): string {
  const r = str(fd, "returnTo");
  return /^\/admin(\/[a-z0-9-]*)?(\?[A-Za-z0-9=&_%.:-]*)?$/i.test(r) ? r : fallback;
}

function back(path: string, kind: "ok" | "error", text: string): never {
  const [base, query = ""] = path.split("?");
  const qs = new URLSearchParams(query);
  qs.delete("ok");
  qs.delete("error");
  qs.set(kind, text);
  redirect(`${base}?${qs}`);
}

/* ---------------------------------------------------------------- auth */

export async function loginAction(fd: FormData) {
  const h = await headers();
  const res = await login(String(fd.get("password") ?? ""), clientIdFromHeaders(h));
  if (!res.ok) redirect(`/admin/login?error=${encodeURIComponent(res.error)}`);
  redirect("/admin");
}

export async function logoutAction() {
  await logout();
  redirect("/admin/login");
}

/* ---------------------------------------------------------------- bookings */

export async function cancelBookingAction(fd: FormData) {
  await requireAdmin();
  const to = safeReturn(fd, "/admin");
  try {
    cancelBooking(str(fd, "id"), { by: "owner", reason: str(fd, "reason") || "Cancelled by the clinic" });
  } catch (e) {
    back(to, "error", message(e));
  }
  revalidatePath("/admin", "layout");
  back(to, "ok", "Booking cancelled. The customer has been notified.");
}

export async function outcomeAction(fd: FormData) {
  await requireAdmin();
  const to = safeReturn(fd, "/admin");
  const status = str(fd, "status");
  if (status !== "completed" && status !== "no_show" && status !== "confirmed") back(to, "error", "Unknown status");
  try {
    setOutcome(str(fd, "id"), status as "completed" | "no_show" | "confirmed");
  } catch (e) {
    back(to, "error", message(e));
  }
  revalidatePath("/admin", "layout");
  back(to, "ok", "Booking updated.");
}

export async function rescheduleAction(fd: FormData) {
  await requireAdmin();
  const to = safeReturn(fd, "/admin/bookings");
  try {
    const settings = getSettings();
    const local = DateTime.fromISO(str(fd, "when"), { zone: settings.timezone });
    if (!local.isValid) throw new Error("Pick a valid date and time.");
    rescheduleBooking(str(fd, "id"), local.toMillis(), { by: "owner" });
  } catch (e) {
    if (e instanceof SlotUnavailableError) back(to, "error", "That time is not available (outside hours, on a break or already booked).");
    back(to, "error", message(e));
  }
  revalidatePath("/admin", "layout");
  back(to, "ok", "Booking moved. The customer has been notified.");
}

export async function retryRefundAction(fd: FormData) {
  await requireAdmin();
  const to = safeReturn(fd, "/admin");
  const id = str(fd, "id");
  const b = get<{ payment_status: string }>(getDb(), "SELECT payment_status FROM bookings WHERE id = ?", id);
  if (b?.payment_status !== "refund_needed") back(to, "error", "No refund is pending for that booking.");
  enqueue(getDb(), { type: "refund", payload: { bookingId: id }, dedupeKey: `refund:${id}:manual:${Date.now()}`, maxAttempts: 8 });
  back(to, "ok", "Refund queued.");
}

/* ---------------------------------------------------------------- services */

function serviceFromForm(fd: FormData) {
  return {
    name: str(fd, "name"),
    slug: str(fd, "slug"),
    description: str(fd, "description"),
    durationMin: num(fd, "durationMin"),
    priceMinor: toMinor(str(fd, "price")),
    currency: str(fd, "currency") || "INR",
    bufferBeforeMin: num(fd, "bufferBeforeMin"),
    bufferAfterMin: num(fd, "bufferAfterMin"),
    depositMinor: toMinor(str(fd, "deposit")),
    slotIntervalMin: str(fd, "slotIntervalMin") ? num(fd, "slotIntervalMin") : null,
    createMeet: has(fd, "createMeet"),
    location: str(fd, "location"),
    active: has(fd, "active"),
    sortOrder: num(fd, "sortOrder"),
  };
}

export async function saveServiceAction(fd: FormData) {
  await requireAdmin();
  const id = str(fd, "id");
  try {
    if (id) updateService(id, serviceFromForm(fd));
    else createService(serviceFromForm(fd));
  } catch (e) {
    back("/admin/services", "error", e instanceof SlugTakenError ? e.message : message(e));
  }
  revalidatePath("/", "layout");
  back("/admin/services", "ok", id ? "Service saved." : "Service created.");
}

export async function deleteServiceAction(fd: FormData) {
  await requireAdmin();
  const result = deleteOrArchiveService(str(fd, "id"));
  revalidatePath("/", "layout");
  back("/admin/services", "ok", result === "deleted" ? "Service deleted." : "Service has bookings, so it was hidden (archived) instead of deleted.");
}

/* ---------------------------------------------------------------- availability */

export async function saveHoursAction(fd: FormData) {
  await requireAdmin();
  try {
    for (let day = 1; day <= 7; day++) {
      const ranges: { startMin: number; endMin: number; kind: "work" | "break" }[] = [];
      for (const [prefix, kind, count] of [["w", "work", 3], ["b", "break", 2]] as const) {
        for (let i = 0; i < count; i++) {
          const s = toMinutes(str(fd, `${prefix}${day}_${i}_s`));
          const e = toMinutes(str(fd, `${prefix}${day}_${i}_e`));
          if (s == null && e == null) continue;
          if (s == null || e == null) throw new Error("Fill in both a start and an end time (or clear both).");
          if (e <= s) throw new Error("An end time must be after its start time.");
          ranges.push({ startMin: s, endMin: e, kind });
        }
      }
      replaceDayRules(day, ranges);
    }
  } catch (e) {
    back("/admin/availability", "error", message(e));
  }
  back("/admin/availability", "ok", "Weekly hours saved.");
}

export async function addExceptionAction(fd: FormData) {
  await requireAdmin();
  try {
    const from = DateTime.fromISO(str(fd, "from"));
    const to = str(fd, "to") ? DateTime.fromISO(str(fd, "to")) : from;
    if (!from.isValid || !to.isValid || to < from) throw new Error("Choose a valid date range.");
    if (to.diff(from, "days").days > 366) throw new Error("Pick a range of at most a year.");
    const kind = str(fd, "kind") === "open" ? "open" : "closed";
    const start = toMinutes(str(fd, "start"));
    const end = toMinutes(str(fd, "end"));
    if (kind === "open" && (start == null || end == null || end <= start)) throw new Error("Custom hours need a start and a later end time.");
    const yearly = has(fd, "yearly");
    for (let d = from; d <= to; d = d.plus({ days: 1 })) {
      addException({ date: d.toISODate()!, kind, startMin: kind === "open" ? start : null, endMin: kind === "open" ? end : null, label: str(fd, "label"), yearly });
    }
  } catch (e) {
    back("/admin/availability", "error", message(e));
  }
  back("/admin/availability", "ok", "Saved.");
}

export async function deleteExceptionAction(fd: FormData) {
  await requireAdmin();
  deleteException(num(fd, "id"));
  back("/admin/availability", "ok", "Removed.");
}

export async function addServiceRuleAction(fd: FormData) {
  await requireAdmin();
  try {
    const s = toMinutes(str(fd, "start"));
    const e = toMinutes(str(fd, "end"));
    if (s == null || e == null) throw new Error("Enter both times.");
    const days = fd.getAll("weekday").map((d) => Number(d));
    if (days.length === 0) throw new Error("Pick at least one weekday.");
    for (const weekday of days) addRule({ weekday, startMin: s, endMin: e, kind: "work", serviceId: str(fd, "serviceId") });
  } catch (e) {
    back("/admin/availability", "error", message(e));
  }
  back("/admin/availability", "ok", "Service hours added. This service now uses only its own hours.");
}

export async function deleteRuleAction(fd: FormData) {
  await requireAdmin();
  deleteRule(num(fd, "id"));
  back("/admin/availability", "ok", "Removed.");
}

/* ---------------------------------------------------------------- settings */

export async function saveSettingsAction(fd: FormData) {
  await requireAdmin();
  try {
    const offsets = str(fd, "reminderOffsets")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Math.round(Number(s) * 60));
    const next = settingsSchema.parse({
      businessName: str(fd, "businessName"),
      tagline: str(fd, "tagline"),
      timezone: str(fd, "timezone"),
      ownerEmail: str(fd, "ownerEmail"),
      address: str(fd, "address"),
      phone: str(fd, "phone"),
      minNoticeMin: Math.round(num(fd, "minNoticeHours") * 60),
      maxAdvanceDays: num(fd, "maxAdvanceDays"),
      slotIntervalMin: num(fd, "slotIntervalMin"),
      cancelCutoffHours: num(fd, "cancelCutoffHours"),
      holdMinutes: num(fd, "holdMinutes"),
      reminderOffsetsMin: offsets,
      reminderChannels: (["email", "sms", "whatsapp"] as const).filter((c) => has(fd, `ch_${c}`)),
    });
    saveSettings(next);
  } catch (e) {
    back("/admin/settings", "error", message(e));
  }
  revalidatePath("/", "layout");
  back("/admin/settings", "ok", "Settings saved. Reminder changes apply to new and rescheduled bookings.");
}

export async function disconnectGoogleAction() {
  await requireAdmin();
  await disconnect(getDb());
  revalidatePath("/admin", "layout");
  back("/admin/settings", "ok", "Google Calendar disconnected.");
}

export async function syncGoogleNowAction() {
  await requireAdmin();
  let n = 0;
  try {
    n = (await syncFromGoogle(getDb())).changed;
  } catch (e) {
    back("/admin/settings", "error", `Sync failed: ${message(e)}`);
  }
  revalidatePath("/admin", "layout");
  back("/admin/settings", "ok", `Synced with Google Calendar (${n} change${n === 1 ? "" : "s"}).`);
}

export async function retryFailedJobsAction() {
  await requireAdmin();
  run(getDb(), "UPDATE jobs SET status = 'queued', attempts = 0, run_at = ?, last_error = NULL WHERE status = 'failed'", Date.now());
  back("/admin/settings", "ok", "Failed jobs re-queued.");
}
