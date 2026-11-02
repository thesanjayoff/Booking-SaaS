# Booking app

A personal booking and scheduling app — a small Calendly / Cal.com for one owner and one public booking
page. No plans, billing or multi-tenancy. The demo data is a family clinic.

- **Public site** — pick a service, pick a slot (shown in the visitor's time zone), enter details, get a
  confirmation page with `.ics`, cancel and reschedule links.
- **Owner dashboard** (`/admin`) — today's bookings, week/month calendar, revenue, cancellations,
  customers, services, availability rules, settings, CSV export.
- **Availability engine** — weekly hours, breaks, holidays (one-off and yearly), per-service hours,
  buffers, minimum notice, booking horizon, time zones and DST. Times are stored in UTC.
- **No double-booking** — every write is a `BEGIN IMMEDIATE` transaction, and a `slot_locks` table with a
  primary key per 5-minute unit makes any overlap a constraint violation.
- **Razorpay deposits** (off by default), **Google Calendar two-way sync** with optional Meet links,
  **reminders** by email / SMS / WhatsApp through a retrying job queue.

## Run it

Requires **Node 22.13+** (it uses the built-in `node:sqlite`; nothing native to compile).

```bash
npm install
cp .env.example .env          # then edit: APP_SECRET, ADMIN_PASSWORD, APP_URL
npm run seed                  # demo clinic: 5 services, hours, holidays, ~100 bookings
npm run dev                   # http://localhost:3000   (admin: /admin)
```

Generate a secret with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
`npm run seed -- --reset` wipes the database first.

Production:

```bash
npm run build
npm start                     # set RUN_WORKER=1 (default) so reminders and sync run in-process
```

To run the background worker as its own process instead, set `RUN_WORKER=0` on the web server and run
`npm run worker` next to it. Run only **one** worker per database.

### Tests

```bash
npm test            # 137 unit/integration tests (Vitest)
npm run test:e2e    # 28 browser + API tests (Playwright)
npm run typecheck
```

The e2e suite builds the app into `.next-e2e`, serves it on port 3210 with a throwaway database
(`data/e2e.db`) and the worker disabled, so it never touches your dev server or real data. First run:
`npx playwright install chromium`.

What the tests cover:

| Area | File | Highlights |
| --- | --- | --- |
| Availability engine | `tests/availability.test.ts` | DST spring-forward and fall-back, overlapping rules, breaks, holidays, buffers, notice, horizon |
| Booking flow | `tests/booking.test.ts` | create / cancel / reschedule, idempotency keys, deposit holds |
| Double-booking | `tests/concurrency.test.ts` | 50 simultaneous attempts on one slot, 24 separate OS processes, overlapping slots, plus a raw-SQL test proving the constraint alone blocks overlaps |
| Payments | `tests/payments.test.ts` | signatures, webhook replay, out-of-order and late payments, refunds |
| Reminders | `tests/reminders.test.ts` | retries with backoff, no duplicate sends, permanent errors, lease reclaim |
| Google sync | `tests/google.test.ts` | against an in-memory fake of the Calendar API |
| End to end | `tests/e2e/` | full booking flow, two browsers racing for one slot, admin screens, access control, headers, rate limiting |

## Configuration

Everything secret lives in environment variables (`.env` is git-ignored). See `.env.example`.

| Variable | Purpose |
| --- | --- |
| `APP_SECRET` | **Required**, ≥ 32 chars. Signs the admin session and cancel/reschedule links; encrypts Google tokens at rest. Changing it invalidates existing links and the stored Google connection. |
| `ADMIN_PASSWORD` | **Required.** The single owner's password for `/admin`. |
| `APP_URL` | **Required.** Public base URL, used in emails and the OAuth redirect. |
| `DATABASE_PATH` | SQLite file (default `./data/app.db`). Back this file up. |
| `TRUST_PROXY` | Set to `1` only when behind a reverse proxy that sets `X-Forwarded-For`; otherwise all visitors share one rate-limit bucket. |
| `RUN_WORKER` | `1` (default) runs the job worker inside the web server; `0` to run `npm run worker` separately. |
| `SMTP_*`, `MAIL_FROM`, `OWNER_NOTIFY_EMAIL` | Email. With no `SMTP_HOST`, messages are written as JSON files to `data/outbox/` — handy for development. |
| `TWILIO_*` | SMS reminders. |
| `WHATSAPP_*` | WhatsApp Cloud API reminders (template messages). |
| `DEFAULT_COUNTRY_CODE` | Country calling code for phone numbers entered without `+` (e.g. `91`). |
| `PAYMENTS_ENABLED`, `RAZORPAY_*` | Deposits. Off unless `PAYMENTS_ENABLED=1` **and** keys are set. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar sync. |

Business settings (name, time zone, notice period, horizon, slot interval, hold time, reminder times and
channels) are edited in **Admin → Settings**, not in env.

### Turn on Razorpay deposits

1. Create API keys and a webhook in the Razorpay dashboard. Webhook URL: `{APP_URL}/api/webhooks/razorpay`;
   events: `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`.
2. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` and `PAYMENTS_ENABLED=1`, restart.
3. In **Admin → Services**, give a service a deposit amount.

The slot is held (default 15 minutes) while the customer pays. The webhook is verified against the raw body
and de-duplicated by Razorpay's event id, so retries and replays are harmless. If a payment lands after the
hold expired, the booking is confirmed if the slot is still free; otherwise the payment is refunded.
While `PAYMENTS_ENABLED` is off, `/api/webhooks/razorpay` returns 404.

### Turn on Google Calendar sync

1. In Google Cloud Console enable the Calendar API and create an OAuth client (Web). Add the redirect URI
   `{APP_URL}/api/google/callback`.
2. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, restart, then **Admin → Settings → Connect Google Calendar**.

Bookings are pushed to your primary calendar (with a Meet link for services that ask for one). Events you
create in Google block those times; deleting a booking's event in Google cancels the booking; moving it
reschedules the booking if the new time is allowed and is reverted otherwise. Free ("transparent"), declined
and cancelled events are ignored.

### Reminders

Set the offsets (default 24 h and 2 h before) and channels in **Admin → Settings**. Each reminder is a job
with a unique key, so a booking is never reminded twice for the same slot, channel and time; a reschedule
replaces the old reminders; failures retry with exponential backoff; permanent provider errors (bad
number, 4xx) are not retried. Failed jobs can be retried from the settings page.

## How it is built

- **Next.js 16** (App Router), React 19, TypeScript, Tailwind v4. **SQLite** through Node's built-in
  `node:sqlite`, no ORM. zod for validation, luxon for time zones.
- **Why SQLite and no Docker / Redis?** One owner, one booking page: a single file database in WAL mode is
  plenty, and the job queue is a table in the same database, so jobs are enqueued *inside* the booking
  transaction (no lost reminders, nothing to keep in sync). Docker was also not available where this was
  built. If you outgrow it, `src/lib/db.ts` is the only place that touches the driver.
- **Time**: all instants are stored as UTC epoch milliseconds. Weekly hours, breaks and holidays are stored
  as wall-clock times in the business time zone and resolved to UTC per date, which is what makes DST work.
- **Security**: strict nonce-based CSP (`src/proxy.ts`) and other headers (`next.config.ts`), zod validation on every route, 32 KB body cap,
  rate limits on public routes, honeypot field, HMAC-signed manage links, signed admin cookie, admin check
  inside every page/action/route (not just the layout), CSV formula-injection protection, secrets only in
  env. See `SECURITY_CHECK.md` for the results of a scan of the built output.

```
src/app/            pages and API routes (public site, /admin, /api)
src/lib/availability  pure slot engine + DB loaders
src/lib/bookings.ts   create / cancel / reschedule inside transactions
src/lib/queue.ts      SQLite job queue (claim, lease, backoff, dedupe)
src/lib/payments/     Razorpay orders, signatures, webhook
src/lib/notify/       email / SMS / WhatsApp adapters, templates, .ics
src/lib/google/       OAuth + two-way sync
scripts/              seed, worker
tests/                unit, integration, concurrency, e2e
```

## Known limits

- Razorpay, Google, Twilio and WhatsApp are implemented against their documented HTTP APIs and covered by
  tests with stubbed HTTP; they have **not** been exercised against live accounts. Try each with test
  credentials before relying on it.
- Rate limiting is in memory, per process — fine for one server, not shared across several.
- Single owner, single calendar, one password. There is no customer login; manage links are the credential.
