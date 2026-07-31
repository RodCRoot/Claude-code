"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { ThemeToggle } from "./theme-toggle";

export interface NavUser {
  name: string;
  roleName: string;
  permissions: string[];
}

interface Item {
  href: string;
  label: string;
  icon: string;
  perm?: string;
}

const MAIN: Item[] = [
  { href: "/", label: "Today", icon: "◎" },
  { href: "/scoreboard", label: "Scoreboard", icon: "▦" },
  { href: "/team", label: "Team Scorecards", icon: "⚑" },
  { href: "/reports", label: "5-15 Reports", icon: "✎" },
  { href: "/operations", label: "Operations", icon: "☑" },
  { href: "/facility", label: "Facility", icon: "⌂" },
  { href: "/onboarding", label: "Onboarding", icon: "➜" },
  { href: "/marketing", label: "Marketing & 3R", icon: "◉" },
];

const RECORDS: Item[] = [
  { href: "/leads", label: "Leads & Appointments", icon: "☏" },
  { href: "/athletes", label: "Athletes", icon: "✦" },
];

const MANAGE: Item[] = [
  { href: "/summary", label: "Weekly Summary", icon: "★", perm: "review_reports" },
  { href: "/data", label: "Data & Sync", icon: "⇅", perm: "manage_imports" },
  { href: "/admin", label: "Admin", icon: "⚙", perm: "manage_settings" },
];

function NavLink({ item, onClick }: { item: Item; onClick?: () => void }) {
  const pathname = usePathname();
  const active =
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-brand-600 text-white"
          : "text-ink-2 hover:bg-surface-3 hover:text-ink"
      )}
    >
      <span className="w-4 text-center opacity-80" aria-hidden>
        {item.icon}
      </span>
      {item.label}
    </Link>
  );
}

function can(user: NavUser, item: Item) {
  return !item.perm || user.permissions.includes(item.perm);
}

export function AppNav({ user, demoMode }: { user: NavUser; demoMode: boolean }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const sections = (
    <>
      <nav className="space-y-0.5">
        {MAIN.filter((i) => can(user, i)).map((i) => (
          <NavLink key={i.href} item={i} onClick={close} />
        ))}
      </nav>
      <div>
        <div className="kicker mb-1 px-3">Records</div>
        <nav className="space-y-0.5">
          {RECORDS.filter((i) => can(user, i)).map((i) => (
            <NavLink key={i.href} item={i} onClick={close} />
          ))}
        </nav>
      </div>
      {MANAGE.some((i) => can(user, i)) && (
        <div>
          <div className="kicker mb-1 px-3">Manage</div>
          <nav className="space-y-0.5">
            {MANAGE.filter((i) => can(user, i)).map((i) => (
              <NavLink key={i.href} item={i} onClick={close} />
            ))}
          </nav>
        </div>
      )}
    </>
  );

  const brand = (
    <Link href="/" className="flex items-center gap-2 px-3" onClick={close}>
      <span className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-black text-white">
        TW
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-bold tracking-tight">Teamwork</span>
        <span className="kicker block">Bloomington</span>
      </span>
    </Link>
  );

  return (
    <>
      {/* Mobile top bar */}
      <header className="no-print sticky top-0 z-30 flex h-14 items-center justify-between border-b border-edge bg-surface-2 px-3 lg:hidden">
        {brand}
        <div className="flex items-center gap-1">
          {demoMode && (
            <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warn">
              Demo data
            </span>
          )}
          <ThemeToggle />
          <button
            aria-label="Open menu"
            onClick={() => setOpen(!open)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-lg hover:bg-surface-3"
          >
            ☰
          </button>
        </div>
      </header>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={close}
          aria-hidden
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "no-print fixed inset-y-0 left-0 z-50 flex w-64 flex-col gap-5 overflow-y-auto border-r border-edge bg-surface-2 py-4 transition-transform lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="hidden items-center justify-between pr-3 lg:flex">
          {brand}
          <ThemeToggle />
        </div>
        <div className="flex items-center justify-between pr-3 lg:hidden">
          {brand}
          <button aria-label="Close menu" onClick={close} className="text-lg px-2">
            ✕
          </button>
        </div>
        {demoMode && (
          <div className="mx-3 hidden rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs font-semibold text-warn lg:block">
            DEMO DATA — sample records until real data is connected
          </div>
        )}
        <div className="flex flex-1 flex-col gap-5 px-2">{sections}</div>
        <div className="border-t border-edge px-4 pt-3">
          <p className="text-sm font-semibold">{user.name}</p>
          <p className="text-xs text-ink-3">{user.roleName}</p>
          <form action="/api/auth/logout" method="post" className="mt-2">
            <button className="text-xs font-medium text-brand-600 hover:underline">
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
