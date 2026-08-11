import React from "react";
import { Composition } from "remotion";
import { HoleComposition } from "./HoleComposition";
import { HoleProps } from "./theme";

const FPS = 30;
const DEFAULT_DURATION_SEC = 12; // override per render with --duration or calculateMetadata

// Default props mirror schema/course.example.json hole 7 so `remotion studio`
// shows a working example. For production renders pass real values from
// course.json via --props='{"holeNumber":1,...}'.
const exampleProps: HoleProps = {
  courseName: "Sample Valley Golf Club",
  holeNumber: 7,
  par: 4,
  yardage: 412,
  strategyText: "Favor the left side.",
  videoSrc: "hole07_approved.mp4",
  showOverlay: true,
  overlay: {
    landingZone: { x: 0.48, y: 0.55, atSec: 3.5, label: "IDEAL LANDING" },
    greenMarker: { x: 0.52, y: 0.24, atSec: 8.5, label: "GREEN" },
    hazards: [
      { x: 0.63, y: 0.5, atSec: 4.5, label: "BUNKERS 240/265" },
      { x: 0.6, y: 0.28, atSec: 9.0, label: "WATER" },
    ],
    tracer: [
      { x: 0.5, y: 0.88 },
      { x: 0.48, y: 0.55 },
      { x: 0.52, y: 0.24 },
    ],
  },
};

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="HoleClean169"
        component={HoleComposition}
        durationInFrames={DEFAULT_DURATION_SEC * FPS}
        fps={FPS}
        width={3840}
        height={2160}
        defaultProps={{ ...exampleProps, showOverlay: false }}
      />
      <Composition
        id="HoleStrategy169"
        component={HoleComposition}
        durationInFrames={DEFAULT_DURATION_SEC * FPS}
        fps={FPS}
        width={3840}
        height={2160}
        defaultProps={{ ...exampleProps, showOverlay: true }}
      />
      <Composition
        id="HoleStrategy916"
        component={HoleComposition}
        durationInFrames={DEFAULT_DURATION_SEC * FPS}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{ ...exampleProps, showOverlay: true, compact: true }}
      />
    </>
  );
};
