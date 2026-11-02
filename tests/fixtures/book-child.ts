/**
 * Child process used by the concurrency tests. Each child has its OWN SQLite connection, so
 * contention goes through real file locking, exactly like separate server processes would.
 *
 * argv: mode file serviceId customerId startAt idx goAt [durationMin]
 *   mode "app" -> full createBooking() path
 *   mode "raw" -> bypasses every app-level availability check and only relies on the
 *                 slot_locks PRIMARY KEY (proves the DB constraint works on its own)
 */
import { DatabaseSync } from "node:sqlite";

const [mode, file, serviceId, customerId, startAtStr, idx, goStr, durStr] = process.argv.slice(2);
const startAt = Number(startAtStr);
const go = Number(goStr);
const durationMin = Number(durStr ?? 30);

const { createBooking } = await import("@/lib/bookings");
const { getDb } = await import("@/lib/db");
const db = getDb(file); // opens + migrates before the starting gun

while (Date.now() < go) {
  /* spin to line all children up on the same instant */
}

try {
  if (mode === "app") {
    const r = createBooking(
      { serviceId, startAt, name: `Racer ${idx}`, email: `racer${idx}@example.com`, timezone: "UTC" },
      { db, paymentsEnabled: false },
    );
    console.log(JSON.stringify({ ok: true, id: r.booking.id }));
  } else {
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA busy_timeout = 30000; PRAGMA foreign_keys = ON");
    const id = `raw-${idx}-${Math.random().toString(36).slice(2)}`;
    const end = startAt + durationMin * 60_000;
    raw.exec("BEGIN"); // deliberately NOT immediate
    try {
      raw
        .prepare(
          `INSERT INTO bookings (id, service_id, customer_id, contact_name, contact_email, start_at, end_at, block_start, block_end,
             status, customer_tz, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?, 'confirmed', 'UTC', 1, 1)`,
        )
        .run(id, serviceId, customerId, "raw", "raw@example.com", startAt, end, startAt, end);
      const ins = raw.prepare("INSERT INTO slot_locks (unit_start, booking_id) VALUES (?, ?)");
      for (let u = startAt; u < end; u += 300_000) ins.run(u, id);
      raw.exec("COMMIT");
      console.log(JSON.stringify({ ok: true, id }));
    } catch (e) {
      try {
        raw.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }
} catch (e: any) {
  console.log(JSON.stringify({ ok: false, error: e?.constructor?.name, reason: e?.reason, message: String(e?.message).slice(0, 200) }));
}
process.exit(0);
