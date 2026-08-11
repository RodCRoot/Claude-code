import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { HoleInfoCard } from "./HoleInfoCard";
import { GreenMarker, HazardMarker, LandingZoneRing, StrategyText, Tracer } from "./StrategyOverlay";
import { HoleProps } from "./theme";

// One composition renders both deliverables: showOverlay=false → clean version,
// showOverlay=true → strategy version. The approved clip must be copied into
// public/ first (e.g. public/hole07_approved.mp4) and named in props.videoSrc.
export const HoleComposition: React.FC<HoleProps & { compact?: boolean }> = ({
  courseName,
  holeNumber,
  par,
  yardage,
  strategyText,
  overlay,
  videoSrc,
  showOverlay,
  compact,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <OffthreadVideo src={staticFile(videoSrc)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      {showOverlay ? (
        <AbsoluteFill>
          {overlay?.tracer && overlay.tracer.length >= 2 ? <Tracer points={overlay.tracer} /> : null}
          {overlay?.landingZone ? <LandingZoneRing point={overlay.landingZone} /> : null}
          {(overlay?.hazards ?? []).map((h, i) => (
            <HazardMarker key={i} point={h} />
          ))}
          {overlay?.greenMarker ? <GreenMarker point={overlay.greenMarker} /> : null}
          <StrategyText text={strategyText} />
        </AbsoluteFill>
      ) : null}
      <HoleInfoCard courseName={courseName} holeNumber={holeNumber} par={par} yardage={yardage} compact={compact} />
    </AbsoluteFill>
  );
};
