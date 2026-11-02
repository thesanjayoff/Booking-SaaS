import type { Booking } from "./bookings";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** RFC 5545 content lines are folded at 75 octets. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 74) {
      out.push(cur);
      cur = " " + ch;
      bytes = 1 + b;
    } else {
      cur += ch;
      bytes += b;
    }
  }
  out.push(cur);
  return out.join("\r\n");
}

export function bookingIcs(b: Booking, business: { name: string; email?: string }, manageLink?: string): string {
  const desc = [`${b.serviceName} at ${business.name}`, manageLink ? `Manage: ${manageLink}` : "", b.meetUrl ? `Join: ${b.meetUrl}` : ""].filter(Boolean).join("\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Booking App//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${b.id}@booking-app`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(b.startAt)}`,
    `DTEND:${stamp(b.endAt)}`,
    `SEQUENCE:${b.rescheduleCount}`,
    `SUMMARY:${esc(`${b.serviceName} – ${business.name}`)}`,
    `DESCRIPTION:${esc(desc)}`,
    ...(b.meetUrl || b.location ? [`LOCATION:${esc(b.meetUrl || b.location)}`] : []),
    `STATUS:${b.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
