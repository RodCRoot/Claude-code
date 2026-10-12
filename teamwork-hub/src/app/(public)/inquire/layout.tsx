import { connection } from "next/server";
import { db } from "@/db";
import { publicOrg } from "@/lib/crm/public";

/** Minimal public shell for the inquiry form only (the full public site is built separately). */
export default async function InquireLayout({ children }: { children: React.ReactNode }) {
  await connection(); // per-request: never query the database at build time
  const org = await publicOrg(db);
  const name = org?.branding?.displayName ?? org?.name ?? "Teamwork";
  const brand = org?.branding?.primaryColor;
  return (
    <div className="min-h-dvh bg-bg" style={brand ? ({ ["--brand" as string]: brand } as React.CSSProperties) : undefined}>
      <header className="border-b border-edge bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <span className="text-base font-bold tracking-tight">{name}</span>
          <span className="text-xs text-ink-3">Athlete assessment inquiry</span>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-3xl px-4 py-8">
        {children}
      </main>
    </div>
  );
}
