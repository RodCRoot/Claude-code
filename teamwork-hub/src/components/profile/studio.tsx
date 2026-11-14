/**
 * Studio-software presentational pieces (dashboard widgets, KPI tiles, member avatars,
 * info-card sections, ledger helpers). Server-component friendly, no data access.
 * Colors come from the design tokens in globals.css; nothing here fetches or authorizes.
 */
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "@/components/icons";

/** Dashboard widget: card with a title bar, optional count and a "View all" link. */
export function Widget({
  title,
  count,
  href,
  linkLabel = "View all",
  linkContext,
  icon,
  className,
  bodyClassName,
  children,
  flush,
}: {
  title: string;
  count?: number | null;
  href?: string | null;
  linkLabel?: string;
  /** Screen-reader suffix so several "View all" links stay distinguishable. */
  linkContext?: string;
  icon?: IconName;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
  /** No body padding (for tables/lists that run edge to edge). */
  flush?: boolean;
}) {
  const headingId = `w-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={headingId} className={cn("flex min-w-0 flex-col overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-edge bg-th px-4 py-2">
        <h2 id={headingId} className="flex min-w-0 items-center gap-2 text-[13px] font-bold uppercase tracking-wide text-ink-2">
          {icon ? <Icon name={icon} className="size-4 text-brand" /> : null}
          <span className="truncate">{title}</span>
          {count != null ? <span className="rounded-full bg-surface px-1.5 text-[11px] font-bold tabular text-ink-2 ring-1 ring-edge">{count}</span> : null}
        </h2>
        {href ? (
          <Link href={href} className="shrink-0 text-xs font-semibold text-brand hover:underline">
            {linkLabel}
            {linkContext ? <span className="sr-only"> {linkContext}</span> : null}
            <span aria-hidden> ›</span>
          </Link>
        ) : null}
      </div>
      <div className={cn("flex-1", flush ? "" : "px-4 py-3", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Compact empty line inside a widget. */
export function WidgetEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-ink-3">{children}</p>;
}

const toneRing = {
  brand: "bg-brand/10 text-brand",
  ok: "bg-ok/10 text-ok",
  warn: "bg-warn/10 text-warn",
  bad: "bg-bad/10 text-bad",
  info: "bg-info/10 text-info",
} as const;

/** KPI tile: icon chip, big number, label and hint. Optionally a link (whole tile clickable). */
export function KpiTile({
  label,
  value,
  hint,
  icon,
  tone = "brand",
  href,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon: IconName;
  tone?: keyof typeof toneRing;
  href?: string;
}) {
  const body = (
    <>
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", toneRing[tone])}>
        <Icon name={icon} className="size-5" />
      </span>
      <span className="min-w-0">
        <span className={cn("block text-[24px] font-bold leading-none tabular", tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ink")}>{value}</span>
        <span className="mt-1 block text-xs font-semibold text-ink-2">{label}</span>
        {hint ? <span className="block text-[11px] text-ink-3">{hint}</span> : null}
      </span>
    </>
  );
  const cls = "flex min-w-0 items-center gap-3 rounded-md border border-edge bg-surface px-4 py-3 shadow-[0_1px_3px_rgb(16_24_40/0.06)]";
  return href ? (
    <Link href={href} className={cn(cls, "transition-colors hover:border-brand/50 hover:bg-surface-2")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Light tints with dark initials (all pairs ≥ 7:1) — readable in light and dark themes. */
const AVATAR_TINTS = [
  "bg-[#dbeafe] text-[#1e3a8a]",
  "bg-[#dcfce7] text-[#14532d]",
  "bg-[#fef3c7] text-[#78350f]",
  "bg-[#fce7f3] text-[#831843]",
  "bg-[#ede9fe] text-[#4c1d95]",
  "bg-[#cffafe] text-[#164e63]",
  "bg-[#ffe4e6] text-[#881337]",
];

export function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Deterministic colored initials avatar (decorative; the name is always rendered next to it). */
export function MemberAvatar({ name, size = "md", className }: { name: string; size?: "sm" | "md" | "lg" | "xl"; className?: string }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const sizes = { sm: "size-7 text-[10px]", md: "size-8 text-xs", lg: "size-12 text-base", xl: "size-20 text-2xl" };
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-bold", AVATAR_TINTS[h % AVATAR_TINTS.length], sizes[size], className)}>
      {initialsOf(name)}
    </span>
  );
}

/** One titled block in a profile's left info column. */
export function InfoSection({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border-b border-edge px-4 py-3 last:border-b-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="kicker">{title}</h3>
        {action}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/** Label/value rows inside an InfoSection. */
export function InfoList({ items }: { items: [React.ReactNode, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(5.5rem,auto)_1fr] gap-x-3 gap-y-1">
      {items.map(([k, val], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words">{val ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Segmented filter control (link-based) used for list filters. */
export function Segmented({ label, items }: { label: string; items: { href: string; label: React.ReactNode; current: boolean }[] }) {
  return (
    <nav aria-label={label} className="max-w-full min-w-0 overflow-x-auto py-0.5">
      <ul className="inline-flex min-w-max rounded-md border border-edge bg-surface p-0.5 shadow-[0_1px_1px_rgb(16_24_40/0.05)]">
        {items.map((it, i) => (
          <li key={i}>
            <Link
              href={it.href}
              aria-current={it.current ? "true" : undefined}
              className={cn(
                "flex h-8 items-center whitespace-nowrap rounded px-3 text-xs font-semibold",
                it.current ? "bg-brand text-brand-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
              )}
            >
              {it.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Simple percentage meter (decorative; pair with visible numbers). */
export function Meter({ value, max, tone = "brand" }: { value: number; max: number; tone?: "brand" | "ok" | "warn" }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <span aria-hidden className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-2 ring-1 ring-edge/60">
      <span className={cn("block h-full rounded-full", tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-brand")} style={{ width: `${pct}%` }} />
    </span>
  );
}
