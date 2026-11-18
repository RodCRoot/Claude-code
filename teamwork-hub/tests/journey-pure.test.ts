import { describe, expect, it } from "vitest";
import { evaluateRule, type RuleFacts, type RuleTarget } from "@/lib/journey/sync";
import {
  AUTO_RULE_KEYS,
  DEFAULT_TEMPLATES,
  VISIT_MILESTONES,
  addMonthsYmd,
  addOffset,
  currentStint,
  isDefaultStep,
  journeySettingsFrom,
  midpointYmd,
  shiftForHolds,
  stepDueOn,
} from "@/lib/journey/templates";
import { percent, weekStartOf } from "@/lib/journey/scorecard";
import { tickDate } from "@/lib/journey/ops";

const step = (key: string, kind: keyof typeof DEFAULT_TEMPLATES) => DEFAULT_TEMPLATES[kind].find((s) => s.key === key)!;

describe("journey due-date arithmetic (facility-local calendar dates)", () => {
  it("adds calendar months and clamps to the end of the month", () => {
    expect(addMonthsYmd("2026-01-15", 6)).toBe("2026-07-15");
    expect(addMonthsYmd("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonthsYmd("2027-08-31", 6)).toBe("2028-02-29"); // leap year
    expect(addMonthsYmd("2026-10-31", 1)).toBe("2026-11-30");
    expect(addMonthsYmd("2026-11-30", 24)).toBe("2028-11-30");
    expect(addMonthsYmd("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("weeks and days are plain day counts, across a daylight-saving change", () => {
    // US clocks go back on 2026-11-01: six weeks is still exactly 42 calendar days.
    expect(addOffset("2026-10-12", 6, "weeks")).toBe("2026-11-23");
    expect(addOffset("2026-03-01", 14, "days")).toBe("2026-03-15"); // clocks go forward on 2026-03-08
    expect(addOffset("2026-10-12", -7, "days")).toBe("2026-10-05");
  });

  it("touchpoints fall at 6 weeks, 6, 12, 18 and 24 months after the start date", () => {
    const start = "2026-01-31";
    expect(stepDueOn(step("touch_6_weeks", "touchpoints"), start)).toBe("2026-03-14");
    expect(stepDueOn(step("touch_6_months", "touchpoints"), start)).toBe("2026-07-31");
    expect(stepDueOn(step("touch_12_months", "touchpoints"), start)).toBe("2027-01-31");
    expect(stepDueOn(step("touch_18_months", "touchpoints"), start)).toBe("2027-07-31");
    expect(stepDueOn(step("touch_24_months", "touchpoints"), start)).toBe("2028-01-31");
  });

  it("hold steps count from the start, the midpoint and the end", () => {
    expect(midpointYmd("2026-10-01", "2026-10-07")).toBe("2026-10-04");
    expect(midpointYmd("2026-10-01", "2026-10-08")).toBe("2026-10-04");
    expect(stepDueOn(step("hold_reason", "hold"), "2026-10-01", "2026-10-31")).toBe("2026-10-01");
    expect(stepDueOn(step("hold_miss_you", "hold"), "2026-10-01", "2026-10-31")).toBe("2026-10-16");
    expect(stepDueOn(step("hold_return_reminder", "hold"), "2026-10-01", "2026-10-31")).toBe("2026-10-24");
  });

  it("a touchpoint inside a hold moves to after the hold; tenure itself is not stretched", () => {
    const holds = [{ startDate: "2026-06-01", endDate: "2026-06-30" }];
    expect(shiftForHolds("2026-05-31", holds, 7)).toBe("2026-05-31"); // day before the hold: unchanged
    expect(shiftForHolds("2026-06-01", holds, 7)).toBe("2026-07-07");
    expect(shiftForHolds("2026-06-30", holds, 7)).toBe("2026-07-07");
    expect(shiftForHolds("2026-07-01", holds, 7)).toBe("2026-07-01"); // after the hold: NOT pushed out by 30 days
    // Back-to-back holds are followed to the end of the last one.
    expect(shiftForHolds("2026-06-15", [...holds, { startDate: "2026-07-05", endDate: "2026-07-20" }], 7)).toBe("2026-07-27");
    // Grace of 0 still lands outside the hold.
    expect(shiftForHolds("2026-06-15", holds, 0)).toBe("2026-07-01");
  });

  it("finds the membership that began the current stint", () => {
    const today = "2026-10-12";
    expect(currentStint([], today)).toBeNull();
    expect(currentStint([{ id: "future", startDate: "2026-11-01", endedOn: null }], today)).toBeNull();
    // A plan change (new membership the day after the old one ended) is the same stint.
    expect(currentStint([{ id: "a", startDate: "2025-01-10", endedOn: "2026-03-01" }, { id: "b", startDate: "2026-03-02", endedOn: null }], today)?.id).toBe("a");
    // Coming back after more than 30 days starts a new stint.
    expect(currentStint([{ id: "a", startDate: "2025-01-10", endedOn: "2026-03-01" }, { id: "b", startDate: "2026-09-20", endedOn: null }], today)?.id).toBe("b");
    // An open-ended earlier membership means there was never a gap.
    expect(currentStint([{ id: "a", startDate: "2025-01-10", endedOn: null }, { id: "b", startDate: "2026-09-20", endedOn: null }], today)?.id).toBe("a");
  });
});

describe("journey templates", () => {
  it("ships every checklist with defaults that are labelled as defaults", () => {
    const s = journeySettingsFrom(null);
    for (const kind of Object.keys(DEFAULT_TEMPLATES) as (keyof typeof DEFAULT_TEMPLATES)[]) {
      expect(s.templates[kind].length).toBeGreaterThan(0);
      for (const st of s.templates[kind]) expect(isDefaultStep(kind, st)).toBe(true);
    }
    expect(s.templates.visit_milestones.map((x) => x.visits)).toEqual([...VISIT_MILESTONES]);
    expect([...VISIT_MILESTONES]).toEqual([10, 25, 50, 100, 250, 500, 750, 1000]);
    expect(s.templates.onboarding.map((x) => x.key)).toEqual(expect.arrayContaining(["welcome_message", "documents_signed", "payment_method", "first_session_booked", "first_session_attended", "coach_assigned", "program_assigned", "day_one_contact", "bring_a_friend", "thank_you_card", "next_day_checkin"]));
    expect(s.templates.onboarding.find((x) => x.key === "payment_method")!.billing).toBe(true);
    expect(s.templates.offboarding.find((x) => x.key === "off_final_bill")!.billing).toBe(true);
  });

  it("reads saved edits, rejects junk, and forces the billing flag for billing rules", () => {
    const s = journeySettingsFrom({
      journey: {
        lookaheadDays: 21,
        backfillDays: 99999,
        targets: { reachOuts: 25 },
        templates: {
          onboarding: [
            { key: "welcome_message", name: "Say hello", ownerRole: "coach", offset: 1, unit: "days", autoRule: "not_a_rule", enabled: true },
            { key: "payment_method", name: "Card on file", ownerRole: "operations", offset: 2, unit: "days", autoRule: "payment_method_on_file", billing: false },
            { key: "BAD KEY", name: "x", offset: 1 },
            { key: "custom_1", name: "", offset: 1 },
          ],
        },
      },
    });
    expect(s.lookaheadDays).toBe(21);
    expect(s.backfillDays).toBe(30); // out of range: default
    expect(s.targets.reachOuts).toBe(25);
    expect(s.targets.meetings).toBe(3);
    expect(s.templates.onboarding.map((x) => x.key)).toEqual(["welcome_message", "payment_method"]);
    expect(s.templates.onboarding[0]).toMatchObject({ name: "Say hello", ownerRole: "coach", autoRule: null, link: "compose" });
    expect(isDefaultStep("onboarding", s.templates.onboarding[0])).toBe(false);
    expect(s.templates.onboarding[1].billing).toBe(true);
    expect(s.templates.hold.length).toBe(DEFAULT_TEMPLATES.hold.length);
  });
});

describe("auto-complete rules (pure)", () => {
  const start = new Date("2026-10-01T04:00:00Z");
  const base = (): RuleFacts => ({ staffMessages: [], pendingForms: 0, completedForms: 0, hasPaymentMethod: false, bookedStarts: [], attendedStarts: [], coachAssigned: false, programAssigned: false, inGroup: false, shoutoutDays: [] });
  const target: RuleTarget = { startedOn: "2026-10-01", startInstant: start };
  const hold = (h: Partial<NonNullable<RuleTarget["hold"]>>): RuleTarget => ({ ...target, hold: { reason: null, endDate: null, reminderRan: false, ...h } });
  const mem = (m: Partial<NonNullable<RuleTarget["membership"]>>): RuleTarget => ({ ...target, membership: { cancelReason: null, lostReasonLogged: false, openInvoices: 0, ...m } });

  it("nothing is ticked on an empty record, except rules that are about absence", () => {
    const yes = AUTO_RULE_KEYS.filter((r) => evaluateRule(r, base(), target));
    expect(yes).toEqual(["removed_from_program_groups"]);
  });

  it("each rule turns true on exactly its own event", () => {
    const after = new Date("2026-10-03T15:00:00Z");
    const before = new Date("2026-08-01T15:00:00Z");
    expect(evaluateRule("staff_message_sent", { ...base(), staffMessages: [before] }, target)).toBe(false);
    expect(evaluateRule("staff_message_sent", { ...base(), staffMessages: [before, after] }, target)).toEqual(after);
    expect(evaluateRule("documents_signed", { ...base(), completedForms: 2, pendingForms: 1 }, target)).toBe(false);
    expect(evaluateRule("documents_signed", { ...base(), completedForms: 0, pendingForms: 0 }, target)).toBe(false);
    expect(evaluateRule("documents_signed", { ...base(), completedForms: 2 }, target)).toBe(true);
    expect(evaluateRule("payment_method_on_file", { ...base(), hasPaymentMethod: true }, target)).toBe(true);
    expect(evaluateRule("first_session_booked", { ...base(), bookedStarts: [before] }, target)).toBe(false);
    expect(evaluateRule("first_session_booked", { ...base(), bookedStarts: [after] }, target)).toBe(true);
    // A trial session a few days before the membership start still counts as the first session.
    expect(evaluateRule("first_session_attended", { ...base(), attendedStarts: [new Date("2026-09-25T21:00:00Z")] }, target)).toEqual(new Date("2026-09-25T21:00:00Z"));
    expect(evaluateRule("first_session_attended", { ...base(), attendedStarts: [before] }, target)).toBe(false);
    expect(evaluateRule("coach_assigned", { ...base(), coachAssigned: true }, target)).toBe(true);
    expect(evaluateRule("program_assigned", { ...base(), programAssigned: true }, target)).toBe(true);
    expect(evaluateRule("shoutout_posted", { ...base(), shoutoutDays: ["2026-10-05"] }, { ...target, reachedOn: "2026-10-06" })).toBe(false);
    expect(evaluateRule("shoutout_posted", { ...base(), shoutoutDays: ["2026-10-06"] }, { ...target, reachedOn: "2026-10-06" })).toBe(true);
    expect(evaluateRule("shoutout_posted", { ...base(), shoutoutDays: ["2026-10-06"] }, target)).toBe(false);
    expect(evaluateRule("hold_reason_recorded", base(), hold({ reason: "  " }))).toBe(false);
    expect(evaluateRule("hold_reason_recorded", base(), hold({ reason: "Travel" }))).toBe(true);
    expect(evaluateRule("hold_return_date_set", base(), hold({ endDate: "2026-11-01" }))).toBe(true);
    expect(evaluateRule("hold_return_reminder", base(), hold({ endDate: "2026-11-01" }))).toBe(false);
    expect(evaluateRule("hold_return_reminder", base(), hold({ reminderRan: true }))).toBe(true);
    expect(evaluateRule("cancel_reason_recorded", base(), mem({}))).toBe(false);
    expect(evaluateRule("cancel_reason_recorded", base(), mem({ cancelReason: "Moving away" }))).toBe(true);
    expect(evaluateRule("cancel_reason_recorded", base(), mem({ lostReasonLogged: true }))).toBe(true);
    expect(evaluateRule("final_bill_settled", base(), mem({ openInvoices: 1 }))).toBe(false);
    expect(evaluateRule("final_bill_settled", base(), mem({}))).toBe(true);
    expect(evaluateRule("final_bill_settled", base(), target)).toBe(false); // no membership in view: never guessed
    expect(evaluateRule("removed_from_program_groups", { ...base(), inGroup: true }, target)).toBe(false);
    expect(evaluateRule("removed_from_program_groups", { ...base(), programAssigned: true }, target)).toBe(false);
  });
});

describe("scorecard and checklist helpers", () => {
  it("percent is null with no denominator (never a made-up zero)", () => {
    expect(percent(0, 0)).toBeNull();
    expect(percent(3, 4)).toBe(75);
  });
  it("weeks start on Monday; weekly checklist items are stored on the Monday", () => {
    expect(weekStartOf("2026-10-18")).toBe("2026-10-12"); // Sunday
    expect(weekStartOf("2026-10-12")).toBe("2026-10-12");
    expect(tickDate("weekly", "2026-10-15")).toBe("2026-10-12");
    expect(tickDate("closing", "2026-10-15")).toBe("2026-10-15");
  });
});
