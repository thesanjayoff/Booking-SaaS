import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { getDb, all } from "@/lib/db";
import { connectWithCode } from "@/lib/google/oauth";
import { syncFromGoogle } from "@/lib/google/sync";
import { queueCalendarSync } from "@/lib/bookings";
import { safeEqual } from "@/lib/tokens";

export const dynamic = "force-dynamic";

const back = (kind: "ok" | "error", msg: string) =>
  NextResponse.redirect(`${env().APP_URL.replace(/\/$/, "")}/admin/settings?${kind}=${encodeURIComponent(msg)}`);

export async function GET(req: Request) {
  if (!(await isAdmin())) return NextResponse.redirect(`${env().APP_URL.replace(/\/$/, "")}/admin/login`);
  const url = new URL(req.url);
  const jar = await cookies();
  const expected = jar.get("g_oauth_state")?.value;
  const state = url.searchParams.get("state");
  const res = (r: NextResponse) => (r.cookies.delete({ name: "g_oauth_state", path: "/api/google" }), r);

  if (url.searchParams.get("error")) return res(back("error", `Google said: ${url.searchParams.get("error")}`));
  const code = url.searchParams.get("code");
  // CSRF defence: the state we minted for THIS browser must come back unchanged.
  if (!code || !expected || !state || !safeEqual(expected, state)) return res(back("error", "Google sign-in could not be verified. Please try connecting again."));

  try {
    const db = getDb();
    const email = await connectWithCode(db, code);
    await syncFromGoogle(db).catch((e) => console.error("initial google sync failed", e));
    // Put already-confirmed future bookings on the calendar.
    for (const b of all<{ id: string }>(db, "SELECT id FROM bookings WHERE status = 'confirmed' AND start_at > ? AND google_event_id IS NULL", Date.now())) queueCalendarSync(db, b.id);
    return res(back("ok", `Connected to Google Calendar (${email}).`));
  } catch (e) {
    console.error("google connect failed", e);
    return res(back("error", e instanceof Error ? e.message : "Could not connect to Google."));
  }
}
