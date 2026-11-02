import { createHash } from "node:crypto";
import { apiError, json } from "@/lib/api";
import { getDb } from "@/lib/db";
import { paymentsEnabled } from "@/lib/payments/config";
import { verifyWebhookSignature } from "@/lib/payments/razorpay";
import { handleRazorpayEvent } from "@/lib/payments/webhook";
import { limit } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!paymentsEnabled()) return apiError(404, "not_found", "Not found");
  const limited = limit(req, "webhook", 300, 60_000);
  if (limited) return limited;

  // Signature is over the RAW body: read text, verify, only then parse.
  const raw = await req.text();
  if (raw.length > 256 * 1024) return apiError(413, "too_large", "Payload too large");
  if (!verifyWebhookSignature(raw, req.headers.get("x-razorpay-signature"))) return apiError(401, "bad_signature", "Invalid signature");

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return apiError(400, "invalid_json", "Invalid JSON");
  }
  const eventId = req.headers.get("x-razorpay-event-id") || `body-${createHash("sha256").update(raw).digest("hex")}`;

  try {
    return json(handleRazorpayEvent(getDb(), eventId.slice(0, 120), event));
  } catch (e) {
    console.error("razorpay webhook failed", e);
    return apiError(500, "server_error", "Processing failed; will be retried"); // non-2xx => Razorpay retries
  }
}
