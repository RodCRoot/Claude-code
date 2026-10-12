import { describe, expect, it } from "vitest";
import { DEFAULT_MEMBERSHIP_POLICY, policyFromSettings, stubPriceMinor } from "@/lib/membership-policy";

describe("membership policy", () => {
  it("defaults come from Teamwork's documented procedures and saved settings override them", () => {
    expect(DEFAULT_MEMBERSHIP_POLICY.holdMaxMonthsPerMembershipYear).toBe(2);
    expect(DEFAULT_MEMBERSHIP_POLICY.punchCardExpiryMonths).toBe(3);
    expect(policyFromSettings({ membershipPolicy: { familyDiscountPercent: 15 } }).familyDiscountPercent).toBe(15);
  });

  it("stub pricing: Teamwork half-month rule, daily, and no stub on the 1st", () => {
    // Worked example from the add-membership playbook: start Jul 20, 3x plan $261.99 → stub $131.00 (half, rounded by staff).
    expect(stubPriceMinor(26199, "2026-07-20", "teamwork_half_month").amountMinor).toBe(13100);
    expect(stubPriceMinor(26199, "2026-07-01", "teamwork_half_month")).toMatchObject({ amountMinor: 26199, rule: expect.stringContaining("no stub") });
    expect(stubPriceMinor(26199, "2026-07-05", "teamwork_half_month").amountMinor).toBe(26199);
    expect(stubPriceMinor(26199, "2026-07-28", "teamwork_half_month").amountMinor).toBe(6550);
    expect(stubPriceMinor(31000, "2026-07-22", "daily").amountMinor).toBe(10000);
  });
});
