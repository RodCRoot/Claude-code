import { Callout } from "@/components/ui";
import type { ExclusionSummary } from "@/lib/science/comparability";

/**
 * Discloses sessions or values left out of a trend because they were measured a different way.
 * Text only (no color-only signal); written for families as well as staff.
 */
export function ComparabilityNotice({ excluded, metricName, className }: { excluded: ExclusionSummary[]; metricName: string; className?: string }) {
  if (!excluded.length) return null;
  const total = excluded.reduce((a, e) => a + e.count, 0);
  return (
    <Callout tone="warn" title="Not all results are in this trend" className={className}>
      <p>
        {total} {total === 1 ? "result" : "results"} for {metricName} {total === 1 ? "was" : "were"} measured a different way from the latest result and {total === 1 ? "is" : "are"} shown separately rather than compared. Nothing was converted or merged.
      </p>
      <ul className="mt-1 list-disc pl-5">
        {excluded.map((e) => (
          <li key={e.reason}>
            {e.reason} ({e.count})
          </li>
        ))}
      </ul>
    </Callout>
  );
}
