import { z } from "zod";
import { getDb, all, get, run, isUniqueViolation, type Db } from "./db";
import { newId } from "./ids";

export type Service = {
  id: string;
  slug: string;
  name: string;
  description: string;
  durationMin: number;
  priceMinor: number;
  currency: string;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  depositMinor: number;
  slotIntervalMin: number | null;
  createMeet: boolean;
  location: string;
  active: boolean;
  sortOrder: number;
};

type ServiceRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  duration_min: number;
  price_minor: number;
  currency: string;
  buffer_before_min: number;
  buffer_after_min: number;
  deposit_minor: number;
  slot_interval_min: number | null;
  create_meet: number;
  location: string;
  active: number;
  sort_order: number;
};

const toService = (r: ServiceRow): Service => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  durationMin: r.duration_min,
  priceMinor: r.price_minor,
  currency: r.currency,
  bufferBeforeMin: r.buffer_before_min,
  bufferAfterMin: r.buffer_after_min,
  depositMinor: r.deposit_minor,
  slotIntervalMin: r.slot_interval_min,
  createMeet: !!r.create_meet,
  location: r.location,
  active: !!r.active,
  sortOrder: r.sort_order,
});

const five = (label: string) => z.number().int().multipleOf(5, `${label} must be a multiple of 5 minutes`);

export const serviceInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and dashes"),
    description: z.string().trim().max(1000).default(""),
    durationMin: five("Duration").min(5).max(720),
    priceMinor: z.number().int().min(0).max(100_000_00_00),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("INR"),
    bufferBeforeMin: five("Buffer").min(0).max(240).default(0),
    bufferAfterMin: five("Buffer").min(0).max(240).default(0),
    depositMinor: z.number().int().min(0).default(0),
    slotIntervalMin: five("Slot interval").min(5).max(240).nullable().default(null),
    createMeet: z.boolean().default(false),
    location: z.string().trim().max(200).default(""),
    active: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .refine((v) => v.depositMinor <= v.priceMinor, { path: ["depositMinor"], message: "Deposit cannot exceed the price" });

export type ServiceInput = z.input<typeof serviceInputSchema>;

export class SlugTakenError extends Error {
  constructor() {
    super("That URL slug is already used by another service");
  }
}

export function listServices(opts: { activeOnly?: boolean } = {}, db: Db = getDb()): Service[] {
  const rows = all<ServiceRow>(
    db,
    `SELECT * FROM services ${opts.activeOnly ? "WHERE active = 1" : ""} ORDER BY sort_order, name`,
  );
  return rows.map(toService);
}

export function getServiceBySlug(slug: string, db: Db = getDb()): Service | null {
  const r = get<ServiceRow>(db, "SELECT * FROM services WHERE slug = ?", slug);
  return r ? toService(r) : null;
}

export function getServiceById(id: string, db: Db = getDb()): Service | null {
  const r = get<ServiceRow>(db, "SELECT * FROM services WHERE id = ?", id);
  return r ? toService(r) : null;
}

export function createService(input: ServiceInput, db: Db = getDb()): Service {
  const v = serviceInputSchema.parse(input);
  const id = newId();
  try {
    run(
      db,
      `INSERT INTO services (id, slug, name, description, duration_min, price_minor, currency, buffer_before_min,
        buffer_after_min, deposit_minor, slot_interval_min, create_meet, location, active, sort_order, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, v.slug, v.name, v.description, v.durationMin, v.priceMinor, v.currency, v.bufferBeforeMin,
      v.bufferAfterMin, v.depositMinor, v.slotIntervalMin, v.createMeet ? 1 : 0, v.location, v.active ? 1 : 0,
      v.sortOrder, Date.now(),
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new SlugTakenError();
    throw e;
  }
  return getServiceById(id, db)!;
}

export function updateService(id: string, input: ServiceInput, db: Db = getDb()): Service {
  const v = serviceInputSchema.parse(input);
  try {
    const res = run(
      db,
      `UPDATE services SET slug=?, name=?, description=?, duration_min=?, price_minor=?, currency=?, buffer_before_min=?,
        buffer_after_min=?, deposit_minor=?, slot_interval_min=?, create_meet=?, location=?, active=?, sort_order=?
       WHERE id = ?`,
      v.slug, v.name, v.description, v.durationMin, v.priceMinor, v.currency, v.bufferBeforeMin,
      v.bufferAfterMin, v.depositMinor, v.slotIntervalMin, v.createMeet ? 1 : 0, v.location, v.active ? 1 : 0,
      v.sortOrder, id,
    );
    if (res.changes === 0) throw new Error("Service not found");
  } catch (e) {
    if (isUniqueViolation(e)) throw new SlugTakenError();
    throw e;
  }
  return getServiceById(id, db)!;
}

/** Services with bookings are archived (active = 0), never hard-deleted, so history stays intact. */
export function deleteOrArchiveService(id: string, db: Db = getDb()): "deleted" | "archived" {
  const used = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM bookings WHERE service_id = ?", id)!;
  if (used.n > 0) {
    run(db, "UPDATE services SET active = 0 WHERE id = ?", id);
    return "archived";
  }
  run(db, "DELETE FROM services WHERE id = ?", id);
  return "deleted";
}

export const formatMoney = (minor: number, currency = "INR", locale = "en-IN") =>
  new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
