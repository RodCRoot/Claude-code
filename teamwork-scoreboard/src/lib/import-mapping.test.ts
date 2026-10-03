import { describe, it, expect } from "vitest";
import { autoMapHeaders, missingRequired, normalizeKey } from "./import-mapping";
import { IMPORT_TARGETS } from "./importer";

describe("normalizeKey", () => {
  it("folds spacing, case and punctuation", () => {
    expect(normalizeKey("First Name")).toBe("first_name");
    expect(normalizeKey("FIRST_NAME")).toBe("first_name");
    expect(normalizeKey("  Effective Date  ")).toBe("effective_date");
  });

  it("splits camelCase, which is how Zen Planner names report columns", () => {
    expect(normalizeKey("dueDate")).toBe("due_date");
    expect(normalizeKey("billAmount")).toBe("bill_amount");
    expect(normalizeKey("unpaidBalance")).toBe("unpaid_balance");
  });
});

describe("autoMapHeaders", () => {
  it('maps Zen Planner\'s "Name" column onto athlete_name', () => {
    // The bug this exists for: attendance rows were all rejected for a missing
    // name because the grid heads the column "Name", not "Athlete Name".
    const mapping = autoMapHeaders(IMPORT_TARGETS.attendance.fields, [
      "Name",
      "Date",
      "Status",
    ]);
    expect(mapping).toEqual({
      Name: "athlete_name",
      Date: "date",
      Status: "status",
    });
    expect(missingRequired(IMPORT_TARGETS.attendance.fields, mapping)).toEqual([]);
  });

  it("maps a Zen Planner bill grid onto payment fields", () => {
    const mapping = autoMapHeaders(IMPORT_TARGETS.payments.fields, [
      "firstName",
      "lastName",
      "description",
      "dueDate",
      "billAmount",
      "status",
    ]);
    expect(mapping.firstName).toBe("first_name");
    expect(mapping.lastName).toBe("last_name");
    expect(mapping.dueDate).toBe("date");
    expect(mapping.billAmount).toBe("amount");
    expect(mapping.description).toBe("note");
    expect(missingRequired(IMPORT_TARGETS.payments.fields, mapping)).toEqual([]);
  });

  it("maps a cancelled-memberships grid, reasons included", () => {
    const mapping = autoMapHeaders(IMPORT_TARGETS.cancellations.fields, [
      "Name",
      "Effective Date",
      "Reason",
      "Sub Reason",
      "Cancelled By",
    ]);
    expect(mapping["Name"]).toBe("athlete_name");
    expect(mapping["Effective Date"]).toBe("effective_date");
    expect(mapping["Reason"]).toBe("drop_reason");
    expect(mapping["Sub Reason"]).toBe("sub_drop_reason");
    expect(mapping["Cancelled By"]).toBe("cancelled_by");
    expect(missingRequired(IMPORT_TARGETS.cancellations.fields, mapping)).toEqual([]);
  });

  it("lets the more specific column win, whatever the order", () => {
    const forward = autoMapHeaders(IMPORT_TARGETS.attendance.fields, [
      "Name",
      "Athlete Name",
      "Date",
    ]);
    const reversed = autoMapHeaders(IMPORT_TARGETS.attendance.fields, [
      "Athlete Name",
      "Name",
      "Date",
    ]);
    // "Athlete Name" is the exact field name, so it takes athlete_name either
    // way — column order must not decide which one wins.
    expect(forward["Athlete Name"]).toBe("athlete_name");
    expect(reversed["Athlete Name"]).toBe("athlete_name");
    expect(forward["Name"]).toBeUndefined();
    expect(reversed["Name"]).toBeUndefined();
  });

  it("never maps two columns to the same field", () => {
    const mapping = autoMapHeaders(IMPORT_TARGETS.payments.fields, [
      "Amount",
      "Payment Amount",
      "Total",
      "Date",
    ]);
    const used = Object.values(mapping);
    expect(new Set(used).size).toBe(used.length);
  });

  it("leaves unknown columns alone rather than guessing", () => {
    const mapping = autoMapHeaders(IMPORT_TARGETS.attendance.fields, [
      "Name",
      "Date",
      "Enrollment #",
      "Internal GUID",
    ]);
    expect(mapping["Enrollment #"]).toBeUndefined();
    expect(mapping["Internal GUID"]).toBeUndefined();
  });

  it("reports what is missing when a required column is absent", () => {
    const mapping = autoMapHeaders(IMPORT_TARGETS.attendance.fields, ["Name", "Status"]);
    expect(missingRequired(IMPORT_TARGETS.attendance.fields, mapping).map((f) => f.key)).toEqual([
      "date",
    ]);
  });

  it("does not match a one- or two-letter column to a long label", () => {
    // "St" should not become "Status" / "Start date" on a prefix match.
    const mapping = autoMapHeaders(IMPORT_TARGETS.athletes.fields, ["St"]);
    expect(mapping["St"]).toBeUndefined();
  });
});
