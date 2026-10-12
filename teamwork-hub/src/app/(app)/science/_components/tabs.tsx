"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export function ScienceTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const path = usePathname();
  const active = (href: string) => (href === "/science" ? path === href : path === href || path.startsWith(href + "/"));
  return (
    <nav aria-label="Sports science sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-edge">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={active(t.href) ? "page" : undefined}
          className={cn("-mb-px flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium", active(t.href) ? "border-brand text-ink" : "border-transparent text-ink-3 hover:text-ink")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
