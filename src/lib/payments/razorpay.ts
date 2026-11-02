/**
 * Minimal Razorpay client over fetch (no SDK: fewer dependencies, easy to stub in tests).
 * Amounts are in the smallest currency unit (paise), same as our *_minor columns.
 */
import { createHmac } from "node:crypto";
import { env, has } from "../env";
import { safeEqual } from "../tokens";

const API = "https://api.razorpay.com/v1";

function creds() {
  const e = env();
  if (!has(e.RAZORPAY_KEY_ID) || !has(e.RAZORPAY_KEY_SECRET)) throw new Error("Razorpay credentials are not configured");
  return { id: e.RAZORPAY_KEY_ID, secret: e.RAZORPAY_KEY_SECRET };
}

export class RazorpayError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const { id, secret } = creds();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw new RazorpayError(res.status, data?.error?.description ?? `Razorpay HTTP ${res.status}`);
  return data as T;
}

export type RzpOrder = { id: string; amount: number; currency: string; status: string; receipt?: string };
export type RzpPayment = { id: string; order_id: string; amount: number; amount_refunded?: number; status: string; currency: string };

export const createOrder = (p: { amountMinor: number; currency: string; receipt: string; notes?: Record<string, string> }) =>
  call<RzpOrder>("POST", "/orders", { amount: p.amountMinor, currency: p.currency, receipt: p.receipt, notes: p.notes });

export const fetchPayment = (paymentId: string) => call<RzpPayment>("GET", `/payments/${encodeURIComponent(paymentId)}`);

export const refundPayment = (paymentId: string, amountMinor: number, receipt: string) =>
  call<{ id: string; status: string }>("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { amount: amountMinor, receipt, speed: "normal" });

const sign = (secret: string, data: string | Buffer) => createHmac("sha256", secret).update(data).digest("hex");

/** Checkout success callback: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
  const { secret } = creds();
  return safeEqual(sign(secret, `${orderId}|${paymentId}`), signature);
}

/** Webhook: HMAC_SHA256(raw request body, webhook_secret). Must be computed over the RAW bytes. */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = env().RAZORPAY_WEBHOOK_SECRET;
  if (!has(secret) || !signature) return false;
  return safeEqual(sign(secret, rawBody), signature);
}

export const _sign = sign; // exported for tests
