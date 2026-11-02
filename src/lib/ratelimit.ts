import { env } from "./env";

/**
 * In-memory sliding-window limiter (single process; fine for a one-owner app). State is on
 * globalThis so Next dev's module reloads don't reset it.
 *
 * Client identity: X-Forwarded-For is attacker-controlled unless a trusted reverse proxy
 * overwrites it, so it is ONLY honoured when TRUST_PROXY=1. Without it every caller shares
 * one "direct" bucket per route (stricter, but not spoofable). Booking creation additionally
 * limits per e-mail address, which no header trick can dodge.
 */
const g = globalThis as unknown as { __rl?: Map<string, number[]>; __rlSweep?: number };
const buckets = (g.__rl ??= new Map());

export type LimitResult = { ok: boolean; retryAfterSec: number };

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): LimitResult {
  const hits = (buckets.get(key) ?? []).filter((t: number) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000)) };
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000 && now - (g.__rlSweep ?? 0) > 60_000) {
    g.__rlSweep = now;
    for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 3_600_000) buckets.delete(k);
  }
  return { ok: true, retryAfterSec: 0 };
}

export function resetRateLimits() {
  buckets.clear();
}

export function clientIdFromHeaders(h: Pick<Headers, "get">): string {
  if (env().TRUST_PROXY) {
    const first = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (first && first.length <= 64) return first;
    const real = h.get("x-real-ip")?.trim();
    if (real && real.length <= 64) return real;
  }
  return "direct";
}

export const clientId = (req: Request) => clientIdFromHeaders(req.headers);
