import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { HoleOverlayPoint, theme } from "./theme";

// All marker positions are normalized (0-1) coordinates on the FINAL framing of the
// approved clip, entered per-hole in course.json (holes[n].overlay). Markers fade in
// at their atSec time so hazards appear as the camera reveals them.

const useAppear = (atSec?: number | null) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const start = Math.round((atSec ?? 0.8) * fps);
  const enter = spring({ frame: frame - start, fps, config: { damping: 200, stiffness: 100 } });
  const outStart = durationInFrames - Math.round(theme.timing.outBeforeEnd * fps);
  const exit = interpolate(frame, [outStart, durationInFrames - 5], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return enter * exit;
};

const Label: React.FC<{ text?: string; color: string }> = ({ text, color }) =>
  text ? (
    <div
      style={{
        position: "absolute",
        top: "115%",
        left: "50%",
        transform: "translateX(-50%)",
        whiteSpace: "nowrap",
        fontFamily: theme.font.family,
        fontWeight: theme.font.labelWeight,
        fontSize: 22,
        letterSpacing: 2,
        color: theme.color.ink,
        background: theme.color.panel,
        borderLeft: `4px solid ${color}`,
        padding: "4px 12px",
        borderRadius: 6,
      }}
    >
      {text}
    </div>
  ) : null;

export const LandingZoneRing: React.FC<{ point: HoleOverlayPoint }> = ({ point }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const opacity = useAppear(point.atSec);
  const pulse = 1 + 0.08 * Math.sin((frame / fps) * Math.PI * 2 * 0.8);
  const r = Math.min(width, height) * 0.055;
  return (
    <div style={{ position: "absolute", left: point.x * width, top: point.y * height, opacity }}>
      <div
        style={{
          position: "absolute",
          left: -r,
          top: -r,
          width: r * 2,
          height: r * 2,
          borderRadius: "50%",
          border: `4px solid ${theme.color.accent}`,
          boxShadow: `0 0 24px ${theme.color.shadow}, inset 0 0 24px rgba(212,175,90,0.25)`,
          transform: `scale(${pulse})`,
        }}
      />
      <Label text={point.label ?? "IDEAL LANDING"} color={theme.color.accent} />
    </div>
  );
};

export const HazardMarker: React.FC<{ point: HoleOverlayPoint }> = ({ point }) => {
  const { width, height } = useVideoConfig();
  const opacity = useAppear(point.atSec);
  const isWater = (point.label ?? "").toUpperCase().includes("WATER");
  const color = isWater ? theme.color.water : theme.color.sand;
  const s = 26;
  return (
    <div style={{ position: "absolute", left: point.x * width, top: point.y * height, opacity }}>
      <div
        style={{
          position: "absolute",
          left: -s / 2,
          top: -s / 2,
          width: s,
          height: s,
          background: color,
          transform: "rotate(45deg)",
          borderRadius: 5,
          boxShadow: `0 4px 16px ${theme.color.shadow}`,
        }}
      />
      <Label text={point.label} color={color} />
    </div>
  );
};

export const GreenMarker: React.FC<{ point: HoleOverlayPoint }> = ({ point }) => {
  const { width, height } = useVideoConfig();
  const opacity = useAppear(point.atSec);
  return (
    <div style={{ position: "absolute", left: point.x * width, top: point.y * height, opacity }}>
      <svg width={44} height={64} viewBox="0 0 44 64" style={{ position: "absolute", left: -6, top: -60 }}>
        <line x1="6" y1="2" x2="6" y2="62" stroke={theme.color.ink} strokeWidth="4" />
        <path d="M8 4 L40 12 L8 22 Z" fill={theme.color.accent} />
      </svg>
      <Label text={point.label ?? "GREEN"} color={theme.color.accent} />
    </div>
  );
};

export const Tracer: React.FC<{ points: HoleOverlayPoint[]; startSec?: number }> = ({ points, startSec = 1.2 }) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  if (points.length < 2) return null;

  const px = points.map((p) => `${p.x * width},${p.y * height}`).join(" ");
  // Rough path length for dash animation
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = (points[i].x - points[i - 1].x) * width;
    const dy = (points[i].y - points[i - 1].y) * height;
    len += Math.hypot(dx, dy);
  }
  const progress = interpolate(frame, [startSec * fps, startSec * fps + 2.2 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const outStart = durationInFrames - Math.round(theme.timing.outBeforeEnd * fps);
  const exit = interpolate(frame, [outStart, durationInFrames - 5], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <svg width={width} height={height} style={{ position: "absolute", opacity: exit }}>
      <polyline
        points={px}
        fill="none"
        stroke={theme.color.tracer}
        strokeWidth={5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={len}
        strokeDashoffset={len * (1 - progress)}
        style={{ filter: `drop-shadow(0 2px 8px ${theme.color.shadow})` }}
        opacity={0.9}
      />
    </svg>
  );
};

export const StrategyText: React.FC<{ text?: string }> = ({ text }) => {
  const opacity = useAppear(2.5);
  if (!text) return null;
  return (
    <div
      style={{
        position: "absolute",
        right: 60,
        bottom: 70,
        fontFamily: theme.font.family,
        fontWeight: theme.font.labelWeight,
        fontSize: 30,
        letterSpacing: 1,
        color: theme.color.ink,
        background: theme.color.panel,
        borderRight: `6px solid ${theme.color.accent}`,
        padding: "12px 22px",
        borderRadius: theme.radius,
        opacity,
      }}
    >
      {text}
    </div>
  );
};
