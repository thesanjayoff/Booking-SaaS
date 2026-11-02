import { getDb, type Db } from "./db";
import { getSlots } from "./availability/store";
import type { Service } from "./services";

const DAY = 86_400_000;

/**
 * The first bookable start time for each service within the next `horizonDays`
 * (UTC epoch ms). Services with nothing open are left out of the map.
 * Uses the same engine as the booking page, so what the landing page promises is what the picker offers.
 */
export function nextOpenings(services: Service[], db: Db = getDb(), now = Date.now(), horizonDays = 21): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of services) {
    try {
      const first = getSlots(s.id, { from: now, to: now + horizonDays * DAY }, { db, now })[0];
      if (first !== undefined) out.set(s.id, first);
    } catch {
      /* a broken rule must not take the landing page down */
    }
  }
  return out;
}
