import { describe, expect, it } from "vitest";
import {
  e1rmFromLvProfile,
  e1rmFromSingleSet,
  liftProfileForName,
  lvLinearFit,
  mvtForName,
  pctFromVelocity,
  relativeStrength,
  relStrengthTier,
  zoneForVelocity,
} from "@/lib/training/vbt";

describe("lv_profile_v1 (own load–velocity data)", () => {
  // Synthetic athlete: v = 1.2 − 0.005·load ⇒ at MVT 0.3, 1RM = 180 kg.
  const points = [
    { loadKg: 90, velocityMs: 0.75 },
    { loadKg: 126, velocityMs: 0.57 },
    { loadKg: 153, velocityMs: 0.435 },
  ];
  it("recovers the line and extrapolates to MVT", () => {
    const fit = lvLinearFit(points)!;
    expect(fit.a).toBeCloseTo(1.2, 3);
    expect(fit.b).toBeCloseTo(-0.005, 4);
    expect(e1rmFromLvProfile(points, 0.3)).toBeCloseTo(180, 0);
  });
  it("needs 2+ distinct loads", () => {
    expect(lvLinearFit([points[0], { ...points[0] }])).toBeNull();
    expect(e1rmFromLvProfile([points[0]], 0.3)).toBeNull();
  });
  it("rejects non-decreasing velocity (junk data)", () => {
    expect(
      e1rmFromLvProfile(
        [
          { loadKg: 90, velocityMs: 0.5 },
          { loadKg: 120, velocityMs: 0.7 },
        ],
        0.3,
      ),
    ).toBeNull();
  });
  it("rejects absurd extrapolations (cap at 2.5× heaviest point)", () => {
    // Nearly flat line → enormous intercept-based 1RM.
    expect(
      e1rmFromLvProfile(
        [
          { loadKg: 60, velocityMs: 0.801 },
          { loadKg: 100, velocityMs: 0.8 },
        ],
        0.3,
      ),
    ).toBeNull();
  });
});

describe("published velocity→%1RM curves", () => {
  it("mpv_squat_v1 anchor points", () => {
    // 121.03 − 71.684·v ⇒ 0.75 m/s → 67.3%; at ~MVT the curve approaches 100%.
    expect(pctFromVelocity(0.75, "squat")).toBeCloseTo(67.3, 1);
    expect(pctFromVelocity(0.3, "squat")!).toBeGreaterThan(99);
  });
  it("mpv_bench_v1 quadratic", () => {
    // 8.4326·0.25 − 73.501·0.5 + 112.33 ≈ 77.7%
    expect(pctFromVelocity(0.5, "bench")).toBeCloseTo(77.7, 1);
  });
  it("mpv_generic_v1 anchors 100% at the exercise MVT", () => {
    expect(pctFromVelocity(0.15, "generic", 0.15)).toBe(100);
  });
  it("clamps to 5–100 and rejects invalid velocity", () => {
    expect(pctFromVelocity(2.5, "squat")).toBe(5);
    expect(pctFromVelocity(0.05, "squat")).toBe(100);
    expect(pctFromVelocity(0, "squat")).toBeNull();
    expect(pctFromVelocity(-1, "bench")).toBeNull();
  });
  it("single-set e1RM: 100 kg @ 0.75 m/s squat ≈ 148.6 kg", () => {
    expect(e1rmFromSingleSet(100, 0.75, "squat")).toBeCloseTo(148.6, 0);
    expect(e1rmFromSingleSet(0, 0.75, "squat")).toBeNull();
  });
});

describe("lift profile + MVT detection from names", () => {
  it("maps names to curves", () => {
    expect(liftProfileForName("Back Squat")).toBe("squat");
    expect(liftProfileForName("Bulgarian Split Squat")).toBe("generic");
    expect(liftProfileForName("Bench Press")).toBe("bench");
    expect(liftProfileForName("Trap Bar Deadlift")).toBe("generic");
    expect(liftProfileForName(null)).toBe("generic");
  });
  it("maps names to MVTs with a fallback", () => {
    expect(mvtForName("Front Squat")).toBe(0.3);
    expect(mvtForName("Bench Press")).toBe(0.17);
    expect(mvtForName("Deadlift")).toBe(0.15);
    expect(mvtForName("Pallof Press")).toBe(0.19); // "press" family
    expect(mvtForName("Nordic Curl")).toBe(0.3); // fallback
  });
});

describe("velocity zones", () => {
  it("classifies intent zones", () => {
    expect(zoneForVelocity(0.4)).toBe("strength");
    expect(zoneForVelocity(0.6)).toBe("strength_speed");
    expect(zoneForVelocity(0.8)).toBe("speed_strength");
    expect(zoneForVelocity(1.2)).toBe("speed");
    expect(zoneForVelocity(0)).toBeNull();
  });
});

describe("rel_strength_v1", () => {
  it("computes ×BW and tiers per lift family", () => {
    expect(relativeStrength(150, 75)).toBe(2);
    expect(relStrengthTier(2.0, "squat")).toBe("elite");
    expect(relStrengthTier(1.49, "squat")).toBe("solid");
    expect(relStrengthTier(1.2, "bench")).toBe("strong");
    expect(relStrengthTier(0.5, "generic")).toBe("developing");
  });
  it("null on missing body mass — never divide by 0", () => {
    expect(relativeStrength(150, 0)).toBeNull();
    expect(relativeStrength(0, 75)).toBeNull();
  });
});
