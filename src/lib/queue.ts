/**
 * Small durable job queue on SQLite (same semantics we'd want from BullMQ here):
 *  - dedupe_key UNIQUE  -> enqueueing the same logical job twice is a no-op (no duplicates)
 *  - atomic claim       -> BEGIN IMMEDIATE; two workers can never take the same job
 *  - lease + reclaim    -> a crashed worker's job becomes runnable again after `locked_until`
 *  - retries w/ backoff -> exponential with jitter, up to max_attempts, then 'failed'
 * Jobs are enqueued inside the same DB transaction as the change that needs them
 * (transactional outbox), so a booking can never exist without its follow-up work.
 */
import { getDb, all, get, run, tx, type Db } from "./db";

export type Job = {
  id: number;
  type: string;
  payload: any;
  dedupeKey: string | null;
  attempts: number;
  maxAttempts: number;
  runAt: number;
};

export type JobHandler = (job: Job, ctx: { db: Db; now: number }) => Promise<void>;

const handlers = new Map<string, JobHandler>();
export const registerHandler = (type: string, fn: JobHandler) => void handlers.set(type, fn);
export const hasHandler = (type: string) => handlers.has(type);

export const LEASE_MS = 5 * 60_000;

export function enqueue(
  db: Db,
  job: { type: string; payload?: unknown; runAt?: number; dedupeKey?: string; maxAttempts?: number },
  now = Date.now(),
): boolean {
  const res = run(
    db,
    `INSERT INTO jobs (type, payload, dedupe_key, run_at, max_attempts, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`,
    job.type, JSON.stringify(job.payload ?? {}), job.dedupeKey ?? null, job.runAt ?? now, job.maxAttempts ?? 5, now, now,
  );
  return Number(res.changes) > 0;
}

/** Cancel not-yet-run jobs whose dedupe_key starts with `prefix` (e.g. a booking's reminders). */
export function cancelQueued(db: Db, prefix: string, now = Date.now()): number {
  const res = run(
    db,
    `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE status = 'queued' AND dedupe_key LIKE ? ESCAPE '\\'`,
    now, prefix.replace(/[\\%_]/g, "\\$&") + "%",
  );
  return Number(res.changes);
}

type JobRow = { id: number; type: string; payload: string; dedupe_key: string | null; attempts: number; max_attempts: number; run_at: number };

export function claimNext(db: Db, now = Date.now()): Job | null {
  return tx(db, () => {
    const r = get<JobRow>(
      db,
      `SELECT id, type, payload, dedupe_key, attempts, max_attempts, run_at FROM jobs
       WHERE (status = 'queued' AND run_at <= ?) OR (status = 'running' AND locked_until <= ?)
       ORDER BY run_at, id LIMIT 1`,
      now, now,
    );
    if (!r) return null;
    run(db, "UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = ?, updated_at = ? WHERE id = ?", now + LEASE_MS, now, r.id);
    return {
      id: r.id, type: r.type, payload: JSON.parse(r.payload), dedupeKey: r.dedupe_key,
      attempts: r.attempts + 1, maxAttempts: r.max_attempts, runAt: r.run_at,
    };
  });
}

export const backoffMs = (attempt: number, rand = Math.random()) =>
  Math.min(60 * 60_000, 30_000 * 2 ** (attempt - 1)) * (0.75 + rand * 0.5);

export function markDone(db: Db, id: number, now = Date.now()) {
  run(db, "UPDATE jobs SET status = 'done', locked_until = NULL, last_error = NULL, updated_at = ? WHERE id = ?", now, id);
}

export function markFailed(db: Db, job: Job, err: unknown, now = Date.now()) {
  const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  if (job.attempts >= job.maxAttempts) {
    run(db, "UPDATE jobs SET status = 'failed', locked_until = NULL, last_error = ?, updated_at = ? WHERE id = ?", msg, now, job.id);
  } else {
    run(
      db,
      "UPDATE jobs SET status = 'queued', run_at = ?, locked_until = NULL, last_error = ?, updated_at = ? WHERE id = ?",
      now + backoffMs(job.attempts), msg, now, job.id,
    );
  }
}

/** Runs one due job. Returns true if a job was processed (success or failure). */
export async function processOne(db: Db = getDb(), now = Date.now()): Promise<boolean> {
  const job = claimNext(db, now);
  if (!job) return false;
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
    await handler(job, { db, now });
    markDone(db, job.id, now);
  } catch (e) {
    markFailed(db, job, e, now);
  }
  return true;
}

export async function drain(db: Db = getDb(), now = Date.now(), max = 1000): Promise<number> {
  let n = 0;
  while (n < max && (await processOne(db, now))) n++;
  return n;
}

export function queueStats(db: Db = getDb()) {
  return all<{ status: string; n: number }>(db, "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status");
}
