import { describe, expect, it } from "vitest";
import { CARD_UPDATE_SNIPPET, hasEmDash, lintFamilyMessage, replaceEmDashes } from "@/lib/messaging/family-style";

const codes = (t: string) => lintFamilyMessage(t).issues.map((i) => i.code);

describe("lintFamilyMessage", () => {
  it("blocks em dashes and offers comma/period replacement", () => {
    const t = "Hi Jamie, Riley's class moved to 6pm — see you there. Thanks, Coach Sam";
    const r = lintFamilyMessage(t);
    expect(r.ok).toBe(false);
    expect(r.blocks.map((b) => b.code)).toEqual(["em_dash"]);
    expect(replaceEmDashes(t)).toBe("Hi Jamie, Riley's class moved to 6pm, see you there. Thanks, Coach Sam");
    expect(replaceEmDashes(t, "period")).toBe("Hi Jamie, Riley's class moved to 6pm. See you there. Thanks, Coach Sam");
    expect(lintFamilyMessage(replaceEmDashes(t)).ok).toBe(true);
  });

  it("handles dashes after punctuation, at the end, at line starts, and the typed -- form", () => {
    expect(replaceEmDashes("All set. — Coach Sam")).toBe("All set. Coach Sam");
    expect(replaceEmDashes("See you Tuesday —")).toBe("See you Tuesday.");
    expect(replaceEmDashes("Thanks!\n— Teamwork")).toBe("Thanks!\nTeamwork");
    expect(replaceEmDashes("Bring water -- and shoes.")).toBe("Bring water, and shoes.");
    expect(hasEmDash("ages 8–12")).toBe(false); // en dash in a range is fine
    expect(codes("Ages 8–12 welcome. Thanks, Coach Sam")).toEqual([]);
  });

  it("flags staff jargon as a warning only", () => {
    const r = lintFamilyMessage("We comped the session and fixed the entitlement in ZP. Thanks, Coach Sam");
    expect(r.ok).toBe(true);
    expect(r.warnings.filter((w) => w.code === "jargon").map((w) => w.excerpt)).toEqual(expect.arrayContaining(["comped", "entitlement", "ZP"]));
  });

  it("blocks card numbers (Luhn), SSNs and security codes; warns on bank numbers", () => {
    // 4111 1111 1111 1111 is the standard Luhn-valid test number.
    expect(lintFamilyMessage("Card 4111 1111 1111 1111 on file. Thanks, Coach Sam").blocks.map((b) => b.code)).toEqual(["card_number"]);
    expect(lintFamilyMessage("Card 4111-1111-1111-1111. Thanks").issues[0].excerpt).toMatch(/1111$/);
    expect(codes("Order 1234 5678 9012 3456 shipped. Thanks")).not.toContain("card_number"); // not Luhn-valid
    expect(codes("Card ending in 1111. Thanks")).toEqual([]);
    expect(lintFamilyMessage("SSN 123-45-6789. Thanks").blocks.map((b) => b.code)).toContain("ssn");
    expect(lintFamilyMessage("The CVV is 123. Thanks").blocks.map((b) => b.code)).toContain("card_security_code");
    const bank = lintFamilyMessage("Routing number 021000021. Thanks");
    expect(bank.ok).toBe(true);
    expect(bank.warnings.map((w) => w.code)).toContain("bank_number");
  });

  it("warns when there is no sign-off", () => {
    expect(codes("Class is cancelled tonight.")).toEqual(["sign_off"]);
    expect(codes("Class is cancelled tonight.\nThanks, Coach Sam")).toEqual([]);
    expect(codes("Class is cancelled tonight. {{org_name}}")).toEqual([]);
    expect(lintFamilyMessage("Class is cancelled tonight.", { requireSignOff: false }).issues).toEqual([]);
  });

  it("the SAMPLE card-update snippet passes and is app-first", () => {
    const r = lintFamilyMessage(CARD_UPDATE_SNIPPET);
    expect(r.issues).toEqual([]);
    expect(CARD_UPDATE_SNIPPET).toMatch(/^SAMPLE TEXT/);
    expect(CARD_UPDATE_SNIPPET.indexOf("app")).toBeLessThan(CARD_UPDATE_SNIPPET.indexOf("secure link"));
    expect(CARD_UPDATE_SNIPPET).toMatch(/never text or email card numbers/);
  });
});
