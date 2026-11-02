import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, seedBasic } from "./helpers";
import { all, get, run } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { saveSettings } from "@/lib/settings";
import { cancelBooking, createBooking, rescheduleBooking, type Booking } from "@/lib/bookings";
import { claimNext, drain, enqueue, cancelQueued, backoffMs, LEASE_MS, registerHandler } from "@/lib/queue";
import { registerAllHandlers } from "@/lib/jobs";
import { PermanentSendError, setAdapter, smsAdapter, whatsappAdapter, toE164, type Adapter, type Channel, type Outgoing } from "@/lib/notify/adapters";
import { buildMessage } from "@/lib/notify/templates";
import { getSettings } from "@/lib/settings";
import { reminderKey } from "@/lib/reminders";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2030-05-27T08:00:00Z");
const START = Date.parse("2030-06-03T10:00:00Z"); // Monday 10:00 UTC, one week ahead

const t = makeTestDb("reminders");
const sent: { channel: Channel; m: Outgoing }[] = [];
let failPlan: Record<Channel, (call: number) => Error | null> = { email: () => null, sms: () => null, whatsapp: () => null };
const calls: Record<Channel, number> = { email: 0, sms: 0, whatsapp: 0 };

const fake = (channel: Channel): Adapter => ({
  channel,
  configured: () => true,
  async send(m) {
    calls[channel]++;
    const err = failPlan[channel](calls[channel]);
    if (err) throw err;
    sent.push({ channel, m });
    return { providerId: `${channel}-${sent.length}` };
  },
});

let n = 0;
const book = (start = START, extra: Partial<{ phone: string; name: string }> = {}): Booking =>
  createBooking({ serviceId: svcId, startAt: start, name: extra.name ?? "Asha Rao", email: `asha${++n}@example.com`, phone: extra.phone ?? "+919876543210", timezone: "Asia/Kolkata" }, { db: t.db, now: NOW, paymentsEnabled: false }).booking;
let svcId = "";

const jobs = (like: string) => all<any>(t.db, "SELECT * FROM jobs WHERE dedupe_key LIKE ? ORDER BY run_at", like);
const log = (id: string) => all<any>(t.db, "SELECT kind, channel, status, error FROM notification_log WHERE booking_id = ? ORDER BY id", id);
const sentTo = (channel: Channel) => sent.filter((s) => s.channel === channel);

beforeAll(() => {
  svcId = seedBasic(t.db, { settings: { maxAdvanceDays: 3650, ownerEmail: "owner@clinic.test", reminderChannels: ["email", "sms", "whatsapp"], reminderOffsetsMin: [24 * 60, 120] } }).id;
  registerAllHandlers();
});
beforeEach(() => {
  sent.length = 0;
  failPlan = { email: () => null, sms: () => null, whatsapp: () => null };
  calls.email = calls.sms = calls.whatsapp = 0;
  for (const c of ["email", "sms", "whatsapp"] as const) setAdapter(c, fake(c));
  run(t.db, "DELETE FROM bookings");
  run(t.db, "DELETE FROM jobs");
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  for (const c of ["email", "sms", "whatsapp"] as const) setAdapter(c, undefined);
  t.cleanup();
});

describe("scheduling", () => {
  it("plans one reminder per channel per offset at the right UTC instants", () => {
    const b = book();
    const rows = jobs(`reminder:${b.id}:%`);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.run_at)).toEqual([START - 1440 * MIN, START - 1440 * MIN, START - 1440 * MIN, START - 120 * MIN, START - 120 * MIN, START - 120 * MIN]);
  });

  it("skips offsets that are already in the past (booked 1 hour ahead -> no 24h or 2h reminder)", () => {
    const late = createBooking({ serviceId: svcId, startAt: NOW + 3 * HOUR, name: "L", email: "late@example.com", timezone: "UTC" }, { db: t.db, now: NOW, paymentsEnabled: false }).booking;
    expect(jobs(`reminder:${late.id}:%`).map((r) => r.run_at)).toEqual([late.startAt - 120 * MIN, late.startAt - 120 * MIN, late.startAt - 120 * MIN]);
    const sooner = createBooking({ serviceId: svcId, startAt: NOW + 1 * HOUR + 30 * MIN, name: "S", email: "soon@example.com", timezone: "UTC" }, { db: t.db, now: NOW, paymentsEnabled: false });
    expect(jobs(`reminder:${sooner.booking.id}:%`)).toHaveLength(0);
  });

  it("enqueueing the same logical job twice is a no-op", () => {
    const b = book();
    const key = reminderKey(b.id, b.startAt, "email", 1440);
    expect(enqueue(t.db, { type: "reminder", payload: {}, dedupeKey: key })).toBe(false);
    expect(jobs(key)).toHaveLength(1);
  });
});

describe("sending", () => {
  it("sends the confirmation to the customer and the alert to the owner exactly once", async () => {
    const b = book();
    await drain(t.db, NOW + 1000);
    await drain(t.db, NOW + 2000);
    const emails = sentTo("email");
    expect(emails.map((e) => e.m.to).sort()).toEqual([b.email, "owner@clinic.test"].sort());
    const toCustomer = emails.find((e) => e.m.to === b.email)!.m;
    expect(toCustomer.subject).toMatch(/Confirmed: Consultation/);
    expect(toCustomer.ics).toContain("BEGIN:VEVENT");
    expect(toCustomer.text).toMatch(/\/booking\/.+\?t=/);
  });

  it("sends each reminder on its own channel at its own time, once", async () => {
    const b = book();
    await drain(t.db, NOW + 1000); // confirmations
    sent.length = 0;

    await drain(t.db, START - 1441 * MIN);
    expect(sent).toHaveLength(0); // too early

    await drain(t.db, START - 1440 * MIN);
    expect(sent.map((s) => s.channel).sort()).toEqual(["email", "sms", "whatsapp"]);
    expect(sentTo("sms")[0].m.to).toBe("+919876543210");
    expect(sentTo("sms")[0].m.text).toMatch(/reminder/i);
    expect(sentTo("whatsapp")[0].m.waParams).toEqual(["Asha Rao", "Consultation", "3:30 PM", "Monday, 3 June 2030"]);

    await drain(t.db, START - 1439 * MIN); // nothing new due
    expect(sent).toHaveLength(3);

    await drain(t.db, START - 120 * MIN);
    expect(sent).toHaveLength(6);
    expect(log(b.id).filter((l) => l.kind.startsWith("reminder")).every((l) => l.status === "sent")).toBe(true);
  });

  it("never double-sends even if a duplicate job for the same reminder slips into the queue", async () => {
    const b = book();
    await drain(t.db, NOW + 1000);
    sent.length = 0;
    await drain(t.db, START - 1440 * MIN);
    expect(sent).toHaveLength(3);
    // A second job (different dedupe key) for the SAME reminder: the notification ledger must stop it.
    for (const channel of ["email", "sms", "whatsapp"]) {
      enqueue(t.db, { type: "reminder", payload: { bookingId: b.id, channel, offsetMin: 1440, startAt: b.startAt }, dedupeKey: `dup:${channel}`, runAt: START - 1440 * MIN });
    }
    await drain(t.db, START - 1439 * MIN);
    expect(sent).toHaveLength(3);
  });

  it("skips SMS/WhatsApp when the customer gave no usable phone, but still sends email", async () => {
    const b = book(START, { phone: "" });
    await drain(t.db, START - 1440 * MIN);
    expect(sentTo("email").filter((e) => e.m.subject?.startsWith("Reminder"))).toHaveLength(1);
    expect(sentTo("sms")).toHaveLength(0);
    expect(log(b.id).filter((l) => l.channel === "sms").map((l) => l.status)).toEqual(["skipped"]);
  });

  it("skips channels that are not configured", async () => {
    setAdapter("sms", { channel: "sms", configured: () => false, send: async () => ({}) });
    const b = book();
    await drain(t.db, START - 1440 * MIN);
    expect(sentTo("sms")).toHaveLength(0);
    expect(log(b.id).find((l) => l.channel === "sms" && l.kind.startsWith("reminder"))).toMatchObject({ status: "skipped", error: expect.stringMatching(/not configured/) });
  });
});

describe("retries", () => {
  it("retries a transient failure with exponential backoff and then sends exactly once", async () => {
    failPlan.sms = (call) => (call <= 2 ? new Error("Twilio HTTP 503") : null);
    const b = book();
    await drain(t.db, NOW + 1000);
    const due = START - 1440 * MIN;
    await drain(t.db, due);
    const smsJob = () => jobs(`reminder:${b.id}:${START}:sms:1440`)[0];
    expect(smsJob()).toMatchObject({ status: "queued", attempts: 1 });
    expect(smsJob().last_error).toMatch(/503/);
    expect(smsJob().run_at).toBeGreaterThanOrEqual(due + backoffMs(1, 0));
    expect(smsJob().run_at).toBeLessThanOrEqual(due + backoffMs(1, 1));

    await drain(t.db, due + 10_000); // 10s later: first backoff (~30s) has not elapsed
    expect(calls.sms).toBe(1);

    const secondAt = due + 1 * MIN; // past the first backoff -> attempt 2 runs and fails again
    await drain(t.db, secondAt);
    expect(smsJob()).toMatchObject({ status: "queued", attempts: 2 });
    expect(calls.sms).toBe(2);
    expect(smsJob().run_at).toBeGreaterThanOrEqual(secondAt + backoffMs(2, 0)); // ~60s base: doubled

    await drain(t.db, secondAt + 30_000); // still inside the doubled backoff
    expect(calls.sms).toBe(2);

    await drain(t.db, secondAt + 5 * MIN); // attempt 3 succeeds
    expect(smsJob()).toMatchObject({ status: "done", attempts: 3 });
    expect(sentTo("sms")).toHaveLength(1);

    await drain(t.db, due + 24 * HOUR);
    expect(sentTo("sms")).toHaveLength(1);
    expect(log(b.id).find((l) => l.channel === "sms" && l.kind === "reminder-1440")!.status).toBe("sent");
  });

  it("gives up after max attempts and marks the job failed (visible in the admin)", async () => {
    failPlan.whatsapp = () => new Error("Graph API timeout");
    const b = book();
    let clock = START - 1440 * MIN;
    for (let i = 0; i < 8; i++) {
      await drain(t.db, clock);
      clock += 3 * HOUR;
    }
    const job = jobs(`reminder:${b.id}:${START}:whatsapp:1440`)[0];
    expect(job).toMatchObject({ status: "failed", attempts: 6 });
    expect(job.last_error).toMatch(/timeout/);
    expect(calls.whatsapp).toBeGreaterThanOrEqual(6);
  });

  it("does not retry a permanent rejection (e.g. invalid number)", async () => {
    failPlan.sms = () => new PermanentSendError("Twilio HTTP 400: invalid number");
    const b = book();
    await drain(t.db, START - 1440 * MIN);
    await drain(t.db, START - 1000 * MIN);
    expect(calls.sms).toBe(1);
    expect(jobs(`reminder:${b.id}:${START}:sms:1440`)[0].status).toBe("done");
    expect(log(b.id).find((l) => l.channel === "sms" && l.kind === "reminder-1440")).toMatchObject({ status: "failed", error: expect.stringMatching(/invalid number/) });
  });

  it("a crash between send and ledger update (ledger stuck on 'sending') is retried once, then final", async () => {
    const b = book();
    run(t.db, "INSERT INTO notification_log (booking_id, kind, channel, start_at, status, created_at, updated_at) VALUES (?, 'reminder-1440', 'email', ?, 'sending', 1, 1)", b.id, b.startAt);
    await drain(t.db, START - 1440 * MIN);
    expect(sentTo("email").filter((e) => e.m.subject?.startsWith("Reminder"))).toHaveLength(1);
    expect(get<any>(t.db, "SELECT status FROM notification_log WHERE booking_id = ? AND kind = 'reminder-1440' AND channel = 'email'", b.id)!.status).toBe("sent");
  });
});

describe("staying correct when bookings change", () => {
  it("cancelling removes pending reminders and sends only the cancellation notice", async () => {
    const b = book();
    await drain(t.db, NOW + 1000);
    sent.length = 0;
    cancelBooking(b.id, { by: "customer", reason: "Travelling", db: t.db, now: NOW + 2000 });
    expect(jobs(`reminder:${b.id}:%`).every((j) => j.status === "cancelled")).toBe(true);
    await drain(t.db, START - 1440 * MIN);
    expect(sent.map((s) => s.m.subject)).toEqual([expect.stringMatching(/^Cancelled:/), expect.stringMatching(/^Booking cancelled:/)]);
  });

  it("a stale reminder job for a cancelled booking sends nothing", async () => {
    const b = book();
    await drain(t.db, NOW + 1000);
    sent.length = 0;
    run(t.db, "UPDATE bookings SET status = 'cancelled' WHERE id = ?", b.id); // bypass cancelReminders on purpose
    await drain(t.db, START - 1440 * MIN);
    expect(sent).toHaveLength(0);
  });

  it("rescheduling re-plans reminders for the new time and never fires the old ones", async () => {
    const b = book();
    await drain(t.db, NOW + 1000);
    sent.length = 0;
    const newStart = START + 2 * 24 * HOUR;
    rescheduleBooking(b.id, newStart, { by: "customer", db: t.db, now: NOW + 5000 });

    const old = jobs(`reminder:${b.id}:${START}:%`);
    expect(old.length).toBe(6);
    expect(old.every((j) => j.status === "cancelled")).toBe(true);
    expect(jobs(`reminder:${b.id}:${newStart}:%`)).toHaveLength(6);

    await drain(t.db, START - 1440 * MIN);
    expect(sent.filter((s) => s.m.subject?.startsWith("Reminder"))).toHaveLength(0);
    await drain(t.db, newStart - 1440 * MIN);
    expect(sent.filter((s) => s.m.subject?.startsWith("Reminder"))).toHaveLength(3);
    // plus exactly one rescheduled notice to the customer
    expect(sent.filter((s) => s.m.subject?.startsWith("Rescheduled:"))).toHaveLength(1);
  });

  it("changing reminder settings applies to the next booking only", () => {
    saveSettings({ reminderOffsetsMin: [60], reminderChannels: ["email"] }, t.db);
    const b = book();
    expect(jobs(`reminder:${b.id}:%`)).toHaveLength(1);
    saveSettings({ reminderOffsetsMin: [24 * 60, 120], reminderChannels: ["email", "sms", "whatsapp"] }, t.db);
  });
});

describe("queue mechanics", () => {
  it("a job can only be claimed once, and a crashed worker's job is reclaimed after the lease", () => {
    enqueue(t.db, { type: "x", dedupeKey: "claim-1", runAt: NOW }, NOW);
    const a = claimNext(t.db, NOW);
    expect(a?.attempts).toBe(1);
    expect(claimNext(t.db, NOW + 1000)).toBeNull();
    const reclaimed = claimNext(t.db, NOW + LEASE_MS + 1);
    expect(reclaimed?.id).toBe(a!.id);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("cancelQueued only touches matching queued jobs", () => {
    enqueue(t.db, { type: "x", dedupeKey: "grp:1:a", runAt: NOW + HOUR }, NOW);
    enqueue(t.db, { type: "x", dedupeKey: "grp:1:b", runAt: NOW + HOUR }, NOW);
    enqueue(t.db, { type: "x", dedupeKey: "grp:2:a", runAt: NOW + HOUR }, NOW);
    expect(cancelQueued(t.db, "grp:1:", NOW)).toBe(2);
    expect(jobs("grp:2:a")[0].status).toBe("queued");
    expect(cancelQueued(t.db, "grp_1", NOW)).toBe(0); // LIKE wildcards in the prefix are escaped
  });

  it("an unknown job type fails visibly instead of vanishing", async () => {
    enqueue(t.db, { type: "mystery", dedupeKey: "m1", runAt: NOW, maxAttempts: 1 }, NOW);
    await drain(t.db, NOW);
    expect(jobs("m1")[0]).toMatchObject({ status: "failed" });
    expect(jobs("m1")[0].last_error).toMatch(/No handler/);
    registerHandler("mystery", async () => undefined);
  });
});

describe("real adapters (HTTP stubbed)", () => {
  beforeEach(() => {
    Object.assign(process.env, {
      TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok", TWILIO_SMS_FROM: "+15550001111",
      WHATSAPP_PHONE_NUMBER_ID: "12345", WHATSAPP_ACCESS_TOKEN: "wa_token", WHATSAPP_TEMPLATE_NAME: "appointment_reminder",
    });
    resetEnvCache();
  });
  afterAll(() => {
    for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_FROM", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_TEMPLATE_NAME"]) delete process.env[k];
    resetEnvCache();
  });

  it("Twilio: form-encoded POST with basic auth", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ sid: "SM123" }), { status: 201 }));
    vi.stubGlobal("fetch", f);
    expect(smsAdapter.configured()).toBe(true);
    const r = await smsAdapter.send({ to: "+919876543210", text: "hello" });
    expect(r.providerId).toBe("SM123");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("ACtest:tok").toString("base64")}`);
    expect(String(init.body)).toContain("To=%2B919876543210");
  });

  it("WhatsApp Cloud API: template message with ordered body parameters, number without '+'", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const r = await whatsappAdapter.send({ to: "+919876543210", text: "", waParams: ["Asha", "Consultation", "3:30 PM", "Monday"] });
    expect(r.providerId).toBe("wamid.1");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/12345/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer wa_token");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ messaging_product: "whatsapp", to: "919876543210", type: "template", template: { name: "appointment_reminder" } });
    expect(body.template.components[0].parameters.map((p: any) => p.text)).toEqual(["Asha", "Consultation", "3:30 PM", "Monday"]);
  });

  it("classifies provider errors: 400 is permanent, 429/5xx are retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad number", { status: 400 })));
    await expect(smsAdapter.send({ to: "+1", text: "x" })).rejects.toBeInstanceOf(PermanentSendError);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    await expect(smsAdapter.send({ to: "+1", text: "x" })).rejects.not.toBeInstanceOf(PermanentSendError);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 503 })));
    await expect(whatsappAdapter.send({ to: "+1", text: "x" })).rejects.not.toBeInstanceOf(PermanentSendError);
  });
});

describe("phone numbers and templates", () => {
  it("normalises to E.164 only when the country is known", () => {
    expect(toE164("+91 98765-43210")).toBe("+919876543210");
    expect(toE164("98765 43210")).toBeNull();
    expect(toE164("098765 43210", "91")).toBe("+919876543210");
    expect(toE164("12", "91")).toBeNull();
    expect(toE164("abc")).toBeNull();
  });

  it("escapes HTML in customer-supplied fields and keeps subjects on one line", () => {
    const b = { ...book(START, { name: '<img src=x onerror=alert(1)> "Bob"\r\nBcc: evil@x.com' }) } as Booking;
    const m = buildMessage("confirmed", b, getSettings(t.db));
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&lt;img");
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
});
