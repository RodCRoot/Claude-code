import { cn } from "@/lib/cn";
import { MemberAvatar } from "./studio";

/**
 * Member profile header band (studio-CRM style): large initials, name (the page's h1),
 * status chips, a summary strip and quick actions. Purely presentational — callers pass
 * only what the viewer is already allowed to see.
 */
export function ProfileHeader({
  name,
  kicker,
  subtitle,
  badges,
  actions,
  stats,
  children,
}: {
  name: string;
  kicker: string;
  subtitle?: React.ReactNode;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  stats?: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "ok" | "warn" | "bad" }[];
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-4 overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
      <div className="h-2 bg-brand" aria-hidden />
      <div className="flex flex-wrap items-start gap-4 px-4 pt-4 pb-3 sm:px-5">
        <MemberAvatar name={name} size="xl" className="ring-4 ring-surface" />
        <div className="min-w-0 flex-[1_1_16rem]">
          <div className="kicker">{kicker}</div>
          <h1 className="text-2xl leading-tight font-bold tracking-tight break-words">{name}</h1>
          {subtitle ? <div className="mt-0.5 text-sm text-ink-2">{subtitle}</div> : null}
          {badges ? <div className="mt-2 flex flex-wrap items-center gap-1.5">{badges}</div> : null}
        </div>
        {actions ? <div className="flex w-full flex-wrap gap-2 md:w-auto md:max-w-md md:justify-end">{actions}</div> : null}
      </div>
      {stats && stats.length ? (
        <dl className="grid grid-cols-2 border-t border-edge bg-th sm:grid-cols-4">
          {stats.map((s, i) => (
            <div key={s.label} className={cn("min-w-0 px-4 py-2.5 sm:px-5", i % 2 === 1 && "border-l border-edge", i >= 2 && "border-t border-edge sm:border-t-0", i === 2 && "sm:border-l")}>
              <dt className="kicker">{s.label}</dt>
              <dd className={cn("truncate text-base font-bold tabular", s.tone === "ok" && "text-ok", s.tone === "warn" && "text-warn", s.tone === "bad" && "text-bad")}>{s.value}</dd>
              {s.hint ? <dd className="truncate text-xs text-ink-3">{s.hint}</dd> : null}
            </div>
          ))}
        </dl>
      ) : null}
      {children}
    </header>
  );
}
