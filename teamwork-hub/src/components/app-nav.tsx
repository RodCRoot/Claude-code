"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "./icons";
import { purgeTrainingOffline } from "./training-offline";

export type NavLink = { href: string; label: string; key: string; icon: IconName; group: string };
export type QuickAction = { href: string; label: string };

/**
 * App frame in the style of studio management software: a dark, grouped icon sidebar, and a light
 * top bar with member search, a "+ New" menu, and the account menu.
 */
export function AppNav({
  items,
  groupLabels,
  orgName,
  userName,
  roleLabel,
  demo,
  search,
  quickActions,
  logoutAction,
}: {
  items: NavLink[];
  groupLabels: Record<string, string> | null;
  orgName: string;
  userName: string;
  roleLabel: string;
  demo: boolean;
  /** Staff get global member search in the top bar. */
  search: boolean;
  quickActions: QuickAction[];
  logoutAction: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const initials = initialsOf(orgName);

  const groups: { label: string | null; items: NavLink[] }[] = [];
  for (const i of items) {
    const label = groupLabels ? (groupLabels[i.group] ?? null) : null;
    const g = groups.at(-1);
    if (g && g.label === label) g.items.push(i);
    else groups.push({ label, items: [i] });
  }

  const links = (
    <div className="space-y-4">
      {groups.map((g, gi) => (
        <div key={g.label ?? gi}>
          {g.label ? <div className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-nav-ink-3">{g.label}</div> : null}
          <ul className="space-y-0.5">
            {g.items.map((i) => {
              const active = isActive(i.href);
              return (
                <li key={i.key}>
                  <Link
                    href={i.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
                      active ? "bg-nav-active text-white before:absolute before:inset-y-1.5 before:left-0 before:w-1 before:rounded-r before:bg-nav-accent" : "text-nav-ink hover:bg-nav-hover hover:text-white",
                    )}
                  >
                    <Icon name={i.icon} className={cn("size-[18px]", active ? "text-nav-accent" : "text-nav-ink-3")} />
                    {i.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );

  const brandBlock = (
    <Link href="/today" className="flex items-center gap-2.5 rounded-md px-2 py-1 text-white">
      <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-md bg-nav-accent text-xs font-black text-nav-bg">
        {initials}
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-bold">{orgName}</span>
        <span className="block text-[11px] font-medium text-nav-ink-3">Hub</span>
      </span>
    </Link>
  );

  const demoBadge = demo ? (
    <span className="rounded bg-[#fcd34d] px-1.5 py-0.5 text-[10px] font-bold text-[#422006]" title="Synthetic data only. No real people or payments.">
      DEMO DATA
    </span>
  ) : null;

  const signOut = (
    // Signing out removes the offline training copy from this device (also re-done on /login).
    <form action={logoutAction} onSubmit={() => void purgeTrainingOffline()}>
      <button type="submit" className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-ink-2 hover:bg-surface-2 hover:text-ink">
        <Icon name="logout" className="size-4" /> Sign out
      </button>
    </form>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside aria-label="Sidebar" className="no-print sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-nav-bg lg:flex">
        <div className="flex h-14 items-center border-b border-white/10 px-3">{brandBlock}</div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-4">
          {links}
        </nav>
        {demo ? <div className="border-t border-white/10 px-4 py-3">{demoBadge}</div> : null}
      </aside>

      {/* Mobile drawer */}
      {open ? (
        <nav id="mobile-nav" aria-label="Main" className="no-print fixed inset-x-0 top-14 bottom-0 z-40 overflow-y-auto bg-nav-bg px-2 py-4 lg:hidden">
          {links}
          <div className="mt-6 border-t border-white/10 px-3 pt-3 text-sm text-nav-ink">
            <div className="font-semibold text-white">{userName}</div>
            <div className="text-xs text-nav-ink-3">{roleLabel}</div>
          </div>
        </nav>
      ) : null}

      {/* Top bar (sits above the page column on desktop, full width on mobile) */}
      <header className="no-print fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-2 border-b border-edge bg-surface px-3 sm:px-4 lg:left-60">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex size-11 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 lg:hidden"
        >
          <Icon name={open ? "close" : "menu"} />
        </button>
        <Link href="/today" className="truncate text-sm font-bold lg:hidden">
          {orgName} <span className="text-brand">Hub</span>
        </Link>

        {search ? (
          <form action="/people" role="search" className="hidden max-w-md flex-1 md:block">
            <label htmlFor="global-search" className="sr-only">
              Search people
            </label>
            <div className="relative">
              <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
              <input
                id="global-search"
                name="q"
                type="search"
                placeholder="Search members, families, leads…"
                className="h-9 w-full rounded-md border border-edge bg-surface-2 pr-3 pl-9 text-sm text-ink placeholder:text-ink-3 focus:bg-surface focus:outline-2 focus:outline-brand"
              />
            </div>
          </form>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden sm:inline lg:hidden">{demoBadge}</span>
          {search ? (
            <Link href="/people" aria-label="Search people" className="inline-flex size-11 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 md:hidden">
              <Icon name="search" />
            </Link>
          ) : null}
          {quickActions.length ? (
            <details className="relative">
              <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-md bg-brand px-3 text-sm font-semibold text-brand-ink hover:brightness-110 [&::-webkit-details-marker]:hidden">
                <Icon name="plus" className="size-4" />
                <span className="max-sm:sr-only">New</span>
              </summary>
              <ul className="absolute right-0 z-40 mt-1 w-56 rounded-md border border-edge bg-surface py-1 shadow-lg">
                {quickActions.map((a) => (
                  <li key={a.href}>
                    <Link href={a.href} onClick={closeMenu} className="block px-3 py-2 text-sm text-ink hover:bg-surface-2">
                      {a.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <details className="relative">
            <summary aria-label={`Account menu for ${userName}`} className="flex h-11 cursor-pointer list-none items-center gap-2 rounded-md px-1.5 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
              <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-full bg-brand text-xs font-bold text-brand-ink">
{initialsOf(userName)}
              </span>
              <span className="hidden text-left leading-tight md:block">
                <span className="block max-w-40 truncate text-sm font-semibold">{userName}</span>
                <span className="block text-[11px] text-ink-3">{roleLabel}</span>
              </span>
              <Icon name="chevron" className="hidden size-4 text-ink-3 md:block" />
            </summary>
            <div className="absolute right-0 z-40 mt-1 w-56 rounded-md border border-edge bg-surface p-1 shadow-lg">
              <div className="border-b border-edge px-3 py-2 md:hidden">
                <div className="truncate text-sm font-semibold">{userName}</div>
                <div className="text-xs text-ink-3">{roleLabel}</div>
              </div>
              <Link href="/settings/security" onClick={closeMenu} className="flex min-h-10 items-center gap-2 rounded-md px-3 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink">
                <Icon name="shield" className="size-4" /> Sign-in &amp; security
              </Link>
              {signOut}
            </div>
          </details>
        </div>
      </header>
    </>
  );
}

/** "Rod (Owner)" → "R", "Tess Morales" → "TM": letters only, parenthetical labels ignored. */
function initialsOf(name: string): string {
  return (
    name
      .replace(/\(.*?\)/g, "")
      .split(/\s+/)
      .map((p) => p.match(/\p{L}/u)?.[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

/** Client navigation keeps a <details> menu open; close it when one of its links is chosen. */
function closeMenu(e: React.MouseEvent<HTMLElement>) {
  e.currentTarget.closest("details")?.removeAttribute("open");
}
