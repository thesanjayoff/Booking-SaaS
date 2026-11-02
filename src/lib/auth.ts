import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "./env";
import { SESSION_COOKIE, SESSION_TTL_MS, safeEqual, signSession, verifySession } from "./tokens";
import { rateLimit } from "./ratelimit";

export async function isAdmin(): Promise<boolean> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}

/**
 * Call at the top of EVERY admin page, server action and route handler. Layouts do not re-run
 * on server-action invocations, so a layout-only check would leave actions unauthenticated.
 */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) redirect("/admin/login");
}

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function login(password: string, clientKey: string): Promise<LoginResult> {
  // Two buckets: per-client and a global backstop so spoofed client ids cannot enable brute force.
  const a = rateLimit(`login:${clientKey}`, 8, 15 * 60_000);
  const b = rateLimit("login:global", 40, 15 * 60_000);
  if (!a.ok || !b.ok) return { ok: false, error: "Too many attempts. Try again in a few minutes." };
  if (!safeEqual(password, env().ADMIN_PASSWORD)) return { ok: false, error: "Incorrect password." };

  const jar = await cookies();
  jar.set(SESSION_COOKIE, signSession(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return { ok: true };
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
}
