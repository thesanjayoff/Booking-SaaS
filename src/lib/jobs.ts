/** Job handlers. Registered once by the worker (and by tests that drain the queue). */
import { env, has } from "./env";
import { run } from "./db";
import { getBooking } from "./bookings";
import { getSettings } from "./settings";
import { getServiceById } from "./services";
import { isConnected } from "./google/oauth";
import { registerHandler, type JobHandler } from "./queue";
import { bookingIcs } from "./ics";
import { manageUrl } from "./tokens";
import { buildMessage, type Kind } from "./notify/templates";
import { toE164, type Channel } from "./notify/adapters";
import { deliver } from "./notify/deliver";
import { fetchPayment, refundPayment } from "./payments/razorpay";
import { pushBookingToGoogle, syncFromGoogle } from "./google/sync";

const CUSTOMER_KINDS = new Set<Kind>(["confirmed", "rescheduled", "cancelled"]);

/** Transactional e-mails: confirmation, reschedule, cancellation, and owner alerts. */
const notify: JobHandler = async (job, { db, now }) => {
  const { bookingId, kind } = job.payload as { bookingId: string; kind: Kind };
  const b = getBooking(bookingId, db);
  if (!b) return;
  const settings = getSettings(db);

  // A video-visit confirmation should carry its Meet link. The calendar push runs in parallel, so
  // wait (via the queue's backoff) a few rounds for it; after that, send without rather than never.
  if ((kind === "confirmed" || kind === "rescheduled") && !b.meetUrl && b.status === "confirmed" && job.attempts < 4 && isConnected(db) && getServiceById(b.serviceId, db)?.createMeet) {
    throw new Error("Waiting for the Google Meet link");
  }

  // Don't announce something that is no longer true (e.g. confirmation for a booking cancelled meanwhile).
  if ((kind === "confirmed" || kind === "rescheduled" || kind === "owner_new" || kind === "owner_rescheduled") && b.status !== "confirmed") return;
  if ((kind === "cancelled" || kind === "owner_cancelled") && b.status !== "cancelled") return;

  const msg = buildMessage(kind, b, settings);
  const toCustomer = CUSTOMER_KINDS.has(kind);
  const owner = settings.ownerEmail || env().OWNER_NOTIFY_EMAIL || "";
  await deliver(
    db,
    {
      bookingId,
      kind: `${kind}${kind === "rescheduled" || kind === "owner_rescheduled" ? `#${b.rescheduleCount}` : ""}`,
      channel: "email",
      startAt: b.startAt,
      to: toCustomer ? b.email : owner || null,
      message: {
        to: "",
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        ics: msg.attachIcs ? bookingIcs(b, { name: settings.businessName }, manageUrl(b.id)) : undefined,
      },
    },
    now,
  );
};

/** Scheduled reminders, one job per channel and offset. */
const reminder: JobHandler = async (job, { db, now }) => {
  const p = job.payload as { bookingId: string; channel: Channel; offsetMin: number; startAt: number };
  const b = getBooking(p.bookingId, db);
  // Stale reminder: booking gone, cancelled, moved, or the appointment already began.
  if (!b || b.status !== "confirmed" || b.startAt !== p.startAt || b.startAt <= now) return;

  const settings = getSettings(db);
  const msg = buildMessage("reminder", b, settings, { hoursBefore: p.offsetMin / 60 });
  const phone = b.phone ? toE164(b.phone, process.env.DEFAULT_COUNTRY_CODE) : null;
  const to = p.channel === "email" ? b.email : phone;

  await deliver(
    db,
    {
      bookingId: b.id,
      kind: `reminder-${p.offsetMin}`,
      channel: p.channel,
      startAt: b.startAt,
      to,
      message: { to: "", subject: msg.subject, text: p.channel === "email" ? msg.text : msg.short, html: p.channel === "email" ? msg.html : undefined, waParams: msg.waParams },
    },
    now,
  );
};

/** Return a deposit to the customer. Safe to retry: checks the provider before refunding. */
const refund: JobHandler = async (job, { db, now }) => {
  const { bookingId } = job.payload as { bookingId: string };
  const b = getBooking(bookingId, db);
  if (!b || b.paymentStatus !== "refund_needed") return;
  if (!b.razorpayPaymentId) throw new Error("No payment id recorded for this booking; refund manually in the Razorpay dashboard");
  if (!has(env().RAZORPAY_KEY_ID)) throw new Error("Razorpay is not configured");

  const pay = await fetchPayment(b.razorpayPaymentId);
  if ((pay.amount_refunded ?? 0) < b.depositMinor) {
    await refundPayment(b.razorpayPaymentId, b.depositMinor - (pay.amount_refunded ?? 0), `refund-${b.id}`);
  }
  run(db, "UPDATE bookings SET payment_status = 'refunded', updated_at = ? WHERE id = ? AND payment_status = 'refund_needed'", now, b.id);
};

export function registerAllHandlers() {
  registerHandler("notify", notify);
  registerHandler("reminder", reminder);
  registerHandler("refund", refund);
  registerHandler("gcal.push", async (job, ctx) => pushBookingToGoogle((job.payload as { bookingId: string }).bookingId, ctx.db));
  registerHandler("gcal.sync", async (_job, ctx) => void (await syncFromGoogle(ctx.db, ctx.now)));
}
