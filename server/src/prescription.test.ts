// Lightweight, dependency-free tests for the VBT math. Run: `npm test`.
import assert from "assert";
import {
  epley1rm,
  brzycki1rm,
  e1rmFromLoadVelocity,
  linearFit,
  zoneForVelocity,
  roundToIncrement,
  ageGroup,
  computeTargets,
} from "./prescription";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

console.log("prescription.ts");

test("epley: 100kg x 5 → 116.67", () => close(epley1rm(100, 5), 100 * (1 + 5 / 30)));
test("brzycki: 100kg x 5 → 112.5", () => close(brzycki1rm(100, 5), (100 * 36) / 32));

test("linearFit recovers a known line v = 1.2 - 0.005*load", () => {
  const pts = [80, 100, 120].map((loadKg) => ({ loadKg, velocity: 1.2 - 0.005 * loadKg }));
  const fit = linearFit(pts)!;
  close(fit.a, 1.2, 1e-6);
  close(fit.b, -0.005, 1e-6);
});

test("e1rmFromLoadVelocity: v=1.2-0.005L at MVT 0.3 → 180kg", () => {
  const pts = [80, 100, 120].map((loadKg) => ({ loadKg, velocity: 1.2 - 0.005 * loadKg }));
  close(e1rmFromLoadVelocity(pts, 0.3)!, 180, 1e-6);
});

test("e1rmFromLoadVelocity rejects non-decreasing velocity", () => {
  const pts = [{ loadKg: 80, velocity: 0.4 }, { loadKg: 120, velocity: 0.6 }];
  assert.strictEqual(e1rmFromLoadVelocity(pts, 0.3), null);
});

test("linearFit needs ≥2 distinct loads", () => {
  assert.strictEqual(linearFit([{ loadKg: 100, velocity: 0.5 }, { loadKg: 100, velocity: 0.6 }]), null);
});

test("zones", () => {
  assert.strictEqual(zoneForVelocity(0.4), "STRENGTH");
  assert.strictEqual(zoneForVelocity(0.6), "STRENGTH_SPEED");
  assert.strictEqual(zoneForVelocity(0.9), "SPEED_STRENGTH");
  assert.strictEqual(zoneForVelocity(1.3), "SPEED");
});

test("roundToIncrement 2.5kg", () => {
  assert.strictEqual(roundToIncrement(101, 2.5), 100);
  assert.strictEqual(roundToIncrement(104, 2.5), 105);
});

test("ageGroup buckets", () => {
  const asOf = new Date("2026-06-13");
  assert.strictEqual(ageGroup(new Date("2017-01-01"), asOf), "U10");
  assert.strictEqual(ageGroup(new Date("2012-01-01"), asOf), "U16");
  assert.strictEqual(ageGroup(new Date("2009-01-01"), asOf), "U18");
  assert.strictEqual(ageGroup(new Date("2000-01-01"), asOf), "Open");
});

test("computeTargets PCT with e1RM → rounded load", () => {
  const t = computeTargets({ prescribeBy: "PCT", targetPctE1rm: 0.75 }, 180, 2.5);
  assert.strictEqual(t.targetLoadKg, 135); // 0.75*180 = 135
  assert.ok(t.display.includes("135 kg"));
});

test("computeTargets PCT without e1RM → percent-only display", () => {
  const t = computeTargets({ prescribeBy: "PCT", targetPctE1rm: 0.7 }, null);
  assert.strictEqual(t.targetLoadKg, null);
  assert.ok(t.display.includes("70% e1RM"));
});

test("computeTargets VELOCITY infers zone", () => {
  const t = computeTargets({ prescribeBy: "VELOCITY", targetVelocity: 0.8 }, null);
  assert.strictEqual(t.zone, "SPEED_STRENGTH");
  assert.strictEqual(t.targetVelocity, 0.8);
});

test("computeTargets TEXT falls back to free-text load", () => {
  const t = computeTargets({ prescribeBy: "TEXT", load: "RPE 8" }, 180);
  assert.strictEqual(t.display, "RPE 8");
});

console.log(`\n${passed} tests passed.`);
