import { env, has } from "../env";
import { get, run, type Db } from "../db";
import { decrypt, encrypt } from "../tokens";

export const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events"];
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";

export const googleConfigured = () => has(env().GOOGLE_CLIENT_ID) && has(env().GOOGLE_CLIENT_SECRET);
export const redirectUri = () => `${env().APP_URL.replace(/\/$/, "")}/api/google/callback`;

export function buildAuthUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: env().GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // always return a refresh token
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH}?${q}`;
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; id_token?: string; error?: string; error_description?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env().GOOGLE_CLIENT_ID!, client_secret: env().GOOGLE_CLIENT_SECRET!, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) throw new GoogleAuthError(data.error_description || data.error || `HTTP ${res.status}`, data.error === "invalid_grant");
  return data;
}

export class GoogleAuthError extends Error {
  constructor(message: string, public revoked = false) {
    super(message);
  }
}

export type Account = {
  email: string;
  calendarId: string;
  syncToken: string | null;
  lastSyncedAt: number | null;
  connectedAt: number;
};

export function getAccount(db: Db): Account | null {
  const r = get<any>(db, "SELECT email, calendar_id, sync_token, last_synced_at, connected_at FROM google_account WHERE id = 1");
  return r ? { email: r.email, calendarId: r.calendar_id, syncToken: r.sync_token, lastSyncedAt: r.last_synced_at, connectedAt: r.connected_at } : null;
}

export const isConnected = (db: Db) => !!get(db, "SELECT 1 FROM google_account WHERE id = 1");

export async function connectWithCode(db: Db, code: string, now = Date.now()): Promise<string> {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new GoogleAuthError("Google did not return a refresh token. Remove the app's access in your Google account and connect again.");
  let email = "unknown";
  try {
    // id_token came straight from Google's token endpoint over TLS, so reading its claims is safe.
    email = JSON.parse(Buffer.from(String(t.id_token).split(".")[1], "base64url").toString("utf8")).email ?? email;
  } catch {
    /* email is cosmetic */
  }
  run(
    db,
    `INSERT INTO google_account (id, email, refresh_token_enc, access_token_enc, access_expires_at, sync_token, last_synced_at, connected_at)
     VALUES (1, ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, refresh_token_enc = excluded.refresh_token_enc,
       access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at, sync_token = NULL, connected_at = excluded.connected_at`,
    email, encrypt(t.refresh_token), encrypt(t.access_token), now + t.expires_in * 1000, now,
  );
  return email;
}

/** A valid access token, refreshing (and persisting) when it is about to expire. */
export async function accessToken(db: Db, now = Date.now()): Promise<string> {
  const r = get<{ refresh_token_enc: string; access_token_enc: string | null; access_expires_at: number | null }>(
    db, "SELECT refresh_token_enc, access_token_enc, access_expires_at FROM google_account WHERE id = 1",
  );
  if (!r) throw new GoogleAuthError("Google Calendar is not connected");
  if (r.access_token_enc && r.access_expires_at && r.access_expires_at - 60_000 > now) return decrypt(r.access_token_enc);
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(r.refresh_token_enc) });
  run(db, "UPDATE google_account SET access_token_enc = ?, access_expires_at = ? WHERE id = 1", encrypt(t.access_token), now + t.expires_in * 1000);
  return t.access_token;
}

export async function disconnect(db: Db) {
  const r = get<{ refresh_token_enc: string }>(db, "SELECT refresh_token_enc FROM google_account WHERE id = 1");
  if (r) {
    // Best effort: tell Google to revoke so the grant disappears from the owner's account too.
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(r.refresh_token_enc))}`, { method: "POST", signal: AbortSignal.timeout(10_000) }).catch(() => null);
  }
  run(db, "DELETE FROM google_account WHERE id = 1");
  run(db, "DELETE FROM external_busy");
  run(db, "UPDATE bookings SET google_event_id = NULL");
}
