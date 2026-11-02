import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="mt-2 text-slate-600">The link may be wrong or may have expired.</p>
      <Link href="/" className="btn-primary mt-6">Back to booking</Link>
    </main>
  );
}
