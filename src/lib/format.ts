import { DateTime } from "luxon";

export const fmtDate = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat("cccc, d LLLL yyyy");
export const fmtTime = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat("h:mm a");
export const fmtTz = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat("ZZZZ");
export const fmtDateTime = (ms: number, tz: string) => `${fmtDate(ms, tz)}, ${fmtTime(ms, tz)} ${fmtTz(ms, tz)}`;
export const fmtShort = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat("d LLL, h:mm a");

export function fmtDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
