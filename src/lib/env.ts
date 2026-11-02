import { z } from "zod";

const bool = z
  .enum(["0", "1", "true", "false", ""])
  .optional()
  .transform((v) => v === "1" || v === "true");

const schema = z.object({
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters"),
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD must be at least 8 characters"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_PATH: z.string().default("./data/app.db"),
  TRUST_PROXY: bool,
  RUN_WORKER: z
    .enum(["0", "1", "true", "false", ""])
    .optional()
    .transform((v) => v !== "0" && v !== "false"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default("Bookings <bookings@localhost>"),
  OWNER_NOTIFY_EMAIL: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_SMS_FROM: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_TEMPLATE_NAME: z.string().default("appointment_reminder"),
  PAYMENTS_ENABLED: bool,
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Parsed lazily so `next build` and tests don't need every secret present. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${msg}. See .env.example`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache() {
  cached = null;
}

/** Treat empty strings from .env files as "unset". */
export const has = (v: string | undefined): v is string => typeof v === "string" && v.trim().length > 0;
