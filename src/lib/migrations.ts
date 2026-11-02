/**
 * Ordered, append-only. Never edit an applied migration; add a new one.
 * All instants are INTEGER epoch milliseconds (UTC). Local wall-clock concepts
 * (weekly hours, holidays) are stored as minutes-from-midnight / YYYY-MM-DD in the
 * business time zone and resolved to UTC at query time, so DST is handled in one place.
 */
export const MIGRATIONS: string[] = [
  /* 1: core */ `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 720 AND duration_min % 5 = 0),
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  buffer_before_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_min >= 0 AND buffer_before_min % 5 = 0),
  buffer_after_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_min >= 0 AND buffer_after_min % 5 = 0),
  deposit_minor INTEGER NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0 AND deposit_minor <= price_minor),
  slot_interval_min INTEGER CHECK (slot_interval_min IS NULL OR (slot_interval_min BETWEEN 5 AND 240 AND slot_interval_min % 5 = 0)),
  create_meet INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- kind 'work' = bookable hours, 'break' = carved out of work hours.
-- weekday is ISO (1=Mon .. 7=Sun). Several rows per weekday may overlap; they are unioned.
-- service_id NULL = applies to every service. A service that has its own 'work' rows uses
-- those INSTEAD of the global ones; breaks are always additive.
CREATE TABLE availability_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1440),
  end_min INTEGER NOT NULL CHECK (end_min BETWEEN 0 AND 1440),
  kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work','break')),
  service_id TEXT REFERENCES services(id) ON DELETE CASCADE,
  CHECK (end_min > start_min)
);

-- date (YYYY-MM-DD, business tz). kind 'closed' = holiday/day off (start/end NULL).
-- kind 'open' = custom hours that REPLACE the weekly rules for that date.
-- yearly=1 repeats on the same month/day every year (e.g. 12-25).
CREATE TABLE date_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind TEXT NOT NULL CHECK (kind IN ('closed','open')),
  start_min INTEGER,
  end_min INTEGER,
  label TEXT NOT NULL DEFAULT '',
  yearly INTEGER NOT NULL DEFAULT 0,
  CHECK ((kind = 'closed' AND start_min IS NULL AND end_min IS NULL)
      OR (kind = 'open' AND start_min IS NOT NULL AND end_min IS NOT NULL AND end_min > start_min))
);
CREATE INDEX idx_date_exceptions_date ON date_exceptions(date);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  block_start INTEGER NOT NULL,
  block_end INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_payment','confirmed','cancelled','completed','no_show')),
  customer_tz TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  price_minor INTEGER NOT NULL DEFAULT 0,
  deposit_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  payment_status TEXT NOT NULL DEFAULT 'none' CHECK (payment_status IN ('none','pending','paid','refunded','refund_needed')),
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  hold_expires_at INTEGER,
  google_event_id TEXT,
  meet_url TEXT,
  cancelled_at INTEGER,
  cancel_reason TEXT,
  cancelled_by TEXT CHECK (cancelled_by IS NULL OR cancelled_by IN ('customer','owner','system','google')),
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (end_at > start_at),
  CHECK (block_start <= start_at AND block_end >= end_at)
);
CREATE INDEX idx_bookings_start ON bookings(start_at);
CREATE INDEX idx_bookings_status_start ON bookings(status, start_at);
CREATE INDEX idx_bookings_customer ON bookings(customer_id);
CREATE UNIQUE INDEX idx_bookings_razorpay_order ON bookings(razorpay_order_id) WHERE razorpay_order_id IS NOT NULL;
-- A given Google event can back at most one booking.
CREATE UNIQUE INDEX idx_bookings_google_event ON bookings(google_event_id) WHERE google_event_id IS NOT NULL;

-- THE double-booking guarantee. Every active booking claims one row per 5-minute unit of
-- its blocked window (appointment + buffers). The PRIMARY KEY makes any overlap, however
-- the two bookings are shaped, a constraint violation the database rejects by itself.
CREATE TABLE slot_locks (
  unit_start INTEGER PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE
);
CREATE INDEX idx_slot_locks_booking ON slot_locks(booking_id);
`,
  /* 2: queue, notifications, payments, google */ `
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  locked_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_due ON jobs(status, run_at);

-- Idempotency ledger for outbound messages: one row per (booking, kind, channel, appointment start).
CREATE TABLE notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  start_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending','sent','failed','skipped')),
  provider_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (booking_id, kind, channel, start_at)
);

-- Webhook de-duplication: provider event id is the primary key.
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  outcome TEXT
);

CREATE TABLE google_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  refresh_token_enc TEXT NOT NULL,
  access_token_enc TEXT,
  access_expires_at INTEGER,
  sync_token TEXT,
  last_synced_at INTEGER,
  connected_at INTEGER NOT NULL
);

-- Events from the owner's Google calendar that are NOT our bookings; they block slots.
CREATE TABLE external_busy (
  event_id TEXT PRIMARY KEY,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_external_busy_range ON external_busy(start_at, end_at);
`,
];
