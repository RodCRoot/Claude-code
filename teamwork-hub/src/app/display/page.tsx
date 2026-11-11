import type { Metadata } from "next";
import { db } from "@/db";
import { boardPayload } from "@/lib/community/board";
import { displayAccess } from "@/lib/community/display-access";
import { DisplayBoard } from "./board";

export const metadata: Metadata = { title: "Community board", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Gym TV board. Readable only by a connected display device (Settings → Community issues the
 * link) or by an owner/admin previewing it. Anyone else gets the "not connected" screen: there
 * is nothing to sign in to here and no link to the rest of the app.
 * `?panel=3` pins one panel (used for previews and screenshots).
 */
export default async function DisplayPage({ searchParams }: { searchParams: Promise<{ panel?: string }> }) {
  const access = await displayAccess();
  if (!access) {
    return (
      <main id="main" className="flex min-h-dvh flex-col items-center justify-center bg-[#060b16] px-6 text-center text-white">
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">This screen is not connected</h1>
        <p className="mt-4 max-w-2xl text-lg text-[#b9c6da] sm:text-2xl">A gym admin can connect it from Settings, Community, by opening the screen link on this device.</p>
      </main>
    );
  }
  const payload = await boardPayload(db, access.orgId);
  const sp = await searchParams;
  const n = Number(sp.panel);
  const pinned = sp.panel !== undefined && Number.isInteger(n) && n >= 1 && n <= payload.panels.length ? n - 1 : null;
  return <DisplayBoard initial={payload} pinned={pinned} preview={access.via === "preview"} />;
}
