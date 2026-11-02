import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { Monogram } from "@/components/SiteChrome";
import { Alert, Lock } from "@/components/icons";
import { isAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { loginAction } from "../actions";

export const metadata: Metadata = { title: "Admin sign in", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await isAdmin()) redirect("/admin");
  const { error } = await searchParams;
  const { businessName } = getSettings();
  return (
    <main className="gutter mx-auto grid min-h-screen w-full max-w-md place-items-center py-12">
      <form action={loginAction} className="panel w-full space-y-6 p-8 sm:p-10">
        <div>
          <Monogram name={businessName} size="3rem" />
          <h1 className="mt-6 text-fluid-xl font-medium">Owner sign in</h1>
          <p className="mt-2 text-slate-500">Manage bookings, services and availability for {businessName}.</p>
        </div>
        {error && (
          <p className="flex items-start gap-2 rounded-[var(--radius-tile)] border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700" role="alert">
            <Alert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}
        <div>
          <label htmlFor="password" className="label">Password</label>
          <input id="password" name="password" type="password" className="input" autoComplete="current-password" required autoFocus />
        </div>
        <button className="btn-primary w-full">Sign in</button>
        <p className="flex items-center justify-center gap-2 text-sm text-slate-500"><Lock className="size-4" />Only the owner has a login.</p>
      </form>
    </main>
  );
}
