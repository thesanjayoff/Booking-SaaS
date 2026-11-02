import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, seedBasic } from "./helpers";
import { all, get, run } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { createBooking, cancelBooking, rescheduleBooking, getBooking, SlotUnavailableError } from "@/lib/bookings";
import { createService, type Service } from "@/lib/services";
import { getSlots } from "@/lib/availability/store";
import { buildAuthUrl, connectWithCode, accessToken, disconnect, getAccount } from "@/lib/google/oauth";
import { eventIdFor, pushBookingToGoogle, syncFromGoogle } from "@/lib/google/sync";
import { decrypt } from "@/lib/tokens";
import { drain } from "@/lib/queue";
import { registerAllHandlers } from "@/lib/jobs";
import { setAdapter, type Adapter, type Outgoing } from "@/lib/notify/adapters";

const MIN = 60_000;
const NOW = Date.parse("2030-05-27T08:00:00Z");
const at = (hhmm: string, date = "2030-06-03") => Date.parse(`${date}T${hhmm}:00Z`);

/* ------------------------------------------------------------------ fake Google */
type Ev = Record<string, any> & { id: string; _v: number };
class FakeGoogle {
  events = new Map<string, Ev>();
  counter = 0;
  tokenCalls: string[] = [];
  revoked = 0;
  expireSyncToken = false;
  listCalls: URLSearchParams[] = [];
  authCodeIssued = 0;

  private touch(ev: Ev) {
    ev._v = ++this.counter;
    return ev;
  }
  addForeign(ev: Record<string, any>) {
    const e = { status: "confirmed", ...ev } as Ev;
    this.events.set(e.id, this.touch(e));
    return e;
  }
  deleteInGoogle(id: string) {
    const e = this.events.get(id)!;
    e.status = "cancelled";
    this.touch(e);
  }
  moveInGoogle(id: string, startIso: string, endIso: string) {
    const e = this.events.get(id)!;
    e.start = { dateTime: startIso };
    e.end = { dateTime: endIso };
    this.touch(e);
  }

  handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const body = init?.body && typeof init.body === "string" && init.headers && JSON.stringify(init.headers).includes("json") ? JSON.parse(init.body) : init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init?.body ? JSON.parse(String(init.body)) : {};

    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/revoke") {
      this.revoked++;
      return json({});
    }
    if (url.hostname === "oauth2.googleapis.com") {
      this.tokenCalls.push(body.grant_type);
      if (body.grant_type === "authorization_code") {
        this.authCodeIssued++;
        const claims = Buffer.from(JSON.stringify({ email: "owner@clinic.test" })).toString("base64url");
        return json({ access_token: "at-1", expires_in: 3600, refresh_token: "rt-secret-value", id_token: `x.${claims}.y` });
      }
      return json({ access_token: `at-${this.tokenCalls.length}`, expires_in: 3600 });
    }

    const m = /^\/calendar\/v3\/calendars\/[^/]+\/events(?:\/([^/?]+))?$/.exec(url.pathname);
    if (!m) return json({ error: { message: "bad path" } }, 404);
    const id = m[1];

    if (method === "POST" && !id) {
      if (this.events.has(body.id)) return json({ error: { message: "duplicate" } }, 409);
      const ev = { ...body, status: "confirmed" } as Ev;
      if (body.conferenceData?.createRequest) {
        ev.hangoutLink = "https://meet.google.com/abc-defg-hij";
        ev.conferenceData = { createRequest: body.conferenceData.createRequest, entryPoints: [{ entryPointType: "video", uri: ev.hangoutLink }] };
      }
      this.events.set(ev.id, this.touch(ev));
      return json(ev, 200);
    }
    if (method === "PATCH" && id) {
      const e = this.events.get(id);
      if (!e) return json({ error: { message: "not found" } }, 404);
      Object.assign(e, body);
      this.touch(e);
      return json(e);
    }
    if (method === "DELETE" && id) {
      const e = this.events.get(id);
      if (!e || e.status === "cancelled") return json({ error: { message: "gone" } }, e ? 410 : 404);
      e.status = "cancelled";
      this.touch(e);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && !id) {
      this.listCalls.push(url.searchParams);
      const tok = url.searchParams.get("syncToken");
      if (tok && this.expireSyncToken) {
        this.expireSyncToken = false;
        return json({ error: { message: "Sync token is no longer valid" } }, 410);
      }
      const since = tok ? Number(tok.replace("v", "")) : -1;
      const items = [...this.events.values()].filter((e) => e._v > since && (tok || e.status !== "cancelled"));
      return json({ items, nextSyncToken: `v${this.counter}` });
    }
    return json({ error: { message: "unhandled" } }, 500);
  };
}

/* ------------------------------------------------------------------ setup */
const t = makeTestDb("google");
const G = new FakeGoogle();
const mails: Outgoing[] = [];
let svc: Service;
let meetSvc: Service;
let n = 0;
const env0 = { ...process.env };

const book = (start: number, service = svc) =>
  createBooking({ serviceId: service.id, startAt: start, name: "Gina Park", email: `gina${++n}@example.com`, timezone: "UTC" }, { db: t.db, now: NOW, paymentsEnabled: false }).booking;
const slots = (date = "2030-06-03") => getSlots(svc.id, { from: at("00:00", date), to: at("00:00", date) + 24 * 60 * MIN }, { db: t.db, now: NOW }).map((ms) => new Date(ms).toISOString().slice(11, 16));
const rows = (sql: string, ...p: any[]) => all<any>(t.db, sql, ...p);

beforeAll(async () => {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", APP_URL: "http://localhost:3000" });
  resetEnvCache();
  seedBasic(t.db, { settings: { maxAdvanceDays: 3650, ownerEmail: "", reminderChannels: [] } });
  svc = createService({ name: "Check-up", slug: "checkup", durationMin: 30, priceMinor: 0 }, t.db);
  meetSvc = createService({ name: "Video visit", slug: "video", durationMin: 30, priceMinor: 0, createMeet: true }, t.db);
  registerAllHandlers();
  const mailer: Adapter = { channel: "email", configured: () => true, send: async (m) => (mails.push(m), { providerId: "m" }) };
  setAdapter("email", mailer);
});
beforeEach(async () => {
  vi.stubGlobal("fetch", G.handler);
  G.events.clear();
  G.counter = 0;
  G.tokenCalls = [];
  G.listCalls = [];
  mails.length = 0;
  run(t.db, "DELETE FROM bookings");
  run(t.db, "DELETE FROM jobs");
  run(t.db, "DELETE FROM external_busy");
  run(t.db, "DELETE FROM google_account");
  await connectWithCode(t.db, "auth-code", NOW);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  setAdapter("email", undefined);
  for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "APP_URL"]) env0[k] === undefined ? delete process.env[k] : (process.env[k] = env0[k]);
  resetEnvCache();
  t.cleanup();
});

/* ------------------------------------------------------------------ tests */
describe("OAuth", () => {
  it("asks for offline access with the minimal calendar scope and a CSRF state", () => {
    const u = new URL(buildAuthUrl("state123"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("state")).toBe("state123");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/google/callback");
    expect(u.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(u.searchParams.get("scope")).not.toContain("auth/calendar ");
  });

  it("stores tokens encrypted at rest and refreshes an expired access token", async () => {
    const raw = get<any>(t.db, "SELECT * FROM google_account WHERE id = 1")!;
    expect(raw.email).toBe("owner@clinic.test");
    expect(JSON.stringify(raw)).not.toContain("rt-secret-value");
    expect(JSON.stringify(raw)).not.toContain("at-1");
    expect(decrypt(raw.refresh_token_enc)).toBe("rt-secret-value");

    expect(await accessToken(t.db, NOW + 10 * MIN)).toBe("at-1"); // still valid
    const fresh = await accessToken(t.db, NOW + 2 * 60 * MIN); // expired -> refresh
    expect(fresh).not.toBe("at-1");
    expect(G.tokenCalls.at(-1)).toBe("refresh_token");
  });

  it("disconnect revokes at Google and wipes local mirrors", async () => {
    G.addForeign({ id: "f1", summary: "Busy", start: { dateTime: "2030-06-03T10:00:00Z" }, end: { dateTime: "2030-06-03T11:00:00Z" } });
    await syncFromGoogle(t.db, NOW);
    expect(rows("SELECT * FROM external_busy")).toHaveLength(1);
    await disconnect(t.db);
    expect(G.revoked).toBe(1);
    expect(getAccount(t.db)).toBeNull();
    expect(rows("SELECT * FROM external_busy")).toHaveLength(0);
  });
});

describe("app -> Google", () => {
  it("creates a calendar event with a derived id and the booking id in private properties", async () => {
    const b = book(at("10:00"));
    await pushBookingToGoogle(b.id, t.db);
    const ev = G.events.get(eventIdFor(b.id))!;
    expect(ev).toBeTruthy();
    expect(ev.extendedProperties.private.bookingId).toBe(b.id);
    expect(ev.start.dateTime).toBe("2030-06-03T10:00:00.000Z");
    expect(ev.end.dateTime).toBe("2030-06-03T10:30:00.000Z");
    expect(ev.conferenceData?.createRequest).toBeUndefined();
    expect(getBooking(b.id, t.db)!.googleEventId).toBe(eventIdFor(b.id));
  });

  it("adds a Meet link only for services that ask for one, and saves it on the booking", async () => {
    const b = book(at("11:00"), meetSvc);
    await pushBookingToGoogle(b.id, t.db);
    const ev = G.events.get(eventIdFor(b.id))!;
    expect(ev.conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
    expect(getBooking(b.id, t.db)!.meetUrl).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("is idempotent: pushing the same booking twice (retried job) yields one event", async () => {
    const b = book(at("10:00"));
    await pushBookingToGoogle(b.id, t.db);
    await pushBookingToGoogle(b.id, t.db);
    expect([...G.events.values()].filter((e) => e.status !== "cancelled")).toHaveLength(1);
  });

  it("moves the event on reschedule and deletes it on cancel", async () => {
    const b = book(at("10:00"));
    await pushBookingToGoogle(b.id, t.db);
    rescheduleBooking(b.id, at("14:00"), { by: "owner", db: t.db, now: NOW });
    await pushBookingToGoogle(b.id, t.db);
    expect(G.events.get(eventIdFor(b.id))!.start.dateTime).toBe("2030-06-03T14:00:00.000Z");
    cancelBooking(b.id, { by: "customer", db: t.db, now: NOW });
    await pushBookingToGoogle(b.id, t.db);
    expect(G.events.get(eventIdFor(b.id))!.status).toBe("cancelled");
    expect(getBooking(b.id, t.db)!.googleEventId).toBeNull();
  });

  it("runs end to end through the queue, and the confirmation email waits for the Meet link", async () => {
    const b = book(at("09:00"), meetSvc);
    await drain(t.db, NOW); // notify throws (no meet yet), gcal.push creates the event + link
    expect(G.events.has(eventIdFor(b.id))).toBe(true);
    expect(mails.filter((m) => m.to === b.email)).toHaveLength(0);
    await drain(t.db, NOW + 2 * MIN); // retry after backoff
    const confirmation = mails.find((m) => m.to === b.email)!;
    expect(confirmation.text).toContain("https://meet.google.com/abc-defg-hij");
  });
});

describe("Google -> app", () => {
  it("other events block slots until they are removed", async () => {
    expect(slots()).toContain("10:00");
    const ev = G.addForeign({ id: "dentist", summary: "Dentist", start: { dateTime: "2030-06-03T10:00:00Z" }, end: { dateTime: "2030-06-03T11:00:00Z" } });
    expect((await syncFromGoogle(t.db, NOW)).changed).toBe(1);
    expect(slots()).not.toContain("10:00");
    expect(slots()).not.toContain("10:30");
    expect(slots()).toContain("11:00");
    expect(() => book(at("10:30"))).toThrow(SlotUnavailableError);

    G.deleteInGoogle(ev.id);
    await syncFromGoogle(t.db, NOW);
    expect(slots()).toContain("10:00");
    expect(() => book(at("10:30"))).not.toThrow();
  });

  it("ignores events marked Free, declined invitations and cancelled events", async () => {
    G.addForeign({ id: "free", transparency: "transparent", start: { dateTime: "2030-06-03T09:00:00Z" }, end: { dateTime: "2030-06-03T10:00:00Z" } });
    G.addForeign({ id: "declined", attendees: [{ self: true, responseStatus: "declined" }], start: { dateTime: "2030-06-03T10:00:00Z" }, end: { dateTime: "2030-06-03T11:00:00Z" } });
    G.addForeign({ id: "gone", status: "cancelled", start: { dateTime: "2030-06-03T11:00:00Z" }, end: { dateTime: "2030-06-03T12:00:00Z" } });
    await syncFromGoogle(t.db, NOW);
    expect(rows("SELECT * FROM external_busy")).toHaveLength(0);
    expect(slots()).toHaveLength(16);
  });

  it("an all-day event blocks the whole day in the business time zone", async () => {
    G.addForeign({ id: "ooo", summary: "Out of office", start: { date: "2030-06-04" }, end: { date: "2030-06-05" } });
    await syncFromGoogle(t.db, NOW);
    expect(slots("2030-06-04")).toEqual([]);
    expect(slots("2030-06-05")).toHaveLength(16);
  });

  it("deleting a booking's event in Google cancels the booking and frees the slot", async () => {
    const b = book(at("10:00"));
    await pushBookingToGoogle(b.id, t.db);
    await syncFromGoogle(t.db, NOW); // initial: sees our own event, must change nothing
    expect(getBooking(b.id, t.db)!.status).toBe("confirmed");

    G.deleteInGoogle(eventIdFor(b.id));
    await syncFromGoogle(t.db, NOW);
    expect(getBooking(b.id, t.db)).toMatchObject({ status: "cancelled", cancelledBy: "google" });
    expect(() => book(at("10:00"))).not.toThrow();
    expect(rows("SELECT id FROM jobs WHERE dedupe_key = ?", `notify:cancelled:${b.id}`)).toHaveLength(1); // customer is told
  });

  it("moving a booking's event in Google reschedules the booking (when the new time is allowed)", async () => {
    const b = book(at("10:00"));
    await pushBookingToGoogle(b.id, t.db);
    await syncFromGoogle(t.db, NOW);
    G.moveInGoogle(eventIdFor(b.id), "2030-06-03T15:00:00.000Z", "2030-06-03T15:30:00.000Z");
    expect((await syncFromGoogle(t.db, NOW)).changed).toBe(1);
    expect(getBooking(b.id, t.db)).toMatchObject({ startAt: at("15:00"), rescheduleCount: 1 });
    expect(rows("SELECT id FROM jobs WHERE dedupe_key = ?", `notify:rescheduled:${b.id}:1`)).toHaveLength(1);
  });

  it("moving it somewhere NOT allowed (taken / outside hours) leaves the booking alone and queues a revert", async () => {
    const b = book(at("10:00"));
    book(at("15:00"));
    await pushBookingToGoogle(b.id, t.db);
    await syncFromGoogle(t.db, NOW);
    run(t.db, "DELETE FROM jobs");
    G.moveInGoogle(eventIdFor(b.id), "2030-06-03T15:00:00.000Z", "2030-06-03T15:30:00.000Z"); // taken
    await syncFromGoogle(t.db, NOW);
    expect(getBooking(b.id, t.db)!.startAt).toBe(at("10:00"));
    expect(rows("SELECT * FROM jobs WHERE type = 'gcal.push'").length).toBeGreaterThan(0);
    await drain(t.db, NOW);
    expect(G.events.get(eventIdFor(b.id))!.start.dateTime).toBe("2030-06-03T10:00:00.000Z"); // reverted in Google

    G.moveInGoogle(eventIdFor(b.id), "2030-06-03T22:00:00.000Z", "2030-06-03T22:30:00.000Z"); // after hours
    await syncFromGoogle(t.db, NOW);
    expect(getBooking(b.id, t.db)!.startAt).toBe(at("10:00"));
  });

  it("does not echo: our own pushes coming back in the next sync change nothing", async () => {
    const b = book(at("10:00"));
    await syncFromGoogle(t.db, NOW);
    await pushBookingToGoogle(b.id, t.db);
    expect((await syncFromGoogle(t.db, NOW)).changed).toBe(0);
    expect((await syncFromGoogle(t.db, NOW)).changed).toBe(0);
  });

  it("syncs incrementally with the sync token, and fully resyncs if Google expires it (410)", async () => {
    G.addForeign({ id: "a", start: { dateTime: "2030-06-03T09:00:00Z" }, end: { dateTime: "2030-06-03T09:30:00Z" } });
    await syncFromGoogle(t.db, NOW);
    expect(G.listCalls[0].get("syncToken")).toBeNull();
    expect(G.listCalls[0].get("timeMin")).toBeTruthy();

    G.addForeign({ id: "b", start: { dateTime: "2030-06-03T12:00:00Z" }, end: { dateTime: "2030-06-03T12:30:00Z" } });
    expect((await syncFromGoogle(t.db, NOW)).changed).toBe(1); // only the delta
    expect(G.listCalls.at(-1)!.get("syncToken")).toMatch(/^v\d+$/);
    expect(rows("SELECT * FROM external_busy")).toHaveLength(2);

    G.expireSyncToken = true;
    await syncFromGoogle(t.db, NOW);
    expect(G.listCalls.at(-1)!.get("syncToken")).toBeNull(); // restarted from scratch
    expect(rows("SELECT * FROM external_busy")).toHaveLength(2); // rebuilt
  });
});

describe("when not connected", () => {
  it("push and sync are harmless no-ops", async () => {
    run(t.db, "DELETE FROM google_account");
    const b = book(at("10:00"));
    await expect(pushBookingToGoogle(b.id, t.db)).resolves.toBeUndefined();
    await expect(syncFromGoogle(t.db, NOW)).resolves.toEqual({ changed: 0 });
    expect(G.events.size).toBe(0);
  });
});
