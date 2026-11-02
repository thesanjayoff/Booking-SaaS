/**
 * Two-way Google Calendar sync.
 *
 *  App -> Google  `pushBookingToGoogle`: idempotent "make Google match this booking" (create / patch /
 *                 delete). Event ids are DERIVED from the booking id, so a retried job can never create
 *                 a duplicate; a 409 on insert just means "already there", and we patch instead.
 *  Google -> App  `syncFromGoogle`: incremental (syncToken) pull.
 *                   - the owner's other events become `external_busy` and block slots
 *                   - an app-created event deleted in Google cancels the booking
 *                   - an app-created event moved in Google reschedules the booking (or, if the new
 *                     time is not allowed, is moved back)
 */
import { DateTime } from "luxon";
import { all, get, run, type Db } from "../db";
import { getBooking, cancelBooking, rescheduleBooking, queueCalendarSync, SlotUnavailableError, type Booking } from "../bookings";
import { getServiceById } from "../services";
import { getSettings } from "../settings";
import { manageUrl } from "../tokens";
import { accessToken, getAccount, isConnected, GoogleAuthError } from "./oauth";

const API = "https://www.googleapis.com/calendar/v3";

export class GoogleApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function g(db: Db, path: string, init: RequestInit = {}, now = Date.now()): Promise<any> {
  const token = await accessToken(db, now);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new GoogleApiError(res.status, data?.error?.message ?? `Google Calendar HTTP ${res.status}`);
  return data;
}

/** Deterministic Google event id (base32hex alphabet allows 0-9a-v; hex digits are a subset). */
export const eventIdFor = (bookingId: string) => `bk${Buffer.from(bookingId).toString("hex")}`;
export const bookingIdFromEvent = (ev: any): string | null => ev?.extendedProperties?.private?.bookingId ?? null;

const calId = (db: Db) => encodeURIComponent(getAccount(db)?.calendarId ?? "primary");

function eventBody(b: Booking, tz: string, businessName: string) {
  return {
    summary: `${b.serviceName} – ${b.name}`,
    description: [`${b.serviceName} at ${businessName}`, `${b.name} <${b.email}>${b.phone ? ` · ${b.phone}` : ""}`, b.notes ? `Notes: ${b.notes}` : "", `Manage: ${manageUrl(b.id)}`].filter(Boolean).join("\n"),
    location: b.location || undefined,
    start: { dateTime: new Date(b.startAt).toISOString(), timeZone: tz },
    end: { dateTime: new Date(b.endAt).toISOString(), timeZone: tz },
    extendedProperties: { private: { bookingId: b.id } },
    reminders: { useDefault: true },
  };
}

/* ------------------------------------------------------------------ app -> Google */

export async function pushBookingToGoogle(bookingId: string, db: Db): Promise<void> {
  if (!isConnected(db)) return;
  const b = getBooking(bookingId, db);
  if (!b) return;
  const cal = calId(db);
  const id = eventIdFor(b.id);

  if (b.status === "cancelled" || b.status === "pending_payment") {
    if (!b.googleEventId) return;
    try {
      await g(db, `/calendars/${cal}/events/${id}?sendUpdates=none`, { method: "DELETE" });
    } catch (e) {
      if (!(e instanceof GoogleApiError && (e.status === 404 || e.status === 410))) throw e;
    }
    run(db, "UPDATE bookings SET google_event_id = NULL WHERE id = ?", b.id);
    return;
  }

  const settings = getSettings(db);
  const service = getServiceById(b.serviceId, db);
  const body: Record<string, unknown> = eventBody(b, settings.timezone, settings.businessName);
  const wantMeet = !!service?.createMeet && !b.meetUrl;
  if (wantMeet) body.conferenceData = { createRequest: { requestId: `meet-${b.id}`, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  const q = `conferenceDataVersion=1&sendUpdates=none`;

  let ev: any;
  try {
    ev = await g(db, `/calendars/${cal}/events?${q}`, { method: "POST", body: JSON.stringify({ ...body, id }) });
  } catch (e) {
    if (!(e instanceof GoogleApiError && e.status === 409)) throw e;
    // Already created (earlier attempt, or a previous push): bring it up to date instead.
    ev = await g(db, `/calendars/${cal}/events/${id}?${q}`, { method: "PATCH", body: JSON.stringify(body) });
  }
  const meet = ev?.hangoutLink ?? ev?.conferenceData?.entryPoints?.find((p: any) => p.entryPointType === "video")?.uri ?? null;
  run(db, "UPDATE bookings SET google_event_id = ?, meet_url = COALESCE(?, meet_url) WHERE id = ?", ev?.id ?? id, meet, b.id);
}

/* ------------------------------------------------------------------ Google -> app */

function eventRange(ev: any, tz: string): { start: number; end: number } | null {
  if (ev.start?.dateTime && ev.end?.dateTime) return { start: Date.parse(ev.start.dateTime), end: Date.parse(ev.end.dateTime) };
  if (ev.start?.date && ev.end?.date) {
    // All-day: [date, end-date) in the business time zone.
    return {
      start: DateTime.fromISO(ev.start.date, { zone: tz }).startOf("day").toMillis(),
      end: DateTime.fromISO(ev.end.date, { zone: tz }).startOf("day").toMillis(),
    };
  }
  return null;
}

/** Does this foreign event make the owner busy? */
function blocks(ev: any): boolean {
  if (ev.status === "cancelled") return false;
  if (ev.transparency === "transparent") return false; // marked "Free"
  const me = (ev.attendees ?? []).find((a: any) => a.self);
  if (me?.responseStatus === "declined") return false;
  return true;
}

export async function syncFromGoogle(db: Db, now = Date.now()): Promise<{ changed: number }> {
  const account = getAccount(db);
  if (!account) return { changed: 0 };
  const tz = getSettings(db).timezone;
  const cal = calId(db);
  let changed = 0;
  let syncToken = account.syncToken;

  for (let attempt = 0; attempt < 2; attempt++) {
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    try {
      do {
        const q = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "250" });
        if (syncToken) q.set("syncToken", syncToken);
        else {
          q.set("timeMin", new Date(now - 86_400_000).toISOString());
          q.set("timeMax", new Date(now + 400 * 86_400_000).toISOString());
        }
        if (pageToken) q.set("pageToken", pageToken);
        const page = await g(db, `/calendars/${cal}/events?${q}`, {}, now);
        for (const ev of page.items ?? []) changed += applyEvent(db, ev, tz, now) ? 1 : 0;
        pageToken = page.nextPageToken;
        nextSyncToken = page.nextSyncToken ?? nextSyncToken;
      } while (pageToken);
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 410 && syncToken) {
        // Sync token expired: forget everything we mirrored and start over.
        run(db, "DELETE FROM external_busy");
        syncToken = null;
        continue;
      }
      throw e;
    }
    run(db, "UPDATE google_account SET sync_token = ?, last_synced_at = ? WHERE id = 1", nextSyncToken ?? syncToken, now);
    return { changed };
  }
  throw new GoogleApiError(410, "Google sync could not recover from an expired sync token");
}

function applyEvent(db: Db, ev: any, tz: string, now: number): boolean {
  const bookingId = bookingIdFromEvent(ev);

  if (bookingId) {
    const b = getBooking(bookingId, db);
    if (!b || (b.googleEventId && b.googleEventId !== ev.id)) return false;
    const active = b.status === "confirmed";
    if (ev.status === "cancelled") {
      if (active) {
        cancelBooking(b.id, { by: "google", reason: "Removed from the clinic calendar", db, now });
        return true;
      }
      return false;
    }
    const range = eventRange(ev, tz);
    if (!active || !range || range.start === b.startAt) return false;
    try {
      rescheduleBooking(b.id, range.start, { by: "owner", db, now });
      return true;
    } catch (e) {
      if (e instanceof SlotUnavailableError) {
        // The owner dragged it somewhere that is not allowed (taken / outside hours): put it back.
        queueCalendarSync(db, b.id, now);
        return false;
      }
      throw e;
    }
  }

  // A foreign event.
  if (!blocks(ev)) {
    return Number(run(db, "DELETE FROM external_busy WHERE event_id = ?", ev.id).changes) > 0;
  }
  const range = eventRange(ev, tz);
  if (!range || range.end <= range.start) return false;
  run(
    db,
    `INSERT INTO external_busy (event_id, start_at, end_at, summary, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(event_id) DO UPDATE SET start_at = excluded.start_at, end_at = excluded.end_at, summary = excluded.summary, updated_at = excluded.updated_at`,
    ev.id, range.start, range.end, String(ev.summary ?? "").slice(0, 200), now,
  );
  return true;
}

export const googleStatus = (db: Db) => {
  const a = getAccount(db);
  return a ? { ...a, mirroredEvents: get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM external_busy")!.n, linkedBookings: all(db, "SELECT 1 FROM bookings WHERE google_event_id IS NOT NULL").length } : null;
};

export { GoogleAuthError };
