import { ButtonLink, Select, Tabs, buttonClass } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { definitionsFor, type DefinitionTab } from "@/lib/scoreboard/definitions";

/** Shared chrome for the owner scoreboard tabs. Server components only: no client JavaScript. */

export type ScoreboardQuery = { location?: string | null; program?: string | null; months?: number | null; weeks?: number | null };

export function scoreboardQs(q: ScoreboardQuery, extra: Record<string, string | number | null | undefined> = {}): string {
  const p = new URLSearchParams();
  if (q.location) p.set("location", q.location);
  if (q.program) p.set("program", q.program);
  if (q.months) p.set("months", String(q.months));
  if (q.weeks) p.set("weeks", String(q.weeks));
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function ScoreboardTabs({ current, q }: { current: DefinitionTab; q: ScoreboardQuery }) {
  const f = scoreboardQs({ location: q.location, program: q.program });
  return (
    <Tabs
      current={current}
      tabs={[
        { key: "daily", href: `/scoreboard${f}`, label: "Daily" },
        { key: "monthly", href: `/scoreboard/monthly${f}`, label: "Monthly funnel" },
        { key: "efficiency", href: `/scoreboard/efficiency${f}`, label: "Schedule and payroll" },
        { key: "marketing", href: `/scoreboard/marketing`, label: "Marketing" },
        { key: "money", href: `/scoreboard/money${f}`, label: "Money" },
      ]}
    />
  );
}

export function FilterBar({
  action,
  locations,
  programs,
  q,
  children,
}: {
  action: string;
  locations: { id: string; name: string }[];
  programs: { id: string; name: string }[];
  q: ScoreboardQuery;
  /** Extra controls (months, weeks) rendered inside the same form. */
  children?: React.ReactNode;
}) {
  const filtered = !!(q.location || q.program);
  return (
    <form action={action} className="mb-5 flex flex-wrap items-end gap-3 rounded-md border border-edge bg-surface px-3 py-3">
      <div className="min-w-0">
        <label htmlFor="sb-location" className="block text-sm font-medium text-ink-2">
          Location
        </label>
        <Select id="sb-location" name="location" defaultValue={q.location ?? ""} className="w-44 max-w-full">
          <option value="">All locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-0">
        <label htmlFor="sb-program" className="block text-sm font-medium text-ink-2">
          Program
        </label>
        <Select id="sb-program" name="program" defaultValue={q.program ?? ""} className="w-64 max-w-full">
          <option value="">All programs</option>
          {programs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>
      {children}
      <button type="submit" className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink">
        Apply
      </button>
      {filtered ? (
        <ButtonLink href={action} variant="ghost">
          Clear filter
        </ButtonLink>
      ) : null}
      <p className="basis-full text-xs text-ink-3">
        {filtered ? "Filter on: every number on this tab is narrowed the same way. A number that cannot be attributed is withheld, not shown unfiltered." : "The filter applies to every number on this tab."} See Definitions for how.
      </p>
    </form>
  );
}

export function MonthsSelect({ value, options = [6, 12, 24] }: { value: number; options?: number[] }) {
  return (
    <div>
      <label htmlFor="sb-months" className="block text-sm font-medium text-ink-2">
        Months shown
      </label>
      <Select id="sb-months" name="months" defaultValue={String(value)} className="w-28">
        {options.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** The Definitions drawer: exactly how each number on the tab is computed, with its version. */
export function DefinitionsDrawer({ tab }: { tab: DefinitionTab }) {
  const defs = definitionsFor(tab);
  return (
    <details id="definitions" className="mt-6 rounded-md border border-edge bg-surface">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Definitions: how each number is computed ({defs.length})</summary>
      <dl className="divide-y divide-edge border-t border-edge">
        {defs.map((d) => (
          <div key={d.key} id={`def-${d.key}`} className="px-4 py-3">
            <dt className="text-sm font-semibold">
              {d.label} <span className="ml-1 rounded border border-edge px-1.5 py-0.5 text-[11px] font-medium text-ink-2">v{d.version}</span>
            </dt>
            <dd className="mt-1 text-sm text-ink-2">
              {d.definition}
              {d.filterNote ? <span className="mt-1 block text-xs text-ink-3">Filter: {d.filterNote}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * CSV links are plain anchors on purpose: a Next <Link> would prefetch the route handler, which
 * runs the whole export (and writes an audit row) every time the page is merely viewed.
 */
export function ExportLink({ table, q, children = "Export CSV", extra }: { table: string; q: ScoreboardQuery; children?: React.ReactNode; extra?: Record<string, string | number | null | undefined> }) {
  return (
    <a href={`/api/scoreboard/${table}${scoreboardQs(q, extra)}`} download className="text-xs font-medium text-brand underline">
      {children}
    </a>
  );
}

export function ExportButton({ table, q, children = "Export CSV" }: { table: string; q: ScoreboardQuery; children?: React.ReactNode }) {
  return (
    <a href={`/api/scoreboard/${table}${scoreboardQs(q)}`} download className={buttonClass("secondary", "md")}>
      {children}
    </a>
  );
}

export const money = (minor: number | null | undefined) => (minor == null ? <span className="text-ink-3">not available</span> : formatMoney(minor));
export const pctText = (x: number | null | undefined) => (x == null ? null : `${Math.round(x * 1000) / 10}%`);
export const NA = ({ children = "not available" }: { children?: React.ReactNode }) => <span className="text-ink-3">{children}</span>;

/** Where a row behind a number links to. Only same-site paths are ever produced. */
export function refHref(kind: string | null, id: string | null): string | null {
  if (!kind || !id) return null;
  switch (kind) {
    case "person":
      return `/people/${id}`;
    case "membership":
      return `/billing/memberships/${id}`;
    case "invoice":
      return `/billing/invoices/${id}`;
    case "lead":
      return `/people/leads/${id}`;
    case "session":
      return `/schedule/sessions/${id}`;
    case "request":
      return "/people/requests";
    case "link":
      return id.startsWith("/") && !id.startsWith("//") ? id : null;
    default:
      return null;
  }
}
