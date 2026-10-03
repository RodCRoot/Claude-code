// Shared metric catalog: used by the demo seed AND the idempotent
// ensure-catalog startup step (so live databases pick up new metric types
// on deploy without reseeding).

export const METRIC_TYPES = [
  { key: "sprint_10m", name: "10m Sprint", unit: "s", category: "SPEED", source: "TIMING", higherIsBetter: false, relativeToBw: false },
  { key: "sprint_40yd", name: "40yd Dash", unit: "s", category: "SPEED", source: "TIMING", higherIsBetter: false, relativeToBw: false },
  { key: "cmj_height", name: "CMJ Jump Height", unit: "cm", category: "JUMP", source: "HAWKIN", higherIsBetter: true, relativeToBw: false },
  { key: "cmj_rsi_mod", name: "CMJ RSI-Modified", unit: "", category: "POWER", source: "HAWKIN", higherIsBetter: true, relativeToBw: false },
  { key: "cmj_peak_power", name: "CMJ Peak Power", unit: "W/kg", category: "POWER", source: "HAWKIN", higherIsBetter: true, relativeToBw: false },
  { key: "dj_rsi", name: "Drop Jump RSI", unit: "", category: "JUMP", source: "OVR", higherIsBetter: true, relativeToBw: false },
  { key: "vertical_jump", name: "Vertical Jump", unit: "cm", category: "JUMP", source: "OVR", higherIsBetter: true, relativeToBw: false },
  { key: "back_squat_1rm", name: "Back Squat 1RM", unit: "kg", category: "STRENGTH", source: "MANUAL", higherIsBetter: true, relativeToBw: true },
  // Informational metrics — excluded from the athletic composite.
  { key: "body_mass", name: "Body Mass", unit: "kg", category: "BODY", source: "HAWKIN", higherIsBetter: true, relativeToBw: false, inComposite: false },
  { key: "fms_deep_squat", name: "FMS Deep Squat", unit: "", category: "MOVEMENT", source: "MANUAL", higherIsBetter: true, relativeToBw: false, inComposite: false },
  { key: "fms_hurdle_step", name: "FMS Hurdle Step", unit: "", category: "MOVEMENT", source: "MANUAL", higherIsBetter: true, relativeToBw: false, inComposite: false },
  { key: "fms_inline_lunge", name: "FMS Inline Lunge", unit: "", category: "MOVEMENT", source: "MANUAL", higherIsBetter: true, relativeToBw: false, inComposite: false },
  { key: "fms_shoulder_mobility", name: "FMS Shoulder Mobility", unit: "", category: "MOVEMENT", source: "MANUAL", higherIsBetter: true, relativeToBw: false, inComposite: false },
  { key: "fms_aslr", name: "FMS Active Straight-Leg Raise", unit: "", category: "MOVEMENT", source: "MANUAL", higherIsBetter: true, relativeToBw: false, inComposite: false },
  { key: "fms_trunk_stability", name: "FMS Trunk Stability Push-Up", unit: "", category: "MOVEMENT", source: "MANUAL", higherIsBetter: true, relativeToBw: false, inComposite: false },
  { key: "fms_rotary_stability", name: "FMS Rotary Stability", unit: "", category: "MOVEMENT", source: "MANUAL", higherIsBetter: true, relativeToBw: false, inComposite: false },
];

export const FMS_KEYS = [
  "fms_deep_squat", "fms_hurdle_step", "fms_inline_lunge", "fms_shoulder_mobility",
  "fms_aslr", "fms_trunk_stability", "fms_rotary_stability",
];
