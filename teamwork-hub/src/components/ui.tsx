/**
 * Teamwork Hub component kit — server-component friendly, accessible defaults.
 * Interactive form helpers live in ./forms.tsx (client).
 */
import Link from "next/link";
import { cn } from "@/lib/cn";

export function Card({ className, children, id }: { className?: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className={cn("min-w-0 rounded-xl border border-edge bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]", className)}>
      {children}
    </section>
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
    <div className={cn("flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-2", className)}>
      <div className="min-w-0">
        {kicker ? <div className="kicker mb-0.5">{kicker}</div> : null}
        <h2 className="text-base font-semibold leading-tight">{title}</h2>
      </div>
      {action}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-5 pb-5 pt-1", className)}>{children}</div>;
}

const btnBase =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap";
const btnVariants = {
  primary: "bg-brand text-brand-ink hover:brightness-110",
  secondary: "bg-surface-2 text-ink hover:bg-edge border border-edge",
  outline: "border border-edge text-ink hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "bg-bad text-white hover:opacity-90",
} as const;
const btnSizes = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-5 text-base",
} as const;
export type ButtonVariant = keyof typeof btnVariants;
export type ButtonSize = keyof typeof btnSizes;

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) {
  return cn(btnBase, btnVariants[variant], btnSizes[size], className);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  href,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  href: string;
  children: React.ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </Link>
  );
}

const badgeVariants = {
  neutral: "bg-surface-2 text-ink-2 border-edge",
  green: "bg-ok/10 text-ok border-ok/30",
  yellow: "bg-warn/10 text-warn border-warn/30",
  red: "bg-bad/10 text-bad border-bad/30",
  blue: "bg-info/10 text-info border-info/30",
  brand: "bg-brand/10 text-brand border-brand/30",
} as const;
export type BadgeVariant = keyof typeof badgeVariants;

export function Badge({ variant = "neutral", className, children, title }: { variant?: BadgeVariant; className?: string; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap", badgeVariants[variant], className)}>
      {children}
    </span>
  );
}

/** Maps common status strings to badge colors so every list renders statuses consistently. */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const green = ["active", "paid", "succeeded", "settled", "completed", "attended", "verified_sandbox", "connected", "done", "committed", "synced", "processed", "won", "achieved", "approved", "reviewed", "booked"];
  const yellow = ["pending", "trialing", "on_hold", "waitlisted", "partially_signed", "processing", "requires_action", "draft", "open", "in_progress", "needs_review", "configured_unverified", "queued", "scheduled", "follow_up", "new", "uploaded", "validated", "test_redirected"];
  const red = ["past_due", "failed", "no_show", "cancelled", "late_cancelled", "expired", "void", "error", "dead", "invalid", "lost", "uncollectible", "rejected", "reversed", "disputed"];
  const v: BadgeVariant = green.includes(status) ? "green" : yellow.includes(status) ? "yellow" : red.includes(status) ? "red" : "neutral";
  return (
    <Badge variant={v} className={className}>
      {status.replaceAll("_", " ")}
    </Badge>
  );
}

const fieldBase =
  "w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-2 focus:outline-offset-1 focus:outline-brand aria-[invalid=true]:border-bad";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(fieldBase, "h-10", props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(fieldBase, "min-h-20", props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(fieldBase, "h-10", props.className)} />;
}

/** Label + control + hint/error, with ids wired for screen readers. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
  required,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
  required?: boolean;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-2">
        {label}
        {required ? <span className="text-bad" aria-hidden> *</span> : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-ink-3">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-xs font-medium text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Table({ children, className, caption }: { children: React.ReactNode; className?: string; caption?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full min-w-[560px] border-collapse text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className, align }: { children?: React.ReactNode; className?: string; align?: "left" | "right" | "center" }) {
  return (
    <th scope="col" className={cn("border-b border-edge px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-3", align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left", className)}>
      {children}
    </th>
  );
}

export function Td({ children, className, align, colSpan }: { children?: React.ReactNode; className?: string; align?: "left" | "right" | "center"; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cn("border-b border-edge/70 px-3 py-2.5 align-middle", align === "right" ? "text-right tabular" : align === "center" ? "text-center" : "", className)}>
      {children}
    </td>
  );
}

export function PageHeader({
  title,
  kicker,
  description,
  actions,
}: {
  title: React.ReactNode;
  kicker?: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {kicker ? <div className="kicker mb-1">{kicker}</div> : null}
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-ink-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="rounded-xl border border-edge bg-surface px-4 py-3">
      <div className="kicker">{label}</div>
      <div className={cn("mt-1 text-2xl font-bold tabular", tone === "ok" && "text-ok", tone === "warn" && "text-warn", tone === "bad" && "text-bad")}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-ink-3">{hint}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-edge px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-md text-sm text-ink-3">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "warn" | "bad" | "ok";
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-info/30 bg-info/5",
    warn: "border-warn/30 bg-warn/5",
    bad: "border-bad/30 bg-bad/5",
    ok: "border-ok/30 bg-ok/5",
  };
  return (
    <div role={tone === "bad" ? "alert" : "note"} className={cn("rounded-lg border px-4 py-3 text-sm", tones[tone], className)}>
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={cn(title && "mt-0.5", "text-ink-2")}>{children}</div>
    </div>
  );
}

/** Honest "needs configuration" state for provider-backed actions. */
export function NotConfigured({ provider, envVars, children }: { provider: string; envVars: string[]; children?: React.ReactNode }) {
  return (
    <Callout tone="warn" title={`${provider} is not configured`}>
      {children ?? <>This action needs {provider} credentials. Nothing was sent or charged.</>}
      <span className="mt-1 block text-xs">
        Set {envVars.map((v, i) => (
          <code key={v} className="rounded bg-surface-2 px-1">
            {v}
            {i < envVars.length - 1 ? "" : ""}
          </code>
        )).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])} on the server, then re-check in Settings → Integrations.
      </span>
    </Callout>
  );
}

export function Tabs({ tabs, current }: { tabs: { href: string; label: string; key: string }[]; current: string }) {
  return (
    <nav aria-label="Section" className="mb-5 flex gap-1 overflow-x-auto border-b border-edge">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={cn(
            "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
            t.key === current ? "border-brand text-ink" : "border-transparent text-ink-3 hover:text-ink",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function DemoBadge() {
  return (
    <Badge variant="yellow" title="Synthetic demonstration data — not a real person or payment">
      DEMO
    </Badge>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span aria-hidden className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-brand/15 text-xs font-bold text-brand", className)}>
      {initials}
    </span>
  );
}
