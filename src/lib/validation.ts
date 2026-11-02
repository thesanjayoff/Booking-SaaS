import { z } from "zod";
import { isValidZone } from "./settings";

export const timezone = z.string().max(64).refine(isValidZone, "Unknown time zone");

/** E.164-ish: optional +, 7-15 digits after stripping spaces, dashes, dots and brackets. */
export const phone = z
  .string()
  .trim()
  .max(30)
  .transform((v) => v.replace(/[\s().-]/g, ""))
  .refine((v) => v === "" || /^\+?[0-9]{7,15}$/.test(v), "Enter a valid phone number, e.g. +91 98765 43210");

export const createBookingSchema = z.object({
  service: z.string().trim().min(1).max(60),
  start: z.string().datetime({ offset: true }),
  name: z.string().trim().min(1, "Please enter your name").max(100),
  email: z.string().trim().toLowerCase().max(254).email("Enter a valid email address"),
  phone: phone.default(""),
  notes: z.string().trim().max(1000).default(""),
  timezone,
  idempotencyKey: z.string().uuid().optional(),
  /** Honeypot: real users never see this field. */
  website: z.string().max(0).optional(),
});

export const manageSchema = z.object({ t: z.string().min(1).max(200) });
export const cancelSchema = manageSchema.extend({ reason: z.string().trim().max(300).default("") });
export const rescheduleSchema = manageSchema.extend({ start: z.string().datetime({ offset: true }) });

export const slotsQuerySchema = z.object({
  service: z.string().trim().min(1).max(60),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  reschedule: z.string().max(40).optional(),
  t: z.string().max(200).optional(),
});

export const MAX_SLOT_RANGE_DAYS = 45;
