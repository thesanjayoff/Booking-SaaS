import { notFound } from "next/navigation";
import type { Metadata } from "next";
import BookingFlow from "@/components/BookingFlow";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { getDb } from "@/lib/db";
import { formatMoney, getServiceBySlug } from "@/lib/services";
import { getSettings } from "@/lib/settings";
import { paymentsEnabled } from "@/lib/payments/config";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const s = getServiceBySlug(slug);
  return { title: s ? `Book ${s.name}` : "Book an appointment" };
}

export default async function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDb();
  const service = getServiceBySlug(slug, db);
  if (!service || !service.active) notFound();
  const settings = getSettings(db);
  const depositOn = paymentsEnabled() && service.depositMinor > 0;

  return (
    <>
      <SiteHeader settings={settings} back={{ href: "/", label: "All services" }} />
      <main className="gutter mx-auto w-full max-w-[1120px] py-8 sm:py-12">
        <BookingFlow
          businessName={settings.businessName}
          businessTimezone={settings.timezone}
          maxAdvanceDays={settings.maxAdvanceDays}
          service={{
            slug: service.slug,
            name: service.name,
            description: service.description,
            durationMin: service.durationMin,
            priceLabel: service.priceMinor > 0 ? formatMoney(service.priceMinor, service.currency) : "Free",
            depositLabel: depositOn ? formatMoney(service.depositMinor, service.currency) : null,
            createMeet: service.createMeet,
            location: service.location,
          }}
        />
      </main>
      <SiteFooter settings={settings} />
    </>
  );
}
