"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/cn";

export type NavLink = { href: string; label: string; key: string };

export function AppNav({
  items,
  orgName,
  userName,
  roleLabel,
  demo,
  logoutAction,
}: {
  items: NavLink[];
  orgName: string;
  userName: string;
  roleLabel: string;
  demo: boolean;
  logoutAction: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  const links = (
    <ul className="space-y-0.5">
      {items.map((i) => (
        <li key={i.key}>
          <Link
            href={i.href}
            onClick={() => setOpen(false)}
            aria-current={isActive(i.href) ? "page" : undefined}
            className={cn(
              "flex min-h-11 items-center rounded-lg px-3 text-sm font-medium",
              isActive(i.href) ? "bg-brand text-brand-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {i.label}
          </Link>
        </li>
      ))}
    </ul>
  );

  const footer = (
    <div className="border-t border-edge pt-3 text-sm">
      <div className="truncate font-semibold">{userName}</div>
      <div className="text-xs text-ink-3">{roleLabel}</div>
      <form action={logoutAction} className="mt-2">
        <button type="submit" className="min-h-11 text-sm font-medium text-ink-3 underline-offset-2 hover:text-ink hover:underline">
          Sign out
        </button>
      </form>
    </div>
  );

  return (
    <>
      {/* Mobile top bar */}
      <header className="no-print sticky top-0 z-30 flex items-center justify-between border-b border-edge bg-surface px-4 py-2 lg:hidden">
        <Link href="/today" className="font-bold">
          {orgName} <span className="text-brand">Hub</span>
        </Link>
        <div className="flex items-center gap-2">
          {demo ? <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-bold text-warn">DEMO DATA</span> : null}
          <button
            type="button"
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((o) => !o)}
            className="min-h-11 min-w-11 rounded-lg border border-edge px-3 text-sm font-medium"
          >
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </header>
      {open ? (
        <nav id="mobile-nav" aria-label="Main" className="no-print fixed inset-x-0 top-[57px] bottom-0 z-30 overflow-y-auto bg-surface p-4 lg:hidden">
          {links}
          <div className="mt-4">{footer}</div>
        </nav>
      ) : null}

      {/* Desktop sidebar */}
      <aside aria-label="Sidebar" className="no-print sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-edge bg-surface px-3 py-4 lg:flex">
        <Link href="/today" className="mb-1 px-3 text-lg font-bold tracking-tight">
          {orgName} <span className="text-brand">Hub</span>
        </Link>
        {demo ? (
          <div className="mb-3 px-3">
            <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-bold text-warn" title="Synthetic data only. No real people or payments.">
              DEMO DATA
            </span>
          </div>
        ) : (
          <div className="mb-3" />
        )}
        <nav aria-label="Main" className="flex-1 overflow-y-auto">
          {links}
        </nav>
        {footer}
      </aside>
    </>
  );
}
