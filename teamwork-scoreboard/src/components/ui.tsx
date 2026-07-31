/**
 * Lightweight component system in the spirit of shadcn/ui: consistent cards,
 * buttons, badges, inputs, tables, and status indicators, all Tailwind-driven
 * and server-component friendly.
 */
import Link from "next/link";
import { cn } from "@/lib/cn";
import type { Status } from "@/lib/calc";

/* ----------------------------- Card ------------------------------ */

export function Card({
  className,
  children,
  id,
}: {
  className?: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={cn(
        "rounded-xl border border-edge bg-surface-2 shadow-[0_1px_2px_rgb(0_0_0/0.04)]",
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  kicker,
  action,
  className,
}: {
  title: React.ReactNode;
  kicker?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-5 pt-4 pb-2", className)}>
      <div>
        {kicker ? <div className="kicker mb-0.5">{kicker}</div> : null}
        <h2 className="text-base font-semibold leading-tight">{title}</h2>
      </div>
      {action}
    </div>
  );
}

export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("px-5 pb-5 pt-1", className)}>{children}</div>;
}

/* ---------------------------- Button ----------------------------- */

const btnBase =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-50 disabled:pointer-events-none";
const btnVariants: Record<string, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700",
  secondary:
    "bg-surface-3 text-ink hover:bg-edge border border-edge",
  outline: "border border-edge text-ink hover:bg-surface-3",
  ghost: "text-ink-2 hover:bg-surface-3 hover:text-ink",
  danger: "bg-bad text-white hover:opacity-90",
};
const btnSizes: Record<string, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof btnVariants;
  size?: keyof typeof btnSizes;
}) {
  return (
    <button
      className={cn(btnBase, btnVariants[variant], btnSizes[size], className)}
      {...props}
    />
  );
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  href,
  children,
}: {
  variant?: keyof typeof btnVariants;
  size?: keyof typeof btnSizes;
  className?: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(btnBase, btnVariants[variant], btnSizes[size], className)}
    >
      {children}
    </Link>
  );
}

/* ----------------------------- Badge ----------------------------- */

const badgeVariants: Record<string, string> = {
  neutral: "bg-surface-3 text-ink-2 border-edge",
  green: "bg-ok/10 text-ok border-ok/25",
  yellow: "bg-warn/10 text-warn border-warn/25",
  red: "bg-bad/10 text-bad border-bad/25",
  brand: "bg-brand-600/10 text-brand-600 border-brand-600/25",
};

export function Badge({
  variant = "neutral",
  className,
  children,
}: {
  variant?: keyof typeof badgeVariants;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        badgeVariants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: Status }) {
  const map: Record<Status, { v: keyof typeof badgeVariants; label: string }> = {
    green: { v: "green", label: "On track" },
    yellow: { v: "yellow", label: "Watch" },
    red: { v: "red", label: "Behind" },
    none: { v: "neutral", label: "No data" },
  };
  const m = map[status];
  return <Badge variant={m.v}>{m.label}</Badge>;
}

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  const color =
    status === "green"
      ? "bg-ok"
      : status === "yellow"
      ? "bg-warn"
      : status === "red"
      ? "bg-bad"
      : "bg-ink-3";
  return (
    <span
      aria-label={`status: ${status}`}
      className={cn("inline-block size-2.5 rounded-full", color, className)}
    />
  );
}

/* ---------------------------- Inputs ----------------------------- */

const fieldBase =
  "w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-2 focus:outline-offset-1 focus:outline-brand-600";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(fieldBase, "h-9", props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(fieldBase, "min-h-20", props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(fieldBase, "h-9", props.className)} />;
}

export function Label({
  children,
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      {...props}
      className={cn("mb-1 block text-xs font-semibold text-ink-2", className)}
    >
      {children}
    </label>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
      {hint ? <p className="mt-1 text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}

/* ----------------------------- Table ----------------------------- */

export function Table({
  columns,
  rows,
  className,
  empty = "No records.",
}: {
  columns: React.ReactNode[];
  rows: React.ReactNode[][];
  className?: string;
  empty?: string;
}) {
  return (
    <div className={cn("overflow-x-auto rounded-lg border border-edge", className)}>
      <table className="w-full min-w-max text-sm">
        <thead>
          <tr className="border-b border-edge bg-surface-3/60 text-left">
            {columns.map((c, i) => (
              <th key={i} className="whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-ink-3">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i} className="border-b border-edge/60 last:border-0 hover:bg-surface-3/40">
                {r.map((cell, j) => (
                  <td key={j} className="px-3 py-2 align-top">
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------- Progress ---------------------------- */

export function Progress({
  pct,
  status = "none",
  className,
}: {
  pct: number | null;
  status?: Status;
  className?: string;
}) {
  const color =
    status === "green"
      ? "bg-ok"
      : status === "yellow"
      ? "bg-warn"
      : status === "red"
      ? "bg-bad"
      : "bg-brand-600";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)}>
      <div
        className={cn("h-full rounded-full transition-all", color)}
        style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
      />
    </div>
  );
}

/* --------------------------- Tooltip ----------------------------- */

export function Tooltip({
  content,
  children,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="tt inline-flex" tabIndex={0}>
      {children}
      <span role="tooltip" className="tt-body">
        {content}
      </span>
    </span>
  );
}

export function InfoTip({ content }: { content: React.ReactNode }) {
  return (
    <Tooltip content={content}>
      <span
        aria-hidden
        className="inline-flex size-4 cursor-help items-center justify-center rounded-full border border-edge text-[10px] font-bold text-ink-3"
      >
        ?
      </span>
    </Tooltip>
  );
}

/* -------------------------- Page header -------------------------- */

export function PageHeader({
  title,
  kicker,
  subtitle,
  actions,
}: {
  title: React.ReactNode;
  kicker?: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        {kicker ? <div className="kicker mb-1">{kicker}</div> : null}
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink-2">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-edge px-6 py-10 text-center">
      <p className="font-medium text-ink-2">{title}</p>
      {hint ? <p className="mt-1 text-sm text-ink-3">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
