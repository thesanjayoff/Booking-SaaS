import { get, run, tx, type Db } from "../db";
import { getAdapter, PermanentSendError, type Channel, type Outgoing } from "./adapters";

export type DeliverResult = "sent" | "duplicate" | "skipped" | "failed_permanently";

/**
 * Sends at most one message per (booking, kind, channel, appointment start), ever.
 *
 *   ledger row 'sent' / 'skipped'  -> never sent again (duplicate-proof, even if the job re-runs)
 *   ledger row 'failed' / 'sending'-> a retry is allowed (transient failure, or a crash mid-send)
 *   transient error                -> row marked failed, error rethrown so the queue retries with backoff
 *   permanent error                -> row marked failed, NOT rethrown (retrying cannot help)
 *
 * Residual risk, inherent to any at-least-once sender: a crash in the instant between the provider
 * accepting the message and our "sent" write can cause one repeat on retry.
 */
export async function deliver(
  db: Db,
  a: { bookingId: string; kind: string; channel: Channel; startAt: number; to: string | null; message: Outgoing | null },
  now = Date.now(),
): Promise<DeliverResult> {
  const where = [a.bookingId, a.kind, a.channel, a.startAt] as const;

  const claim = tx(db, () => {
    const row = get<{ id: number; status: string }>(db, "SELECT id, status FROM notification_log WHERE booking_id = ? AND kind = ? AND channel = ? AND start_at = ?", ...where);
    if (!row) {
      run(db, "INSERT INTO notification_log (booking_id, kind, channel, start_at, status, created_at, updated_at) VALUES (?,?,?,?, 'sending', ?, ?)", ...where, now, now);
      return "send" as const;
    }
    if (row.status === "sent" || row.status === "skipped") return "done" as const;
    run(db, "UPDATE notification_log SET status = 'sending', updated_at = ? WHERE id = ?", now, row.id);
    return "send" as const;
  });
  if (claim === "done") return "duplicate";

  const mark = (status: string, extra: { providerId?: string; error?: string } = {}) =>
    run(db, "UPDATE notification_log SET status = ?, provider_id = ?, error = ?, updated_at = ? WHERE booking_id = ? AND kind = ? AND channel = ? AND start_at = ?",
      status, extra.providerId ?? null, extra.error ?? null, Date.now(), ...where);

  const adapter = getAdapter(a.channel);
  if (!a.to || !a.message) return (mark("skipped", { error: "no recipient for this channel" }), "skipped");
  if (!adapter.configured()) return (mark("skipped", { error: `${a.channel} is not configured` }), "skipped");

  try {
    const r = await adapter.send({ ...a.message, to: a.to });
    mark("sent", { providerId: r.providerId });
    return "sent";
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    mark("failed", { error });
    if (e instanceof PermanentSendError) return "failed_permanently";
    throw e;
  }
}
