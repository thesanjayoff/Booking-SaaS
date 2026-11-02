import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { makeTestDb, seedBasic } from "./helpers";
import { all, get, run } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { resetRateLimits } from "@/lib/ratelimit";
import { createBooking, cancelBooking, getBooking, releaseExpiredHolds } from "@/lib/bookings";
import { createService, type Service } from "@/lib/services";
import { startDepositPayment } from "@/lib/payments/checkout";
import { handleRazorpayEvent } from "@/lib/payments/webhook";
import { applyPaymentCaptured } from "@/lib/payments/process";
import { verifyWebhookSignature, verifyCheckoutSignature } from "@/lib/payments/razorpay";
import { paymentsEnabled } from "@/lib/payments/config";
import { manageToken } from "@/lib/tokens";
import { POST as webhookPOST } from "@/app/api/webhooks/razorpay/route";
import { POST as verifyPOST } from "@/app/api/bookings/[id]/pay/verify/route";

const KEY_SECRET = "rzp_test_secret_value";
const WH_SECRET = "whsec_test_value";
const MIN = 60_000;
const NOW = Date.parse("2030-05-27T08:00:00Z");
const at = (hhmm: string, date = "2030-06-03") => Date.parse(`${date}T${hhmm}:00Z`);

const t = makeTestDb("payments");
let dep: Service;
let n = 0;
const env0 = { ...process.env };

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");
const who = () => ({ name: "Payer", email: `payer${++n}@example.com`, timezone: "UTC" });
const book = (start: number, now = NOW) =>
  createBooking({ serviceId: dep.id, startAt: start, ...who() }, { db: t.db, now, paymentsEnabled: true }).booking;

let orderSeq = 0;
const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (String(url).endsWith("/orders")) {
    return new Response(JSON.stringify({ id: `order_${++orderSeq}`, amount: body.amount, currency: body.currency, status: "created", receipt: body.receipt }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { description: "unexpected" } }), { status: 500 });
});

const capturedEvent = (orderId: string, paymentId: string, amount: number) => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency: "INR", status: "captured" } } },
});

beforeAll(() => {
  Object.assign(process.env, {
    PAYMENTS_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WH_SECRET,
    DATABASE_PATH: t.file,
  });
  resetEnvCache();
  seedBasic(t.db, { settings: { maxAdvanceDays: 3650, holdMinutes: 15 } });
  dep = createService({ name: "Deposit visit", slug: "deposit", durationMin: 30, priceMinor: 100000, depositMinor: 25000 }, t.db);
});
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  resetRateLimits();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  for (const k of ["PAYMENTS_ENABLED", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "DATABASE_PATH"]) {
    if (env0[k] === undefined) delete process.env[k];
    else process.env[k] = env0[k];
  }
  resetEnvCache();
  t.cleanup();
});

describe("payments toggle", () => {
  it("is enabled only with the flag AND keys", () => {
    expect(paymentsEnabled()).toBe(true);
    process.env.RAZORPAY_KEY_ID = "";
    resetEnvCache();
    expect(paymentsEnabled()).toBe(false);
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    resetEnvCache();
    process.env.PAYMENTS_ENABLED = "0";
    resetEnvCache();
    expect(paymentsEnabled()).toBe(false);
    process.env.PAYMENTS_ENABLED = "1";
    resetEnvCache();
  });
});

describe("creating the deposit order", () => {
  it("creates one Razorpay order for the deposit amount (paise) with basic auth, and reuses it on retry", async () => {
    const b = book(at("09:00"));
    const first = await startDepositPayment(b, t.db);
    expect(first).toMatchObject({ amount: 25000, currency: "INR", keyId: "rzp_test_key" });
    expect(JSON.stringify(first)).not.toContain(KEY_SECRET); // the secret never reaches the browser payload
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.razorpay.com/v1/orders");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`rzp_test_key:${KEY_SECRET}`).toString("base64")}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ amount: 25000, currency: "INR", receipt: b.id });

    const again = await startDepositPayment(getBooking(b.id, t.db)!, t.db);
    expect(again.orderId).toBe(first.orderId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("signatures", () => {
  it("verifies webhook HMACs over the raw body and rejects tampering / missing headers", () => {
    const raw = JSON.stringify({ event: "payment.captured" });
    expect(verifyWebhookSignature(raw, sign(WH_SECRET, raw))).toBe(true);
    expect(verifyWebhookSignature(raw + " ", sign(WH_SECRET, raw))).toBe(false);
    expect(verifyWebhookSignature(raw, sign("other-secret", raw))).toBe(false);
    expect(verifyWebhookSignature(raw, null)).toBe(false);
    expect(verifyWebhookSignature(raw, "")).toBe(false);
  });

  it("verifies the checkout callback signature (order_id|payment_id)", () => {
    expect(verifyCheckoutSignature("order_1", "pay_1", sign(KEY_SECRET, "order_1|pay_1"))).toBe(true);
    expect(verifyCheckoutSignature("order_1", "pay_2", sign(KEY_SECRET, "order_1|pay_1"))).toBe(false);
  });
});

describe("idempotent webhook handling", () => {
  async function pendingWithOrder(start: string, date = "2030-06-04") {
    const b = book(at(start, date));
    const p = await startDepositPayment(b, t.db);
    return { b, orderId: p.orderId };
  }
  const confirmJobs = (id: string) => all(t.db, "SELECT id FROM jobs WHERE dedupe_key = ?", `notify:confirmed:${id}:0`).length;

  it("confirms on payment.captured exactly once, however many times the same event is delivered", async () => {
    const { b, orderId } = await pendingWithOrder("09:00");
    const ev = capturedEvent(orderId, "pay_A", 25000);
    expect(handleRazorpayEvent(t.db, "evt_A", ev, NOW)).toMatchObject({ status: "processed", outcome: "confirmed" });
    for (let i = 0; i < 5; i++) expect(handleRazorpayEvent(t.db, "evt_A", ev, NOW).status).toBe("duplicate");
    const after = getBooking(b.id, t.db)!;
    expect(after).toMatchObject({ status: "confirmed", paymentStatus: "paid", razorpayPaymentId: "pay_A", holdExpiresAt: null });
    expect(confirmJobs(b.id)).toBe(1);
    expect(get<{ n: number }>(t.db, "SELECT COUNT(*) AS n FROM webhook_events WHERE id = 'evt_A'")!.n).toBe(1);
  });

  it("is idempotent across DIFFERENT events for the same payment (payment.captured then order.paid)", async () => {
    const { b, orderId } = await pendingWithOrder("09:30");
    handleRazorpayEvent(t.db, "evt_B1", capturedEvent(orderId, "pay_B", 25000), NOW);
    const second = handleRazorpayEvent(t.db, "evt_B2", { ...capturedEvent(orderId, "pay_B", 25000), event: "order.paid" }, NOW);
    expect(second.outcome).toBe("already_paid");
    expect(confirmJobs(b.id)).toBe(1);
  });

  it("a failed handler leaves the event unprocessed so the provider's retry runs it", async () => {
    const { b, orderId } = await pendingWithOrder("10:00");
    const ev = capturedEvent(orderId, "pay_C", 25000);
    run(t.db, "ALTER TABLE bookings RENAME TO bookings_x"); // sabotage -> processing throws
    expect(() => handleRazorpayEvent(t.db, "evt_C", ev, NOW)).toThrow();
    run(t.db, "ALTER TABLE bookings_x RENAME TO bookings");
    expect(get(t.db, "SELECT processed_at FROM webhook_events WHERE id = 'evt_C'")!.processed_at).toBeNull();
    expect(handleRazorpayEvent(t.db, "evt_C", ev, NOW)).toMatchObject({ status: "processed", outcome: "confirmed" });
    expect(getBooking(b.id, t.db)!.status).toBe("confirmed");
  });

  it("does not confirm when the paid amount is below the deposit", async () => {
    const { b, orderId } = await pendingWithOrder("10:30");
    expect(handleRazorpayEvent(t.db, "evt_D", capturedEvent(orderId, "pay_D", 100), NOW).outcome).toBe("amount_mismatch");
    expect(getBooking(b.id, t.db)).toMatchObject({ status: "pending_payment", paymentStatus: "pending" });
  });

  it("ignores unknown orders and irrelevant event types without error", () => {
    expect(handleRazorpayEvent(t.db, "evt_E1", capturedEvent("order_nope", "pay_E", 25000), NOW).outcome).toBe("unknown_order");
    expect(handleRazorpayEvent(t.db, "evt_E2", { event: "subscription.charged", payload: {} }, NOW).status).toBe("ignored");
  });

  it("payment after the hold expired: re-confirms if the slot is still free", async () => {
    const { b, orderId } = await pendingWithOrder("11:00");
    releaseExpiredHolds(t.db, NOW + 20 * MIN);
    expect(getBooking(b.id, t.db)!.status).toBe("cancelled");
    const r = applyPaymentCaptured(t.db, { orderId, paymentId: "pay_F", amountMinor: 25000, now: NOW + 21 * MIN });
    expect(r.outcome).toBe("reconfirmed_after_expiry");
    expect(getBooking(b.id, t.db)).toMatchObject({ status: "confirmed", paymentStatus: "paid", cancelledBy: null });
    expect(get<{ n: number }>(t.db, "SELECT COUNT(*) AS n FROM slot_locks WHERE booking_id = ?", b.id)!.n).toBe(6);
  });

  it("payment after the hold expired and the slot was taken: queues a refund instead of double-booking", async () => {
    const { b, orderId } = await pendingWithOrder("11:30");
    releaseExpiredHolds(t.db, NOW + 20 * MIN);
    const winner = createBooking({ serviceId: dep.id, startAt: b.startAt, ...who() }, { db: t.db, now: NOW + 21 * MIN, paymentsEnabled: false }).booking;
    const r = applyPaymentCaptured(t.db, { orderId, paymentId: "pay_G", amountMinor: 25000, now: NOW + 22 * MIN });
    expect(r.outcome).toBe("refund_queued");
    expect(getBooking(b.id, t.db)).toMatchObject({ status: "cancelled", paymentStatus: "refund_needed" });
    expect(getBooking(winner.id, t.db)!.status).toBe("confirmed");
    expect(get<{ n: number }>(t.db, "SELECT COUNT(*) AS n FROM slot_locks WHERE booking_id = ?", b.id)!.n).toBe(0);
    expect(all(t.db, "SELECT id FROM jobs WHERE dedupe_key = ?", `refund:${b.id}`)).toHaveLength(1);
  });

  it("cancelling a paid booking queues exactly one refund", async () => {
    const { b, orderId } = await pendingWithOrder("12:00");
    handleRazorpayEvent(t.db, "evt_H", capturedEvent(orderId, "pay_H", 25000), NOW);
    cancelBooking(b.id, { by: "owner", db: t.db, now: NOW });
    cancelBooking(b.id, { by: "owner", db: t.db, now: NOW });
    expect(getBooking(b.id, t.db)!.paymentStatus).toBe("refund_needed");
    expect(all(t.db, "SELECT id FROM jobs WHERE dedupe_key = ?", `refund:${b.id}`)).toHaveLength(1);
  });

  it("refund.processed marks the booking refunded", async () => {
    const { b, orderId } = await pendingWithOrder("13:00");
    handleRazorpayEvent(t.db, "evt_I1", capturedEvent(orderId, "pay_I", 25000), NOW);
    cancelBooking(b.id, { by: "owner", db: t.db, now: NOW });
    handleRazorpayEvent(t.db, "evt_I2", { event: "refund.processed", payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_I" } } } }, NOW);
    expect(getBooking(b.id, t.db)!.paymentStatus).toBe("refunded");
  });
});

describe("HTTP endpoints", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/webhooks/razorpay", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

  it("webhook: 401 on bad/missing signature, 400 on invalid JSON, 200 + dedupe on valid replays", async () => {
    const b = book(at("14:00", "2030-06-04"));
    const { orderId } = await startDepositPayment(b, t.db);
    const raw = JSON.stringify(capturedEvent(orderId, "pay_J", 25000));

    expect((await webhookPOST(post(raw))).status).toBe(401);
    expect((await webhookPOST(post(raw, { "x-razorpay-signature": sign("wrong", raw) }))).status).toBe(401);
    expect(getBooking(b.id, t.db)!.status).toBe("pending_payment");

    const good = { "x-razorpay-signature": sign(WH_SECRET, raw), "x-razorpay-event-id": "evt_http_1" };
    const r1 = await webhookPOST(post(raw, good));
    expect(r1.status).toBe(200);
    expect((await r1.json()).outcome).toBe("confirmed");
    const r2 = await webhookPOST(post(raw, good));
    expect((await r2.json()).status).toBe("duplicate");
    expect(getBooking(b.id, t.db)!.status).toBe("confirmed");

    const junk = "not json";
    expect((await webhookPOST(post(junk, { "x-razorpay-signature": sign(WH_SECRET, junk) }))).status).toBe(400);
  });

  it("checkout verify: only a correctly signed callback confirms the booking", async () => {
    const b = book(at("14:30", "2030-06-04"));
    const { orderId } = await startDepositPayment(b, t.db);
    const call = (sig: string, paymentId = "pay_K") =>
      verifyPOST(
        new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: manageToken(b.id), razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sig }) }),
        { params: Promise.resolve({ id: b.id }) },
      );
    expect((await call("deadbeef")).status).toBe(400);
    expect(getBooking(b.id, t.db)!.status).toBe("pending_payment");
    const ok = await call(sign(KEY_SECRET, `${orderId}|pay_K`));
    expect(ok.status).toBe(200);
    expect(getBooking(b.id, t.db)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    // replay is harmless
    expect((await call(sign(KEY_SECRET, `${orderId}|pay_K`))).status).toBe(200);
    expect(all(t.db, "SELECT id FROM jobs WHERE dedupe_key = ?", `notify:confirmed:${b.id}:0`)).toHaveLength(1);
  });

  it("checkout verify rejects a wrong manage token", async () => {
    const b = book(at("15:00", "2030-06-04"));
    const { orderId } = await startDepositPayment(b, t.db);
    const res = await verifyPOST(
      new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: "nope", razorpay_order_id: orderId, razorpay_payment_id: "pay_L", razorpay_signature: sign(KEY_SECRET, `${orderId}|pay_L`) }) }),
      { params: Promise.resolve({ id: b.id }) },
    );
    expect(res.status).toBe(403);
  });
});

describe("payments disabled (the default)", () => {
  it("webhook endpoint 404s and bookings with deposits confirm without payment", async () => {
    process.env.PAYMENTS_ENABLED = "0";
    resetEnvCache();
    const res = await webhookPOST(new Request("http://x/api", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
    const b = createBooking({ serviceId: dep.id, startAt: at("16:00", "2030-06-05"), ...who() }, { db: t.db, now: NOW }).booking;
    expect(b).toMatchObject({ status: "confirmed", paymentStatus: "none", depositMinor: 0 });
    process.env.PAYMENTS_ENABLED = "1";
    resetEnvCache();
  });
});
