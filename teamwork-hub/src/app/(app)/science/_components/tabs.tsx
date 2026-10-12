"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export function ScienceTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const path = usePathname();
  const active = (href: string) => (href === "/science" ? path === href : path === href || path.startsWith(href + "/"));
  return (
    // AMS module bar: fixed navy surface (same in light/dark) with light text (≥ 7:1).
    <nav aria-label="Sports science sections" className="mb-5 flex gap-0.5 overflow-x-auto rounded-lg bg-[#13203a] px-1.5 py-1 shadow-sm">
      <span aria-hidden className="mr-1 hidden shrink-0 items-center px-2 text-[11px] font-extrabold tracking-[0.14em] text-[#7fd3f7] sm:flex">AMS</span>
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={active(t.href) ? "page" : undefined}
          className={cn(
            "flex min-h-11 items-center whitespace-nowrap rounded-md px-3 text-sm font-semibold",
            active(t.href) ? "bg-white/[0.14] text-white shadow-[inset_0_-3px_0_#4fc3f7]" : "text-[#c9d4e5] hover:bg-white/[0.08] hover:text-white",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
