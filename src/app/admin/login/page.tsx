import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { isAdmin } from "@/lib/auth";
import { loginAction } from "../actions";

export const metadata: Metadata = { title: "Admin sign in", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await isAdmin()) redirect("/admin");
  const { error } = await searchParams;
  return (
    <main className="mx-auto grid min-h-screen max-w-sm place-items-center px-4">
      <form action={loginAction} className="card w-full space-y-4 p-6">
        <h1 className="text-xl font-bold">Owner sign in</h1>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
        <div>
          <label htmlFor="password" className="label">Password</label>
          <input id="password" name="password" type="password" className="input" autoComplete="current-password" required autoFocus />
        </div>
        <button className="btn-primary w-full">Sign in</button>
      </form>
    </main>
  );
}
