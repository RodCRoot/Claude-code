/**
 * Engagement visuals drawn in code: badge medallions, the level ring, the streak flame and the
 * week dots. No external images. Every graphic either carries its own accessible name
 * (role="img" + <title>) or is aria-hidden next to the same information as text.
 */
import { cn } from "@/lib/cn";
import type { BadgeDef, BadgeFamily, BadgeTier } from "@/lib/engagement/badges";
import type { WeekState } from "@/lib/engagement/streaks";

/** Fixed metal palette (not themed) so medallions look the same in light and dark mode. */
const TIER: Record<BadgeTier, { rim: string; face: string; shine: string; ink: string }> = {
  bronze: { rim: "#9a5a2a", face: "#e2a36b", shine: "#f6d2ae", ink: "#4a2508" },
  silver: { rim: "#74808f", face: "#d3dae3", shine: "#f4f7fa", ink: "#27313d" },
  gold: { rim: "#b07b06", face: "#f6c94f", shine: "#fdebb0", ink: "#4a3300" },
  platinum: { rim: "#2b7ea6", face: "#a9def4", shine: "#e4f6fd", ink: "#0d3347" },
};
const LOCKED = { rim: "#8b95a3", face: "#d9dee5", shine: "#eef1f5", ink: "#5b6675" };

/** 24-unit stroke glyphs, one per badge family. */
const GLYPH: Record<BadgeFamily, string> = {
  sessions: "M6 7v10M18 7v10M3 9.5v5M21 9.5v5M6 12h12",
  streak: "M12 3c.6 3.2 4.5 5 4.5 9.5a4.5 4.5 0 01-9 0c0-1.8.8-3.2 1.9-4.2.2 1.6.9 2.6 1.8 2.9-.4-2.8-.2-5.6.8-8.2z",
  pr: "M12 3.5l2.5 5.3 5.8.7-4.3 3.9 1.1 5.8-5.1-2.9-5.1 2.9 1.1-5.8L3.7 9.5l5.8-.7z",
  goal: "M12 20.5a8.5 8.5 0 100-17 8.5 8.5 0 000 17M12 16a4 4 0 100-8 4 4 0 000 8M12 12h.01",
  early: "M3.5 18h17M7 18a5 5 0 0110 0M12 6v3M5.6 10.6l1.9 1.9M18.4 10.6l-1.9 1.9",
  forms: "M7 3.5h7l4 4v13H7zM14 3.5v4h4M9.5 14l2 2 3.5-4",
  member: "M12 3.5l7 2.6v5.4c0 4.4-3 7.2-7 8.5-4-1.3-7-4.1-7-8.5V6.1zM9 12l2.2 2.2L15 10.4",
  challenge: "M8 4h8v5a4 4 0 01-8 0zM8 6H5v1.5A3 3 0 008 10.5M16 6h3v1.5a3 3 0 01-3 3M12 13v4M8.5 20h7M10 17h4",
};

/** Badge medallion. `locked` draws a grey version for badges not earned yet. */
export function BadgeMedallion({ def, locked = false, size = 64, className }: { def: BadgeDef; locked?: boolean; size?: number; className?: string }) {
  const c = locked ? LOCKED : TIER[def.tier];
  const label = `${def.name} badge${locked ? " (not earned yet)" : ""}`;
  const withMark = def.mark !== null;
  // Glyph box: smaller and higher when a number sits under it.
  const g = withMark ? { x: 22, y: 12, s: 20 / 24 } : { x: 17, y: 17, s: 30 / 24 };
  return (
    <svg role="img" aria-label={label} viewBox="0 0 64 64" width={size} height={size} className={cn("shrink-0", className)}>
      <title>{label}</title>
      <circle cx="32" cy="32" r="31" fill={c.rim} />
      <circle cx="32" cy="32" r="26.5" fill={c.face} />
      <path d="M12.5 26.5A20.5 20.5 0 0132 11.5" fill="none" stroke={c.shine} strokeWidth="3" strokeLinecap="round" />
      <circle cx="32" cy="32" r="26.5" fill="none" stroke={c.rim} strokeWidth="1" strokeDasharray="1.5 3" opacity="0.7" />
      <g transform={`translate(${g.x} ${g.y}) scale(${g.s})`} fill="none" stroke={c.ink} strokeWidth={withMark ? 2.2 : 1.9} strokeLinecap="round" strokeLinejoin="round">
        <path d={GLYPH[def.family]} />
      </g>
      {withMark ? (
        <text x="32" y="48.5" textAnchor="middle" fontSize={def.mark!.length > 2 ? 13 : 15} fontWeight="800" fill={c.ink} fontFamily="inherit">
          {def.mark}
        </text>
      ) : null}
    </svg>
  );
}

/**
 * Circular level progress. Decorative: the caller prints level, XP and XP-to-next as text.
 * `tone="dark"` is for the navy hero band, `tone="light"` for cards.
 */
export function LevelRing({ level, pct, size = 96, tone = "dark" }: { level: number; pct: number; size?: number; tone?: "dark" | "light" }) {
  const r = 42;
  const circ = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" className={tone === "dark" ? "stroke-white/15" : "stroke-ink-3/20"} />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${(circ * Math.max(p, 2)) / 100} ${circ}`}
          transform="rotate(-90 50 50)"
          className={tone === "dark" ? "stroke-[#4fc3f7]" : "stroke-brand"}
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        {size >= 76 ? <span className={cn("text-[10px] font-bold uppercase tracking-[0.14em]", tone === "dark" ? "text-[#b9c6da]" : "text-ink-3")}>Level</span> : null}
        <span className={cn("mt-0.5 font-extrabold tabular", size >= 90 ? "text-[34px]" : "text-2xl", tone === "dark" ? "text-white" : "text-ink")}>{level}</span>
      </span>
    </span>
  );
}

/** Flame mark for the streak number. Decorative. */
export function Flame({ lit = true, className }: { lit?: boolean; className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className={cn("size-7 shrink-0", className)}>
      <path d="M12 2c.8 4 5.5 6.3 5.5 12a5.5 5.5 0 01-11 0c0-2.2 1-4 2.3-5.2.3 2 1.1 3.2 2.2 3.6-.5-3.5-.2-7 1-10.4z" fill={lit ? "#fbbf24" : "#7f8ea8"} />
      <path d="M12 12.5c.4 1.5 2.3 2.3 2.3 4.3a2.3 2.3 0 01-4.6 0c0-1.7 1.5-2.500 2.3-4.3z" fill={lit ? "#fff3c4" : "#c9d4e5"} />
    </svg>
  );
}

const WEEK_WORD: Record<WeekState, string> = { active: "trained", hold: "on hold", open: "this week, not yet", rest: "rest week" };

/** Recent weeks as dots with the state spelled out for screen readers and in the title. */
export function WeekDots({ weeks, tone = "dark" }: { weeks: { weekStart: string; label: string; state: WeekState }[]; tone?: "dark" | "light" }) {
  const dark = tone === "dark";
  return (
    <ol className="flex items-end gap-1.5" aria-label="Recent weeks">
      {weeks.map((w) => (
        <li key={w.weekStart} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`Week of ${w.label}: ${WEEK_WORD[w.state]}`}>
          <span
            aria-hidden
            className={cn(
              "flex h-7 w-full max-w-11 items-center justify-center rounded-md text-xs font-extrabold",
              w.state === "active" && (dark ? "bg-[#4fc3f7] text-[#0b1a2e]" : "bg-brand text-brand-ink"),
              w.state === "hold" && (dark ? "bg-white/10 text-[#c9d4e5] ring-1 ring-white/25" : "bg-surface-2 text-ink-2 ring-1 ring-edge"),
              w.state === "open" && (dark ? "border-2 border-dashed border-[#4fc3f7]/70 text-[#7fd3f7]" : "border-2 border-dashed border-brand/60 text-brand"),
              w.state === "rest" && (dark ? "bg-white/[0.06] text-[#93a3bd]" : "bg-surface-2 text-ink-3"),
            )}
          >
            {w.state === "active" ? "✓" : w.state === "hold" ? "II" : w.state === "open" ? "•" : ""}
          </span>
          <span className={cn("text-[10px] leading-none whitespace-nowrap", dark ? "text-[#b9c6da]" : "text-ink-3")}>
            {w.label}
            <span className="sr-only">: {WEEK_WORD[w.state]}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
