import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "./theme";

export const HoleInfoCard: React.FC<{
  courseName: string;
  holeNumber: number;
  par: number;
  yardage: number;
  compact?: boolean; // 9:16 layout
}> = ({ courseName, holeNumber, par, yardage, compact }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const inProgress = spring({
    frame: frame - Math.round(theme.timing.cardIn * fps),
    fps,
    config: { damping: 200, stiffness: 90 },
  });
  const outStart = durationInFrames - Math.round(theme.timing.outBeforeEnd * fps);
  const outOpacity = interpolate(frame, [outStart, durationInFrames - 5], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const scale = compact ? 0.85 : 1;

  return (
    <div
      style={{
        position: "absolute",
        left: 60 * scale,
        bottom: 60 * scale,
        display: "flex",
        alignItems: "stretch",
        gap: 14 * scale,
        fontFamily: theme.font.family,
        opacity: inProgress * outOpacity,
        transform: `translateY(${(1 - inProgress) * 40}px)`,
      }}
    >
      <div
        style={{
          background: theme.color.panel,
          borderLeft: `6px solid ${theme.color.accent}`,
          borderRadius: theme.radius,
          padding: `${18 * scale}px ${28 * scale}px`,
          boxShadow: `0 8px 30px ${theme.color.shadow}`,
          display: "flex",
          alignItems: "center",
          gap: 26 * scale,
        }}
      >
        <div style={{ color: theme.color.ink, lineHeight: 1 }}>
          <div style={{ fontSize: 22 * scale, fontWeight: theme.font.labelWeight, letterSpacing: 4, color: theme.color.inkSoft }}>
            HOLE
          </div>
          <div style={{ fontSize: 84 * scale, fontWeight: theme.font.numberWeight }}>{holeNumber}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 * scale }}>
          <Chip label="PAR" value={String(par)} scale={scale} />
          <Chip label="YDS" value={String(yardage)} scale={scale} />
        </div>
        <div
          style={{
            color: theme.color.inkSoft,
            fontSize: 20 * scale,
            fontWeight: theme.font.labelWeight,
            letterSpacing: 2,
            textTransform: "uppercase",
            maxWidth: 260 * scale,
            alignSelf: "flex-end",
            paddingBottom: 6 * scale,
          }}
        >
          {courseName}
        </div>
      </div>
    </div>
  );
};

const Chip: React.FC<{ label: string; value: string; scale: number }> = ({ label, value, scale }) => (
  <div
    style={{
      display: "flex",
      alignItems: "baseline",
      gap: 10 * scale,
      background: "rgba(255,255,255,0.08)",
      borderRadius: 6,
      padding: `${6 * scale}px ${14 * scale}px`,
    }}
  >
    <span style={{ color: theme.color.accent, fontSize: 18 * scale, fontWeight: theme.font.labelWeight, letterSpacing: 3 }}>
      {label}
    </span>
    <span style={{ color: theme.color.ink, fontSize: 34 * scale, fontWeight: theme.font.numberWeight }}>{value}</span>
  </div>
);
