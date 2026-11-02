import type { Db } from "./db";
import { cancelQueued, enqueue } from "./queue";
import type { Settings } from "./settings";

const MIN = 60_000;

/** One job per (booking, appointment start, channel, offset). Same key twice = no-op. */
export const reminderKey = (bookingId: string, startAt: number, channel: string, offsetMin: number) =>
  `reminder:${bookingId}:${startAt}:${channel}:${offsetMin}`;

export function scheduleReminders(db: Db, booking: { id: string; startAt: number }, settings: Settings, now = Date.now()) {
  for (const channel of settings.reminderChannels) {
    for (const offset of settings.reminderOffsetsMin) {
      const runAt = booking.startAt - offset * MIN;
      if (runAt <= now) continue; // too late for this one (e.g. booked 1h ahead, 24h reminder)
      enqueue(
        db,
        {
          type: "reminder",
          payload: { bookingId: booking.id, channel, offsetMin: offset, startAt: booking.startAt },
          runAt,
          dedupeKey: reminderKey(booking.id, booking.startAt, channel, offset),
          maxAttempts: 6,
        },
        now,
      );
    }
  }
}

export const cancelReminders = (db: Db, bookingId: string, now = Date.now()) => cancelQueued(db, `reminder:${bookingId}:`, now);
