import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import BookingFlow from "@/components/BookingFlow";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { getBooking } from "@/lib/bookings";
import { getServiceById, formatMoney } from "@/lib/services";
import { getSettings } from "@/lib/settings";
import { verifyManageToken } from "@/lib/tokens";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reschedule", robots: { index: false, follow: false } };

export default async function ReschedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { id } = await params;
  const { t } = await searchParams;
  const token = typeof t === "string" ? t : "";
  if (!verifyManageToken(id, token)) notFound();
  const b = getBooking(id);
  if (!b) notFound();
  if (b.status !== "confirmed" || b.startAt <= Date.now()) redirect(`/booking/${id}?t=${encodeURIComponent(token)}`);
  const service = getServiceById(b.serviceId)!;
  const settings = getSettings();

  return (
    <>
      <SiteHeader settings={settings} back={{ href: `/booking/${id}?t=${encodeURIComponent(token)}`, label: "Back to appointment" }} />
      <main className="gutter mx-auto w-full max-w-[1120px] py-8 sm:py-12">
        <BookingFlow
          businessName={settings.businessName}
          businessTimezone={settings.timezone}
          maxAdvanceDays={settings.maxAdvanceDays}
          reschedule={{ id: b.id, token, currentStart: new Date(b.startAt).toISOString() }}
          service={{
            slug: service.slug,
            name: service.name,
            description: "",
            durationMin: service.durationMin,
            priceLabel: service.priceMinor > 0 ? formatMoney(service.priceMinor, service.currency) : "Free",
            depositLabel: null,
            createMeet: service.createMeet,
            location: service.location,
          }}
        />
      </main>
      <SiteFooter settings={settings} />
    </>
  );
}
