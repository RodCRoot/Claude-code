"use client";

import { spotsFor, type BodyView, type Spot } from "@/lib/science/body-regions";

export type HeatEntry = { severity: number; pain: boolean; count: number };

/**
 * Original Teamwork body figure (front/back). Regions are keyboard-focusable buttons when
 * `onSelect` is provided; otherwise the figure is a read-only heat overlay.
 * Heat = recent max self-reported severity (0–10) as a single-hue opacity ramp; pain adds a ring.
 */
export function BodyFigure({
  view,
  heat,
  selected,
  onSelect,
  className,
  title,
}: {
  view: BodyView;
  heat?: Record<string, HeatEntry>;
  selected?: { region: string; side: string } | null;
  onSelect?: (s: Spot) => void;
  className?: string;
  title?: string;
}) {
  const spots = spotsFor(view);
  const sil = "fill-surface-2 stroke-edge";
  return (
    <svg viewBox="0 0 200 420" className={className} role={onSelect ? "group" : "img"} aria-label={title ?? `${view === "front" ? "Front" : "Back"} body view`}>
      <text x="100" y="416" textAnchor="middle" className="fill-ink-3" fontSize="9">
        {view === "front" ? "FRONT · athlete's right is on your left" : "BACK · athlete's left is on your left"}
      </text>
      {/* Silhouette (decorative) */}
      <g aria-hidden className={sil} strokeWidth="1">
        <rect x="82" y="6" width="36" height="58" rx="18" />
        <rect x="70" y="74" width="60" height="140" rx="18" />
        <rect x="40" y="82" width="20" height="136" rx="10" transform="rotate(6 50 82)" />
        <rect x="140" y="82" width="20" height="136" rx="10" transform="rotate(-6 150 82)" />
        <rect x="74" y="206" width="25" height="194" rx="12" />
        <rect x="101" y="206" width="25" height="194" rx="12" />
      </g>
      {spots.map((s) => {
        const h = heat?.[`${s.region}:${s.side}`];
        const isSel = selected?.region === s.region && selected?.side === s.side;
        const opacity = h ? 0.2 + (h.severity / 10) * 0.7 : 0;
        const common = {
          className: `${h ? "fill-[#eb6834] dark:fill-[#d95926]" : "fill-transparent"} ${isSel ? "stroke-brand" : h?.pain ? "stroke-ink" : "stroke-ink-3/40"} ${onSelect ? "cursor-pointer hover:stroke-brand focus:outline-none focus-visible:stroke-brand" : ""}`,
          fillOpacity: h ? opacity : 1,
          strokeWidth: isSel ? 3 : h?.pain ? 2 : 1,
          strokeDasharray: h || isSel ? undefined : "3 2",
        };
        const label = `${s.label}${h ? `, recent max severity ${h.severity} of 10${h.pain ? ", pain reported" : ""}` : ""}`;
        const shape = s.shape.kind === "rect" ? <rect x={s.shape.x} y={s.shape.y} width={s.shape.w} height={s.shape.h} rx={s.shape.r} {...common} /> : <ellipse cx={s.shape.cx} cy={s.shape.cy} rx={s.shape.rx} ry={s.shape.ry} {...common} />;
        return onSelect ? (
          <g
            key={`${s.region}:${s.side}`}
            role="button"
            tabIndex={0}
            aria-label={label}
            aria-pressed={isSel}
            onClick={() => onSelect(s)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(s);
              }
            }}
          >
            <title>{label}</title>
            {shape}
          </g>
        ) : (
          <g key={`${s.region}:${s.side}`}>
            <title>{label}</title>
            {shape}
          </g>
        );
      })}
    </svg>
  );
}

export function HeatLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-ink-3">
      <span>Recent max severity:</span>
      {[2, 5, 8].map((s) => (
        <span key={s} className="flex items-center gap-1">
          <span aria-hidden className="inline-block size-3 rounded-sm bg-[#eb6834] dark:bg-[#d95926]" style={{ opacity: 0.2 + (s / 10) * 0.7 }} />
          {s}/10
        </span>
      ))}
      <span className="flex items-center gap-1">
        <span aria-hidden className="inline-block size-3 rounded-sm border-2 border-ink" /> pain reported
      </span>
    </div>
  );
}
