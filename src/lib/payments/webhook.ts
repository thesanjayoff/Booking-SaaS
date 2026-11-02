import { get, run, tx, type Db } from "../db";
import { applyPaymentCaptured, applyRefundProcessed } from "./process";

export type WebhookResult = { status: "processed" | "duplicate" | "ignored"; outcome?: string };

/**
 * Idempotent Razorpay webhook processing.
 *  - The provider's event id is the PRIMARY KEY of webhook_events, so a redelivery is detected
 *    by the database, not by hope.
 *  - A delivery is only "done" once processed_at is set. If processing throws, the row stays
 *    unprocessed and Razorpay's retry runs it again.
 *  - Even a concurrent double-delivery is safe because applyPaymentCaptured is state-based.
 */
export function handleRazorpayEvent(db: Db, eventId: string, event: any, now = Date.now()): WebhookResult {
  const type = String(event?.event ?? "unknown").slice(0, 60);

  const alreadyDone = tx(db, () => {
    run(db, "INSERT OR IGNORE INTO webhook_events (id, provider, type, received_at) VALUES (?, 'razorpay', ?, ?)", eventId, type, now);
    return !!get(db, "SELECT 1 FROM webhook_events WHERE id = ? AND processed_at IS NOT NULL", eventId);
  });
  if (alreadyDone) return { status: "duplicate" };

  let outcome = "ignored";
  switch (type) {
    case "payment.captured":
    case "order.paid": {
      const pay = event?.payload?.payment?.entity;
      if (pay?.order_id && pay?.id && Number.isFinite(pay.amount)) {
        outcome = applyPaymentCaptured(db, { orderId: pay.order_id, paymentId: pay.id, amountMinor: pay.amount, now }).outcome;
      }
      break;
    }
    case "refund.processed": {
      const paymentId = event?.payload?.refund?.entity?.payment_id ?? event?.payload?.payment?.entity?.id;
      if (paymentId) {
        applyRefundProcessed(db, paymentId, now);
        outcome = "refund_recorded";
      }
      break;
    }
    case "payment.failed":
      outcome = "payment_failed_noted"; // booking stays pending until the hold expires; customer may retry
      break;
    default:
      break;
  }

  run(db, "UPDATE webhook_events SET processed_at = ?, outcome = ? WHERE id = ?", now, outcome, eventId);
  return { status: outcome === "ignored" ? "ignored" : "processed", outcome };
}
