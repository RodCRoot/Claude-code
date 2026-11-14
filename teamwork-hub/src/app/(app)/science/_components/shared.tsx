import Link from "next/link";
import { Badge, Select } from "@/components/ui";
import type { ScopedAthlete } from "@/lib/science/access";
import { FORMULAS, type FormulaKey } from "@/lib/science/formulas";
import { VENDOR_LABEL, isVendor } from "@/lib/science/kpis";

export type SP = Promise<Record<string, string | string[] | undefined>>;
export const sp1 = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
export const isYmd = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Choose the athlete from ?athlete=, falling back to the first in scope. Never trusts an id outside the list. */
export function pickAthlete(list: ScopedAthlete[], param: string): ScopedAthlete | null {
  return list.find((a) => a.id === param) ?? list[0] ?? null;
}

/** GET form to switch athlete while keeping other params. */
export function AthletePicker({ athletes, current, extra = {}, label = "Athlete" }: { athletes: { id: string; name: string }[]; current: string | null; extra?: Record<string, string>; label?: string }) {
  if (athletes.length <= 1) return null;
  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      {Object.entries(extra).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <div>
        <label htmlFor="athlete-picker" className="block text-xs font-medium text-ink-3">
          {label}
        </label>
        <Select id="athlete-picker" name="athlete" defaultValue={current ?? ""} className="min-w-52">
          {athletes.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>
      <button type="submit" className="h-10 rounded-lg border border-edge px-3 text-sm font-medium hover:bg-surface-2">
        Show
      </button>
    </form>
  );
}

export function FormulaTag({ k }: { k: FormulaKey }) {
  const f = FORMULAS[k];
  return (
    <Badge variant="blue" title={`${f.name}: ${f.definition} Unit: ${f.unit}`}>
      Teamwork calc · {k}
    </Badge>
  );
}

export function SourceBadge({ source }: { source: string }) {
  return <Badge variant={isVendor(source) ? "yellow" : source === "teamwork_derived" ? "blue" : "neutral"}>{VENDOR_LABEL[source] ?? source}</Badge>;
}

export function NoResponse() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-ink-3 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-ink-2">
      <span aria-hidden>○</span> No response
    </span>
  );
}

export function fmtN(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(digits);
}

export function HealthOnly({ children }: { children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-edge px-5 py-6 text-sm text-ink-3">
      {children ?? "Health and wellness data is limited to coaches/admins assigned to the athlete, the athlete, and guardians with health access."}
    </div>
  );
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-sm text-ink-3 underline-offset-2 hover:text-ink hover:underline">
      ← {children}
    </Link>
  );
}
