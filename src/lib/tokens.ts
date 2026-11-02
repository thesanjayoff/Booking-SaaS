import { createHmac, timingSafeEqual, createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { env } from "./env";

/** Domain-separated HMAC so a token minted for one purpose can never be replayed for another. */
export function hmac(purpose: string, data: string): string {
  return createHmac("sha256", env().APP_SECRET).update(`${purpose}\n${data}`).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Hash first so differing lengths don't short-circuit (and don't throw in timingSafeEqual).
  return timingSafeEqual(createHash("sha256").update(ab).digest(), createHash("sha256").update(bb).digest()) && ab.length === bb.length;
}

/** Stateless capability token for a booking's confirmation / cancel / reschedule page. */
export const manageToken = (bookingId: string) => hmac("manage", bookingId);
export const verifyManageToken = (bookingId: string, token: string | null | undefined) =>
  typeof token === "string" && token.length > 0 && token.length < 200 && safeEqual(manageToken(bookingId), token);

export function manageUrl(bookingId: string, path: "" | "/reschedule" | "/cancel" = ""): string {
  const base = env().APP_URL.replace(/\/$/, "");
  return `${base}/booking/${bookingId}${path}?t=${manageToken(bookingId)}`;
}

/* ---------- admin session cookie: "<expiry>.<nonce>.<sig>" ---------- */
export const SESSION_COOKIE = "admin_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function signSession(now = Date.now()): string {
  const body = `${now + SESSION_TTL_MS}.${randomBytes(8).toString("base64url")}`;
  return `${body}.${hmac("session", body)}`;
}

export function verifySession(value: string | undefined | null, now = Date.now()): boolean {
  if (!value || value.length > 200) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts;
  if (!safeEqual(hmac("session", `${exp}.${nonce}`), sig)) return false;
  return Number(exp) > now;
}

/* ---------- AES-256-GCM for secrets stored in the DB (Google tokens) ---------- */
const key = () => createHash("sha256").update(`enc\n${env().APP_SECRET}`).digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
