"use client";

import { useEffect, useState } from "react";

const LOCALE = "en-IN";
const DAY = 86_400_000;

/** Whole-day distance between two instants as seen in `tz` (0 = same day). DST-safe. */
function dayDiff(ms: number, now: number, tz: string): number {
  const key = (t: number) => {
    const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(t)
      .split("-")
      .map(Number);
    return Date.UTC(y, m - 1, d) / DAY;
  };
  return key(ms) - key(now);
}
// Fixed 12-hour style so the landing page matches the booking picker and the emails.
export function formatOpening(ms: number, tz: string, now: number): string {
  const diff = dayDiff(ms, now, tz);
  const time = new Intl.DateTimeFormat(LOCALE, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms);
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Tomorrow, ${time}`;
  const day = new Intl.DateTimeFormat(LOCALE, { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(ms);
  return `${day}, ${time}`;
}

/**
 * A start time shown in the visitor's own time zone. The first render uses the clinic's zone and the
 * server's clock (so server and client markup match); once mounted it switches to the visitor's zone.
 */
export default function LocalTime({ ms, businessTz, serverNow }: { ms: number; businessTz: string; serverNow: number }) {
  const [view, setView] = useState<{ tz: string; now: number }>({ tz: businessTz, now: serverNow });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- must wait for mount to read the visitor's zone
    setView({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone || businessTz, now: Date.now() });
  }, [businessTz]);

  return <time dateTime={new Date(ms).toISOString()}>{formatOpening(ms, view.tz, view.now)}</time>;
}
