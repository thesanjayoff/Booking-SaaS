import { z } from "zod";
import { DateTime } from "luxon";
import { getDb, all, run, tx, type Db } from "./db";

export const isValidZone = (tz: string) => DateTime.local().setZone(tz).isValid;

export const settingsSchema = z.object({
  businessName: z.string().trim().min(1).max(100),
  tagline: z.string().trim().max(200),
  timezone: z.string().refine(isValidZone, "Unknown time zone"),
  ownerEmail: z.string().trim().email().or(z.literal("")),
  address: z.string().trim().max(300),
  phone: z.string().trim().max(40),
  /** Customers cannot book sooner than this many minutes from now. */
  minNoticeMin: z.number().int().min(0).max(60 * 24 * 30),
  /** Customers cannot book further out than this many days. */
  maxAdvanceDays: z.number().int().min(1).max(3650),
  /** Default gap between offered start times. Services may override. */
  slotIntervalMin: z.number().int().min(5).max(240).multipleOf(5),
  /** Customers may cancel/reschedule up to this many hours before the start. 0 = anytime. */
  cancelCutoffHours: z.number().int().min(0).max(24 * 14),
  /** How long an unpaid (pending_payment) booking holds its slot. */
  holdMinutes: z.number().int().min(5).max(120),
  /** Reminders go out this many minutes before the start. */
  reminderOffsetsMin: z.array(z.number().int().min(5).max(60 * 24 * 14)).max(4),
  reminderChannels: z.array(z.enum(["email", "sms", "whatsapp"])),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  businessName: "My Practice",
  tagline: "",
  timezone: "Asia/Kolkata",
  ownerEmail: "",
  address: "",
  phone: "",
  minNoticeMin: 120,
  maxAdvanceDays: 60,
  slotIntervalMin: 30,
  cancelCutoffHours: 12,
  holdMinutes: 15,
  reminderOffsetsMin: [24 * 60, 120],
  reminderChannels: ["email"],
};

export function getSettings(db: Db = getDb()): Settings {
  const rows = all<{ key: string; value: string }>(db, "SELECT key, value FROM settings");
  const stored: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      stored[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore corrupt row, fall back to default */
    }
  }
  const merged = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...stored });
  return merged.success ? merged.data : DEFAULT_SETTINGS;
}

export function saveSettings(patch: Partial<Settings>, db: Db = getDb()): Settings {
  const next = settingsSchema.parse({ ...getSettings(db), ...patch });
  tx(db, () => {
    for (const [k, v] of Object.entries(next)) {
      run(db, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, JSON.stringify(v));
    }
  });
  return next;
}
