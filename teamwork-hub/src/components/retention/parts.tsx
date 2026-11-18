import { Badge } from "@/components/ui";
import { Segmented } from "@/components/profile/studio";
import { LEVEL_LABEL, type RiskLevel } from "@/lib/retention/common";

/** Risk level as words plus color (never color alone). */
export function LevelBadge({ level }: { level: RiskLevel }) {
  return <Badge variant={level === "at_risk" ? "red" : level === "watch" ? "yellow" : "green"}>{LEVEL_LABEL[level]}</Badge>;
}

export function RetentionNav({ current, manager }: { current: "radar" | "winback"; manager: boolean }) {
  if (!manager) return null;
  return (
    <Segmented
      label="Retention views"
      items={[
        { href: "/people/retention", label: "Radar", current: current === "radar" },
        { href: "/people/retention/winback", label: "Winback list", current: current === "winback" },
      ]}
    />
  );
}

/** 1–5 rating as text ("4 of 5 · Good"); stars are decorative. */
export function RatingText({ rating, label }: { rating: number; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold tabular">
      <span aria-hidden className="tracking-tight text-warn">
        {"★".repeat(rating)}
        <span className="text-edge">{"★".repeat(5 - rating)}</span>
      </span>
      {rating} of 5{label ? ` · ${label}` : ""}
    </span>
  );
}
