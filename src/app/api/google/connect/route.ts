import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api";
import { isAdmin } from "@/lib/auth";
import { buildAuthUrl, googleConfigured } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";
const STATE_COOKIE = "g_oauth_state";

export async function GET() {
  if (!(await isAdmin())) return apiError(401, "unauthorized", "Sign in as the owner first");
  if (!googleConfigured()) return apiError(400, "not_configured", "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first");
  const state = randomBytes(24).toString("base64url");
  const res = NextResponse.redirect(buildAuthUrl(state));
  res.cookies.set(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/google", maxAge: 600 });
  return res;
}
