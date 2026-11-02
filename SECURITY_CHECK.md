# Security check

Scope: the production build of this app (Next.js 16.4.3, Turbopack), plus a comparison with one reference app.
Date: 2026-11-02.

**About the tool.** The brief said `[RE_TOOL]`, which was an unfilled placeholder. I assumed the connected **REA**
reverse-engineering MCP server. Everything below says which check used REA and which used ordinary tools
(grep, curl, Playwright, `npm audit`). If you meant a different tool, only the "REA" rows would need repeating.

## Result

One real weakness found and fixed. Nothing else exploitable found. No secrets in the shipped output.

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | `script-src` allowed `'unsafe-inline'`, so any injected inline script would have executed | Medium (defence in depth; no injection sink exists today) | **Fixed.** `src/proxy.ts` issues a fresh nonce per request; `script-src` is now `'self' 'nonce-…' https://checkout.razorpay.com`. Unit tests pin the policy; e2e proves a new nonce per response, zero violations on public and owner pages, and that an injected inline script is blocked. Found by reading the live response headers, not by REA. |

## What was checked

| Check | Tool | Outcome |
|-------|------|---------|
| Client bundle network surface (6 of 13 files: my two feature chunks and the small shared ones; 0 parse failures) | **REA** `analyze_javascript_application`, `trace_application_feature` | Exactly 7 endpoints, all public API: `POST /api/bookings`, `/api/bookings/{id}/{cancel,reschedule,pay,pay/verify}`, `GET /api/slots`. No admin endpoints. Matches the source. |
| Client bundle: storage, cookies, `eval`, `process.env`, third-party URLs | grep over all 13 client files | None of the first four. Only third-party URL is `checkout.razorpay.com`. `dangerouslySetInnerHTML` appears only inside React/Next, never in `src/`. |
| Database schema (what is persisted) | **REA** `inspect_sqlite_database` | No password or API-key columns. Only credential-bearing columns are Google tokens, stored AES-256-GCM encrypted (`*_enc`). `webhook_events` keeps ids only. |
| Leaked secrets | grep/Node over 544 production files and 512 dev-build files | None: my real `APP_SECRET`/`ADMIN_PASSWORD`, the e2e ones, and generic key patterns (Razorpay, Google, AWS, GitHub, Slack, JWT, private keys). **Limit:** only these two secrets exist in my local `.env`; Razorpay/Google/Twilio values were empty, so those couldn't be searched for by value. |
| Source maps | file listing | None shipped. |
| Live server probes (prod build) | curl | `/.env`, `/data/*.db`, `package.json`, `.git`, `src/…`, `..` traversal → all 404. Error responses leak no stack or paths. No CORS headers. Wrong methods → 405. Headers present: CSP, nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy, HSTS (prod). |
| Session cookie | Playwright login against the prod build | `HttpOnly`, `Secure`, `SameSite=Lax`, ~12 h. |
| Dependencies | `npm audit` | 0 vulnerabilities (production and dev). |
| Auth, validation, rate limiting, double-booking | Playwright + Vitest | Covered by the 28 e2e and 137 unit tests (forged cookie, anonymous export/Google routes refused, oversized/non-JSON bodies, honeypot, 429 with `Retry-After`, tampered manage token). |

## Accepted / residual

- `style-src 'unsafe-inline'` stays: React renders inline `style=""` attributes and a nonce can't cover attributes. Injected CSS cannot execute code.
- No CSRF token. Protection is `SameSite=Lax`, JSON-only public POSTs (a form can't send them), signed per-booking tokens, and Next's built-in Origin check on server actions. Easy!Appointments uses explicit tokens; mine is adequate for one owner but a token would be belt-and-braces.
- Rate limiting is in memory and per process. Behind a proxy set `TRUST_PROXY=1`, otherwise all visitors share one bucket.
- One admin password, no 2FA.

## Not done (said plainly)

- **No live accounts.** Razorpay, Google, Twilio and WhatsApp were exercised only against stubs/fakes, so signature handling, OAuth and API response shapes are untested against the real services.
- **REA coverage was partial.** A first run over the whole client directory hit REA's 300 s per-file limit (the React DOM, core-js and Next runtime chunks). I re-ran on the 6 files that hold app code and shared glue; the 7 unselected files are core-js, the Next runtime, React DOM, the Turbopack runtime, one CSS file and two Next-generated manifests. (That build had 13 client files; the later nonce build adds one tiny manifest from the proxy, and the app chunks are byte-identical by content-hash name.) REA reports its graph as partial, so "not found" from REA means "not observed", and the grep rows above cover what it left unknown.
- **No mobile wrapper was built**, so there is no APK to analyse.
- **Server-side code was not analysed with REA**; it was reviewed through tests, the DB schema, and the output scans.

## Reference apps

- **Easy!Appointments 1.6.1** (release zip, sha256 `1671014c…095042f2`): REA parsed 170 first-party JS files (`assets/js`, graph partial; 36,647 semantic unknowns). Its route view came back empty because URLs are built through a `siteUrl()` helper, not literals, so I read the public endpoints from source: `booking/get_available_hours`, `get_unavailable_dates`, `register`, `privacy/delete_personal_information`. Observed: CSRF token sent on every write; server config `csrf_protection = true`, `cookie_httponly = true`; an ALTCHA captcha on booking; **the whole booking form (name, email, phone, address, custom fields) is persisted in plaintext `localStorage`** (I did not trace whether a checkbox gates it). Lessons taken: my app stores nothing client-side. Gaps it highlights in mine: no customer-initiated personal-data deletion, and rate-limit + honeypot instead of a captcha.
- **Cal.com and Rallly:** not built and not analysed with REA. Both are large monorepos; building them was out of proportion for this task.
