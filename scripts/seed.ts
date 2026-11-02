import "./load-env";
import { DateTime } from "luxon";
import { getDb, all, get, run } from "@/lib/db";
import { saveSettings } from "@/lib/settings";
import { createService } from "@/lib/services";
import { addException, addRule } from "@/lib/availability/store";
import { getSlots } from "@/lib/availability/store";
import { cancelBooking, createBooking, setOutcome } from "@/lib/bookings";
import { scheduleReminders } from "@/lib/reminders";
import { getSettings } from "@/lib/settings";

const reset = process.argv.includes("--reset");
const db = getDb();

if (get(db, "SELECT 1 FROM services LIMIT 1") && !reset) {
  console.log("Database already has data. Run `npm run seed -- --reset` to wipe and re-seed the demo clinic.");
  process.exit(0);
}
if (reset) {
  for (const t of ["slot_locks", "notification_log", "jobs", "webhook_events", "bookings", "customers", "external_busy", "availability_rules", "date_exceptions", "services", "settings"]) {
    run(db, `DELETE FROM ${t}`);
  }
  console.log("Cleared existing data.");
}

/* ---------------------------------------------------------------- clinic */
const TZ = "Asia/Kolkata";
saveSettings(
  {
    businessName: "Sunrise Family Clinic",
    tagline: "Friendly, unhurried care for the whole family",
    timezone: TZ,
    address: "14, 5th Cross, Indiranagar, Bengaluru",
    phone: "+91 80 4000 1234",
    ownerEmail: process.env.OWNER_NOTIFY_EMAIL || "",
    minNoticeMin: 120,
    maxAdvanceDays: 60,
    slotIntervalMin: 30,
    cancelCutoffHours: 12,
    holdMinutes: 15,
    reminderOffsetsMin: [24 * 60, 120],
    reminderChannels: ["email"],
  },
  db,
);

const services = [
  createService({ name: "General Consultation", slug: "general-consultation", description: "A 30-minute visit with Dr. Mehta for everyday health concerns, prescriptions and follow-ups.", durationMin: 30, priceMinor: 60000, bufferAfterMin: 10, location: "Sunrise Family Clinic, Indiranagar", sortOrder: 1 }, db),
  createService({ name: "Dental Check-up & Cleaning", slug: "dental-checkup", description: "Full examination, scale and polish. Please arrive 5 minutes early.", durationMin: 45, priceMinor: 120000, depositMinor: 30000, bufferBeforeMin: 5, bufferAfterMin: 15, location: "Sunrise Family Clinic, Indiranagar", sortOrder: 2 }, db),
  createService({ name: "Paediatric Visit", slug: "paediatric-visit", description: "Growth checks, vaccinations and common childhood illnesses.", durationMin: 30, priceMinor: 50000, bufferAfterMin: 10, location: "Sunrise Family Clinic, Indiranagar", sortOrder: 3 }, db),
  createService({ name: "Video Consultation", slug: "video-consultation", description: "Talk to the doctor from home. A Google Meet link is sent after booking.", durationMin: 20, priceMinor: 40000, slotIntervalMin: 20, createMeet: true, sortOrder: 4 }, db),
  createService({ name: "Annual Health Screening", slug: "health-screening", description: "Blood work, ECG, BMI and a full review with the doctor.", durationMin: 60, priceMinor: 350000, depositMinor: 100000, bufferAfterMin: 15, location: "Sunrise Family Clinic, Indiranagar", sortOrder: 5 }, db),
];

// Mon-Fri 09:00-17:00 with lunch 13:00-14:00; Sat 09:00-13:00
for (let d = 1; d <= 5; d++) {
  addRule({ weekday: d, startMin: 9 * 60, endMin: 17 * 60, kind: "work" }, db);
  addRule({ weekday: d, startMin: 13 * 60, endMin: 14 * 60, kind: "break" }, db);
}
addRule({ weekday: 6, startMin: 9 * 60, endMin: 13 * 60, kind: "work" }, db);
// Annual screening runs mornings only
for (let d = 1; d <= 5; d++) addRule({ weekday: d, startMin: 9 * 60, endMin: 12 * 60, kind: "work", serviceId: services[4].id }, db);

// National holidays (repeat yearly) + one upcoming staff day off
for (const [date, label] of [["2000-01-26", "Republic Day"], ["2000-08-15", "Independence Day"], ["2000-10-02", "Gandhi Jayanti"], ["2000-12-25", "Christmas"]] as const) {
  addException({ date, kind: "closed", label, yearly: true }, db);
}
addException({ date: DateTime.now().setZone(TZ).plus({ days: 9 }).toISODate()!, kind: "closed", label: "Staff training day" }, db);
addException({ date: DateTime.now().setZone(TZ).plus({ days: 12 }).toISODate()!, kind: "open", startMin: 10 * 60, endMin: 14 * 60, label: "Short day" }, db);

/* ---------------------------------------------------------------- demo bookings */
let seedN = 20260101;
const rnd = () => ((seedN = (seedN * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

const people = [
  ["Priya Nair", "priya.nair@example.com", "+919845012345"], ["Rahul Verma", "rahul.verma@example.com", "+919812398765"],
  ["Ananya Iyer", "ananya.iyer@example.com", "+919900112233"], ["Mohammed Faizan", "faizan.m@example.com", "+919741122334"],
  ["Sneha Kulkarni", "sneha.k@example.com", "+919880055667"], ["Arjun Reddy", "arjun.reddy@example.com", "+919986677889"],
  ["Kavya Menon", "kavya.menon@example.com", "+919448899001"], ["Vikram Singh", "vikram.singh@example.com", ""],
  ["Divya Shetty", "divya.shetty@example.com", "+919591234567"], ["Karthik Raman", "karthik.raman@example.com", "+919008877665"],
  ["Meera Joshi", "meera.joshi@example.com", "+919663322110"], ["Sanjay Patel", "sanjay.patel@example.com", ""],
];
const notes = ["", "", "", "First visit", "Follow-up on last month's prescription", "Mild fever since yesterday", "Routine check", "Bringing my son (6 yrs)"];

const realNow = Date.now();
const today = DateTime.now().setZone(TZ).startOf("day");
let made = 0;

for (let offset = -35; offset <= 14; offset++) {
  const day = today.plus({ days: offset });
  const from = day.toMillis();
  const to = day.plus({ days: 1 }).toMillis();
  const perDay = offset === 0 ? 5 : Math.floor(rnd() * 4) + (offset > 0 ? 1 : 1);
  for (let i = 0; i < perDay; i++) {
    const svc = pick(services);
    const fakeNow = from - 36 * 3600_000; // as if booked a day or two earlier
    const open = getSlots(svc.id, { from, to }, { db, now: fakeNow });
    if (open.length === 0) continue;
    const start = pick(open);
    const [name, email, phone] = pick(people);
    try {
      const { booking } = createBooking(
        { serviceId: svc.id, startAt: start, name, email, phone, notes: pick(notes), timezone: TZ },
        { db, now: fakeNow, paymentsEnabled: false },
      );
      made++;
      if (booking.endAt < realNow) {
        const roll = rnd();
        if (roll < 0.12) cancelBooking(booking.id, { by: rnd() < 0.7 ? "customer" : "owner", reason: pick(["Change of plans", "Feeling better", "Travelling", "Double booked"]), db, now: Math.min(realNow, booking.startAt - 24 * 3600_000) });
        else if (roll < 0.2) setOutcome(booking.id, "no_show", db);
        else setOutcome(booking.id, "completed", db);
      } else if (offset > 0 && rnd() < 0.08) {
        cancelBooking(booking.id, { by: "customer", reason: "Can't make it", db, now: realNow });
      }
    } catch {
      /* slot taken by an earlier demo booking; fine */
    }
  }
}

// Seeding used backdated clocks: drop the jobs it generated, then plan reminders for real upcoming bookings only.
run(db, "DELETE FROM jobs");
const upcoming = all<{ id: string; start_at: number }>(db, "SELECT id, start_at FROM bookings WHERE status = 'confirmed' AND start_at > ?", realNow);
for (const b of upcoming) scheduleReminders(db, { id: b.id, startAt: b.start_at }, getSettings(db), realNow);

console.log(`Seeded Sunrise Family Clinic: ${services.length} services, ${made} demo bookings (${upcoming.length} upcoming).`);
