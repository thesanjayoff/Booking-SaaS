import { getDb, run, tx, type Db } from "./db";
import { drain, enqueue } from "./queue";
import { releaseExpiredHolds } from "./bookings";
import { registerAllHandlers } from "./jobs";
import { isConnected } from "./google/oauth";

const GOOGLE_SYNC_EVERY_MS = 5 * 60_000;
const g = globalThis as unknown as { __bookingWorker?: { timer: NodeJS.Timeout; busy: boolean; lastCleanup: number } };

/** One scheduler tick: housekeeping, periodic job enqueueing, then run due jobs. Exported for tests. */
export async function runTick(db: Db, now = Date.now()): Promise<number> {
  tx(db, () => releaseExpiredHolds(db, now));
  if (isConnected(db)) {
    // One job per 5-minute bucket: any number of ticks/processes enqueue it only once.
    enqueue(db, { type: "gcal.sync", dedupeKey: `gcal.sync:${Math.floor(now / GOOGLE_SYNC_EVERY_MS)}`, maxAttempts: 2 }, now);
  }
  return drain(db, now, 50);
}

function cleanup(db: Db, now: number) {
  run(db, "DELETE FROM jobs WHERE status IN ('done','cancelled') AND updated_at < ?", now - 14 * 86_400_000);
  run(db, "DELETE FROM webhook_events WHERE processed_at IS NOT NULL AND received_at < ?", now - 90 * 86_400_000);
}

export function startWorker(opts: { intervalMs?: number; db?: Db } = {}): () => void {
  if (g.__bookingWorker) return stopWorker; // one per process, even across dev hot reloads
  const db = opts.db ?? getDb();
  registerAllHandlers();
  const state = { timer: undefined as unknown as NodeJS.Timeout, busy: false, lastCleanup: 0 };
  const tick = async () => {
    if (state.busy) return;
    state.busy = true;
    try {
      const now = Date.now();
      await runTick(db, now);
      if (now - state.lastCleanup > 3_600_000) {
        state.lastCleanup = now;
        cleanup(db, now);
      }
    } catch (e) {
      console.error("[worker] tick failed:", e);
    } finally {
      state.busy = false;
    }
  };
  state.timer = setInterval(tick, opts.intervalMs ?? 5000);
  state.timer.unref?.();
  g.__bookingWorker = state;
  void tick();
  console.log("[worker] started: reminders, notifications, refunds and calendar sync");
  return stopWorker;
}

export function stopWorker() {
  if (g.__bookingWorker) {
    clearInterval(g.__bookingWorker.timer);
    delete g.__bookingWorker;
  }
}
