import type { Metadata } from "next";

export const metadata: Metadata = { title: "Showcase not available", robots: { index: false, follow: false } };

/**
 * One generic page for every link that does not resolve: never existed, mistyped, turned off,
 * expired, or Showcase switched off. It says nothing about which, so a link cannot be probed.
 */
export default function ShowcaseNotAvailable() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-[#e9edf4] px-4 text-[#141b2b]">
      <div className="max-w-md rounded-2xl bg-white px-6 py-8 text-center shadow-[0_10px_40px_rgb(15_26_48/0.14)] ring-1 ring-[#d5dce8]">
        <p className="text-[11px] font-extrabold tracking-[0.14em] text-[#4a5568] uppercase">Athlete Showcase</p>
        <h1 className="mt-2 text-2xl font-black tracking-tight">This link is not available</h1>
        <p className="mt-2 text-sm leading-relaxed text-[#3a4657]">The link may have been turned off, it may have expired, or the address may be incomplete. Ask the athlete or their family for a current link.</p>
      </div>
    </main>
  );
}
