/**
 * Body heat map region registry + original SVG geometry (Teamwork design, viewBox 0 0 200 420).
 * Pure module: safe to import from client components.
 *
 * Front view: the athlete faces the viewer, so the athlete's RIGHT side is on the viewer's left.
 * Back view: the viewer sees the athlete's back, so the athlete's LEFT side is on the viewer's left.
 */

export type BodyView = "front" | "back";
export type BodySide = "left" | "right" | "center";

export type RegionDef = { region: string; label: string; views: BodyView[]; sided: boolean };

export const REGIONS: RegionDef[] = [
  { region: "head_neck", label: "Head / neck", views: ["front", "back"], sided: false },
  { region: "shoulder", label: "Shoulder", views: ["front", "back"], sided: true },
  { region: "chest", label: "Chest", views: ["front"], sided: false },
  { region: "upper_back", label: "Upper back", views: ["back"], sided: false },
  { region: "lower_back", label: "Lower back", views: ["back"], sided: false },
  { region: "elbow", label: "Elbow", views: ["front", "back"], sided: true },
  { region: "wrist_hand", label: "Wrist / hand", views: ["front", "back"], sided: true },
  { region: "hip_groin", label: "Hip / groin", views: ["front"], sided: true },
  { region: "glute", label: "Glute", views: ["back"], sided: true },
  { region: "quad", label: "Quad (front thigh)", views: ["front"], sided: true },
  { region: "hamstring", label: "Hamstring (back thigh)", views: ["back"], sided: true },
  { region: "knee", label: "Knee", views: ["front", "back"], sided: true },
  { region: "calf_shin", label: "Calf / shin", views: ["front", "back"], sided: true },
  { region: "ankle_foot", label: "Ankle / foot", views: ["front", "back"], sided: true },
];

export const REGION_BY_KEY = Object.fromEntries(REGIONS.map((r) => [r.region, r]));

export function regionLabel(region: string, side: string): string {
  const r = REGION_BY_KEY[region];
  const base = r?.label ?? region;
  return side === "center" || side === "bilateral" || !r?.sided ? base : `${side === "left" ? "Left" : "Right"} ${base.toLowerCase()}`;
}

export function isValidSpot(view: string, region: string, side: string): boolean {
  const r = REGION_BY_KEY[region];
  if (!r || !r.views.includes(view as BodyView)) return false;
  return r.sided ? side === "left" || side === "right" : side === "center";
}

type Shape = { kind: "rect"; x: number; y: number; w: number; h: number; r: number } | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number };

/** Geometry of the viewer-left instance of each region (or the centered one). */
const BASE: Record<string, Shape> = {
  head_neck: { kind: "rect", x: 80, y: 8, w: 40, h: 62, r: 18 },
  shoulder: { kind: "ellipse", cx: 62, cy: 90, rx: 17, ry: 13 },
  chest: { kind: "rect", x: 77, y: 80, w: 46, h: 56, r: 10 },
  upper_back: { kind: "rect", x: 77, y: 80, w: 46, h: 54, r: 10 },
  lower_back: { kind: "rect", x: 79, y: 138, w: 42, h: 36, r: 8 },
  elbow: { kind: "ellipse", cx: 44, cy: 150, rx: 10, ry: 11 },
  wrist_hand: { kind: "ellipse", cx: 35, cy: 206, rx: 10, ry: 15 },
  hip_groin: { kind: "rect", x: 77, y: 178, w: 22, h: 30, r: 8 },
  glute: { kind: "rect", x: 77, y: 178, w: 22, h: 32, r: 10 },
  quad: { kind: "rect", x: 76, y: 214, w: 22, h: 66, r: 10 },
  hamstring: { kind: "rect", x: 76, y: 214, w: 22, h: 66, r: 10 },
  knee: { kind: "ellipse", cx: 87, cy: 294, rx: 12, ry: 11 },
  calf_shin: { kind: "rect", x: 78, y: 310, w: 18, h: 58, r: 8 },
  ankle_foot: { kind: "ellipse", cx: 87, cy: 386, rx: 13, ry: 11 },
};

function mirror(s: Shape): Shape {
  return s.kind === "rect" ? { ...s, x: 200 - s.x - s.w } : { ...s, cx: 200 - s.cx };
}

export type Spot = { view: BodyView; region: string; side: BodySide; label: string; shape: Shape };

/** Every clickable spot for a view, with correct anatomical side mapping. */
export function spotsFor(view: BodyView): Spot[] {
  const out: Spot[] = [];
  for (const r of REGIONS) {
    if (!r.views.includes(view)) continue;
    const base = BASE[r.region];
    if (!r.sided) {
      out.push({ view, region: r.region, side: "center", label: regionLabel(r.region, "center"), shape: base });
      continue;
    }
    const viewerLeftSide: BodySide = view === "front" ? "right" : "left";
    const viewerRightSide: BodySide = view === "front" ? "left" : "right";
    out.push({ view, region: r.region, side: viewerLeftSide, label: regionLabel(r.region, viewerLeftSide), shape: base });
    out.push({ view, region: r.region, side: viewerRightSide, label: regionLabel(r.region, viewerRightSide), shape: mirror(base) });
  }
  return out;
}

export type HeatReport = { region: string; side: string; severity: number; kind: "soreness" | "pain"; reportedAt: Date | string };

/** Max self-reported severity per region+side within the window (most recent reports only). */
export function heatOverlay(reports: readonly HeatReport[], now: Date, days: number): Map<string, { severity: number; pain: boolean; count: number }> {
  const since = now.getTime() - days * 86_400_000;
  const out = new Map<string, { severity: number; pain: boolean; count: number }>();
  for (const r of reports) {
    const t = new Date(r.reportedAt).getTime();
    if (t < since || t > now.getTime()) continue;
    const k = `${r.region}:${r.side}`;
    const prev = out.get(k);
    out.set(k, { severity: Math.max(prev?.severity ?? 0, r.severity), pain: (prev?.pain ?? false) || r.kind === "pain", count: (prev?.count ?? 0) + 1 });
  }
  return out;
}

/** Should this report create a coach review task? Pain always; soreness at/above threshold. */
export function needsReview(kind: "soreness" | "pain", severity: number, sorenessThreshold: number): boolean {
  return kind === "pain" || severity >= sorenessThreshold;
}

export const BODY_MAP_DISCLAIMER =
  "This records self-reported symptoms only. It is not a diagnosis, and a report (or the absence of one) does not clear an athlete to train. Seek a qualified medical professional for injuries.";
