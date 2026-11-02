import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, closeDb, type Db } from "@/lib/db";
import { createService, type ServiceInput, type Service } from "@/lib/services";
import { saveSettings, type Settings } from "@/lib/settings";
import { run } from "@/lib/db";

export type TestDb = { db: Db; file: string; cleanup: () => void };

/** A fresh, migrated SQLite file per test file (real file so multi-connection locking is genuine). */
export function makeTestDb(prefix = "booking-test"): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const file = path.join(dir, "test.db");
  const db = getDb(file);
  return {
    db,
    file,
    cleanup() {
      closeDb(file);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function seedBasic(db: Db, opts: { settings?: Partial<Settings>; service?: Partial<ServiceInput> } = {}): Service {
  saveSettings(
    { timezone: "UTC", minNoticeMin: 0, maxAdvanceDays: 365, slotIntervalMin: 30, businessName: "Test Clinic", ...opts.settings },
    db,
  );
  // Mon-Fri 09:00-17:00
  for (let d = 1; d <= 5; d++) run(db, "INSERT INTO availability_rules (weekday, start_min, end_min, kind) VALUES (?,?,?, 'work')", d, 9 * 60, 17 * 60);
  return createService({ name: "Consultation", slug: "consult", durationMin: 30, priceMinor: 50000, ...opts.service }, db);
}
