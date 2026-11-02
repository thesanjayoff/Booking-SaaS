import Link from "next/link";
import { ArrowLeft } from "@/components/icons";

export default function NotFound() {
  return (
    <main className="gutter mx-auto grid min-h-screen w-full max-w-xl place-items-center py-16">
      <div className="panel w-full p-8 text-center sm:p-12">
        <div aria-hidden className="mx-auto mb-6 h-px w-16 bg-[image:var(--gold-gradient)]" />
        <h1 className="text-fluid-2xl font-medium">Page not found</h1>
        <p className="mx-auto mt-3 max-w-sm text-slate-500">The link may be wrong or may have expired.</p>
        <Link href="/" className="btn-primary mt-8">
          <ArrowLeft className="size-4" />
          Back to booking
        </Link>
      </div>
    </main>
  );
}
