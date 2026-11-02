import { NextResponse } from "next/server";
import { z } from "zod";
import { clientId, rateLimit } from "./ratelimit";

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });

export const apiError = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  json({ error: { code, message } }, status, headers);

const MAX_BODY = 32 * 1024;

/** Parses + validates a JSON body. Throws a Response-ready error object on failure. */
export async function readBody<T extends z.ZodType>(req: Request, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: NextResponse }> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) return { ok: false, res: apiError(415, "unsupported_media_type", "Send application/json") };
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return { ok: false, res: apiError(413, "too_large", "Request body too large") };
  const text = await req.text();
  if (text.length > MAX_BODY) return { ok: false, res: apiError(413, "too_large", "Request body too large") };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, res: apiError(400, "invalid_json", "Body is not valid JSON") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[i.path.join(".") || "_"] ??= i.message;
    return { ok: false, res: json({ error: { code: "validation_failed", message: "Please check the highlighted fields.", fields } }, 422) };
  }
  return { ok: true, data: parsed.data };
}

/** Returns a 429 response when over the limit, otherwise null. */
export function limit(req: Request, name: string, max: number, windowMs: number) {
  const r = rateLimit(`${name}:${clientId(req)}`, max, windowMs);
  return r.ok ? null : apiError(429, "rate_limited", "Too many requests. Please slow down and try again shortly.", { "Retry-After": String(r.retryAfterSec) });
}
