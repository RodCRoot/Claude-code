// Course-wide graphics constants. Change here, never per-hole (STYLE-BIBLE.md §3/§5).
export const theme = {
  font: {
    // Drop brand webfonts into public/fonts and register via @remotion/fonts if desired;
    // this stack renders cleanly without any font files.
    family: "'Archivo', 'Inter', 'Helvetica Neue', Arial, sans-serif",
    numberWeight: 800,
    labelWeight: 600,
  },
  color: {
    ink: "#FFFFFF",
    inkSoft: "rgba(255,255,255,0.85)",
    panel: "rgba(10, 26, 18, 0.72)", // deep broadcast green-black
    accent: "#D4AF5A", // muted broadcast gold
    water: "#4A90C4",
    sand: "#D8C08A",
    tracer: "#FFFFFF",
    shadow: "rgba(0,0,0,0.45)",
  },
  radius: 10,
  // Overlay timing (seconds)
  timing: {
    cardIn: 0.4,
    cardHold: 4.0,
    outBeforeEnd: 1.0,
  },
} as const;

export type HoleOverlayPoint = {
  x: number; // normalized 0-1
  y: number;
  atSec?: number | null;
  label?: string;
};

export type HoleProps = {
  courseName: string;
  holeNumber: number;
  par: number;
  yardage: number;
  strategyText?: string;
  overlay?: {
    landingZone?: HoleOverlayPoint | null;
    greenMarker?: HoleOverlayPoint | null;
    hazards?: HoleOverlayPoint[];
    tracer?: HoleOverlayPoint[];
  };
  videoSrc: string; // filename inside public/
  showOverlay: boolean;
};
