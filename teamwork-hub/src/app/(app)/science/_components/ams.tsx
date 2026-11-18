/**
 * AMS (athlete management) presentation pieces: traffic-light readiness heat-table cells,
 * legend, and ACWR zone chips. Presentational only. Every colored cell also prints its value as
 * text plus a tier word for screen readers — color is never the only signal. Cell colors are
 * fixed light tints with dark text (≥ 7:1) so they read the same in light and dark themes.
 */
import Link from "next/link";
import { cn } from "@/lib/cn";
import type { QuestionDef } from "@/db/schema";
import { normalizeScale } from "@/lib/science/formulas";
import type { GridRow } from "@/lib/science/wellness";
import { fmt } from "@/lib/time";
import { NoResponse } from "./shared";

export type Tier = "good" | "moderate" | "poor" | "none";

export const TIER_STYLE: Record<Tier, string> = {
  good: "bg-[#d3f5df] text-[#0f3d22]",
  moderate: "bg-[#fdefc3] text-[#5c3a03]",
  poor: "bg-[#fcd9d9] text-[#6e1414]",
  none: "bg-surface-2 text-ink-2",
};
const TIER_WORD: Record<Tier, string> = { good: "good", moderate: "moderate", poor: "poor", none: "not scored" };
const TIER_GLYPH: Record<Tier, string> = { good: "●", moderate: "◆", poor: "▲", none: "" };

/** Tier from a 0–100 "higher is better" score (Teamwork display bands: ≥67 / 34–66 / <34). */
export function tierOf(score: number | null): Tier {
  if (score === null || !Number.isFinite(score)) return "none";
  return score >= 67 ? "good" : score >= 34 ? "moderate" : "poor";
}

export function HeatCell({ tier, children, title, className }: { tier: Tier; children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cn("inline-flex min-w-12 items-center justify-center gap-1 rounded-md px-2 py-1 text-sm font-bold tabular", TIER_STYLE[tier], className)}>
      {TIER_GLYPH[tier] ? <span aria-hidden className="text-[10px]">{TIER_GLYPH[tier]}</span> : null}
      {children}
      {tier !== "none" ? <span className="sr-only"> ({TIER_WORD[tier]})</span> : null}
    </span>
  );
}

export function HeatLegend({ className }: { className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-2 text-xs text-ink-3", className)}>
      <span>Cells show the answer; color = polarity-normalized band:</span>
      <HeatCell tier="good" className="min-w-0! py-0.5! text-xs!">good</HeatCell>
      <HeatCell tier="moderate" className="min-w-0! py-0.5! text-xs!">moderate</HeatCell>
      <HeatCell tier="poor" className="min-w-0! py-0.5! text-xs!">poor</HeatCell>
      <span>· blank = no answer</span>
    </p>
  );
}

/** Scale questions that can be colored (have a direction). Others still show as plain values. */
export function heatColumns(questions: QuestionDef[]) {
  return questions.filter((q) => q.kind === "scale" || q.kind === "number").slice(0, 8);
}

function cellFor(q: QuestionDef, answers: Record<string, unknown> | null) {
  const v = answers?.[q.key];
  if (v === undefined || v === null || v === "") return <span className="text-xs text-ink-3">—</span>;
  const score = normalizeScale(v, q);
  return (
    <HeatCell tier={tierOf(score)} title={`${q.label}: ${String(v)}${q.kind === "scale" && q.min != null && q.max != null ? ` (${q.min}–${q.max})` : ""}`}>
      {String(v)}
    </HeatCell>
  );
}

/**
 * Readiness heat-table: athletes (rows) × questionnaire items (columns), plus Teamwork readiness,
 * flags and submission time. Wrapped in a focusable scroll region so it never widens the page.
 */
export function ReadinessHeatTable({ rows, questions, caption, hrefFor }: { rows: GridRow[]; questions: QuestionDef[]; caption: string; hrefFor?: (athleteId: string) => string }) {
  const cols = heatColumns(questions);
  return (
    <div className="relative overflow-x-auto rounded-md border border-edge" tabIndex={0} role="region" aria-label={caption}>
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-th">
            <th scope="col" className="sticky left-0 z-10 border-b border-edge bg-th px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-ink-2">
              Athlete
            </th>
            <th scope="col" className="border-b border-edge px-2 py-2 text-center text-[11px] font-bold uppercase tracking-wide text-ink-2">
              Readiness
            </th>
            {cols.map((q) => (
              <th key={q.key} scope="col" className="border-b border-edge px-2 py-2 text-center text-[11px] font-bold uppercase tracking-wide text-ink-2">
                <span className="block">{q.label}</span>
                {q.kind === "scale" ? (
                  <span className="block font-medium normal-case tracking-normal text-ink-3">
                    {q.min}–{q.max}
                    {q.polarity === "lower_better" ? " · low = good" : q.polarity === "higher_better" ? " · high = good" : ""}
                  </span>
                ) : q.unit ? (
                  <span className="block font-medium normal-case tracking-normal text-ink-3">{q.unit}</span>
                ) : null}
              </th>
            ))}
            <th scope="col" className="border-b border-edge px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-ink-2">
              Flags
            </th>
            <th scope="col" className="border-b border-edge px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-ink-2">
              Submitted
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const score = r.readiness.score;
            return (
              <tr key={r.athleteId} className="border-b border-edge/70 last:border-0">
                <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-semibold whitespace-nowrap">
                  {hrefFor ? (
                    <Link href={hrefFor(r.athleteId)} className="hover:underline">
                      {r.name}
                    </Link>
                  ) : (
                    r.name
                  )}
                  {r.status === "partial" ? <span className="ml-1 text-[11px] font-medium text-warn">partial</span> : null}
                </th>
                <td className="px-2 py-1.5 text-center">
                  {r.status === "no_response" ? (
                    <NoResponse />
                  ) : r.status === "not_scheduled" ? (
                    <span className="text-xs text-ink-3">Not scheduled</span>
                  ) : score === null ? (
                    <span className="text-xs text-ink-3">{r.readiness.reason ?? "—"}</span>
                  ) : (
                    <HeatCell tier={tierOf(score)} className="min-w-14! text-base!">
                      {Math.round(score)}
                    </HeatCell>
                  )}
                </td>
                {cols.map((q) => (
                  <td key={q.key} className="px-2 py-1.5 text-center">
                    {cellFor(q, r.answers)}
                  </td>
                ))}
                <td className="px-3 py-1.5">
                  {r.flags.length ? (
                    <span className="flex flex-wrap gap-1">
                      {r.flags.map((f) => (
                        <span key={f.key} title={`Rule ${f.rule}`} className="inline-flex items-center gap-1 rounded-full border border-bad/30 bg-bad/10 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-bad">
                          ⚑ {f.label}: {String(f.value)}
                        </span>
                      ))}
                    </span>
                  ) : r.status === "no_response" ? (
                    <span className="text-xs text-ink-3">Unknown — no answers</span>
                  ) : (
                    <span className="text-xs text-ink-3">None</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-xs whitespace-nowrap text-ink-3">{r.submittedAt ? `${fmt(r.submittedAt, "h:mm a")}${r.version ? ` · v${r.version}` : ""}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** ACWR zone chip: text label + value; the color only reinforces it. */
export function AcwrChip({ ratio, high, low }: { ratio: number | null; high: number; low: number }) {
  if (ratio === null) return <span className="inline-flex rounded-md bg-surface-2 px-2 py-1 text-xs font-semibold text-ink-2">Insufficient data</span>;
  const tier: Tier = ratio > high ? "poor" : ratio < low ? "moderate" : "good";
  const word = ratio > high ? "High" : ratio < low ? "Low" : "In range";
  return (
    <HeatCell tier={tier} className="text-xs!">
      {word} · {ratio.toFixed(2)}
    </HeatCell>
  );
}
