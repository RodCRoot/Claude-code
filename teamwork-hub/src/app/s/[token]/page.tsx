import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { ShowcaseSheet } from "@/components/showcase/sheet";
import { publicShowcase } from "@/lib/showcase/showcase";

/**
 * Public Showcase page: /s/<token>. No sign-in. The token is the only key; unknown, malformed,
 * revoked, expired and switched-off links all end in the same generic not-found page
 * (./not-found.tsx). Never indexed (meta robots here, X-Robots-Tag in src/proxy.ts), never
 * cached (private, no-store from the proxy), no third-party requests, no scripts beyond Next's.
 */
export const metadata: Metadata = {
  title: "Athlete Showcase",
  description: "Training numbers recorded at the gym, shared by the athlete's family.",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false, noimageindex: true } },
  referrer: "no-referrer",
};

export default async function PublicShowcasePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await db.transaction((tx) => publicShowcase(tx, token));
  if (!data) notFound();
  return (
    <main id="main" className="min-h-screen bg-[#e9edf4] px-3 py-4 sm:px-6 sm:py-10 print:min-h-0 print:bg-white print:p-0">
      <div className="mx-auto max-w-[820px]">
        <ShowcaseSheet data={data} />
      </div>
    </main>
  );
}
