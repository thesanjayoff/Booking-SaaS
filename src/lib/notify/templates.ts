import type { Booking } from "../bookings";
import type { Settings } from "../settings";
import { fmtDate, fmtTime, fmtTz } from "../format";
import { formatMoney } from "../services";
import { manageUrl } from "../tokens";

export type Kind = "confirmed" | "cancelled" | "rescheduled" | "reminder" | "owner_new" | "owner_cancelled" | "owner_rescheduled";

export type Message = {
  subject: string;
  text: string;
  html: string;
  /** Short plain text for SMS / WhatsApp. */
  short: string;
  /** Values for WhatsApp template parameters, in order. */
  waParams: string[];
  attachIcs: boolean;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function buildMessage(kind: Kind, b: Booking, s: Settings, opts: { hoursBefore?: number } = {}): Message {
  const tz = kind.startsWith("owner_") ? s.timezone : b.customerTz;
  const when = `${fmtDate(b.startAt, tz)} at ${fmtTime(b.startAt, tz)} ${fmtTz(b.startAt, tz)}`;
  const link = manageUrl(b.id);
  const where = b.meetUrl ? `Join: ${b.meetUrl}` : b.location || s.address;
  const biz = s.businessName;

  const customerLines = (lead: string, extra: string[] = []) => ({
    text: [`Hi ${b.name},`, "", lead, "", `Service: ${b.serviceName}`, `When: ${when}`, where ? `Where: ${where}` : "", ...extra, "", `Manage your booking: ${link}`, "", `— ${biz}`]
      .filter((x, i, a) => x !== "" || a[i - 1] !== "")
      .join("\n"),
    html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;color:#0f172a">
      <p>Hi ${esc(b.name)},</p><p>${esc(lead)}</p>
      <table style="border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Service</td><td><strong>${esc(b.serviceName)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">When</td><td><strong>${esc(when)}</strong></td></tr>
        ${where ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b">Where</td><td>${b.meetUrl ? `<a href="${esc(b.meetUrl)}">${esc(b.meetUrl)}</a>` : esc(where)}</td></tr>` : ""}
        ${extra.map((l) => `<tr><td></td><td>${esc(l)}</td></tr>`).join("")}
      </table>
      <p><a href="${esc(link)}" style="background:#0d9488;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">View, reschedule or cancel</a></p>
      <p style="color:#64748b;font-size:13px">— ${esc(biz)}</p></div>`,
  });

  switch (kind) {
    case "confirmed": {
      const dep = b.depositMinor > 0 && b.paymentStatus === "paid" ? [`Deposit received: ${formatMoney(b.depositMinor, b.currency)}`] : [];
      const m = customerLines(`Your appointment is confirmed.`, dep);
      return { subject: `Confirmed: ${b.serviceName} on ${fmtDate(b.startAt, tz)}`, ...m, short: `${biz}: confirmed ${b.serviceName}, ${when}. Manage: ${link}`, waParams: [b.name, b.serviceName, fmtTime(b.startAt, tz), fmtDate(b.startAt, tz)], attachIcs: true };
    }
    case "rescheduled": {
      const m = customerLines(`Your appointment has been moved to a new time.`);
      return { subject: `Rescheduled: ${b.serviceName} – ${fmtDate(b.startAt, tz)}`, ...m, short: `${biz}: your ${b.serviceName} moved to ${when}. Manage: ${link}`, waParams: [b.name, b.serviceName, fmtTime(b.startAt, tz), fmtDate(b.startAt, tz)], attachIcs: true };
    }
    case "cancelled": {
      const refund = b.paymentStatus === "refund_needed" || b.paymentStatus === "refunded" ? [`Your deposit of ${formatMoney(b.depositMinor, b.currency)} will be refunded to the original payment method.`] : [];
      const m = customerLines(`Your appointment has been cancelled${b.cancelReason ? ` (${b.cancelReason})` : ""}.`, refund);
      return { subject: `Cancelled: ${b.serviceName} on ${fmtDate(b.startAt, tz)}`, ...m, short: `${biz}: your ${b.serviceName} on ${when} was cancelled.`, waParams: [b.name, b.serviceName, fmtTime(b.startAt, tz), fmtDate(b.startAt, tz)], attachIcs: false };
    }
    case "reminder": {
      const h = opts.hoursBefore ?? 24;
      const lead = h >= 24 ? "This is a reminder about your appointment tomorrow." : `This is a reminder: your appointment starts in about ${h < 2 ? "an hour" : `${Math.round(h)} hours`}.`;
      const m = customerLines(lead);
      return { subject: `Reminder: ${b.serviceName} – ${fmtDate(b.startAt, tz)} ${fmtTime(b.startAt, tz)}`, ...m, short: `${biz} reminder: ${b.serviceName} on ${when}. Manage: ${link}`, waParams: [b.name, b.serviceName, fmtTime(b.startAt, tz), fmtDate(b.startAt, tz)], attachIcs: false };
    }
    default: {
      const label = kind === "owner_new" ? "New booking" : kind === "owner_cancelled" ? "Booking cancelled" : "Booking rescheduled";
      const text = [`${label}`, "", `${b.name} <${b.email}>${b.phone ? ` · ${b.phone}` : ""}`, `${b.serviceName}`, when, b.notes ? `Notes: ${b.notes}` : ""].filter(Boolean).join("\n");
      return {
        subject: `${label}: ${b.name} – ${fmtDate(b.startAt, tz)} ${fmtTime(b.startAt, tz)}`,
        text,
        html: `<div style="font-family:system-ui,Arial,sans-serif;color:#0f172a"><p><strong>${esc(label)}</strong></p><p>${esc(b.name)} &lt;${esc(b.email)}&gt;${b.phone ? ` · ${esc(b.phone)}` : ""}<br>${esc(b.serviceName)}<br><strong>${esc(when)}</strong></p>${b.notes ? `<p>Notes: ${esc(b.notes)}</p>` : ""}</div>`,
        short: text,
        waParams: [],
        attachIcs: false,
      };
    }
  }
}
