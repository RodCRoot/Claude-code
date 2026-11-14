import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEvents, people } from "@/db/schema";
import {
  applicableDefs,
  createFieldDef,
  customFieldsForView,
  listFieldDefs,
  setFieldDefArchived,
  updateFieldDef,
  updatePersonCustomFields,
  validateCustomValues,
} from "@/lib/people/custom-fields";
import { getPersonDetail, searchPeople } from "@/lib/people/queries";
import { buildExport } from "@/lib/exports/bundle";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
beforeAll(async () => {
  ctx = await seedOrg("2026-03-02", { modules: [] });
});
afterAll(closeTestDb);

const tx = <T,>(fn: (t: Parameters<Parameters<ReturnType<typeof testDb>["transaction"]>[0]>[0]) => Promise<T>) => testDb().transaction(fn);

describe("custom field definitions", () => {
  it("only settings managers can define fields; keys are validated and unique", async () => {
    const rod = await viewerFor(ctx, "rod");
    const erin = await viewerFor(ctx, "erin");
    await expect(tx((t) => createFieldDef(t, erin, { label: "X", fieldType: "text", appliesTo: "person", visibility: "staff" }))).rejects.toThrow();
    const size = await tx((t) =>
      createFieldDef(t, rod, { label: "Shirt size", fieldType: "select", appliesTo: "athlete", visibility: "family", options: "S\nM\nL", showInList: "on", required: "" }),
    );
    expect(size.key).toBe("shirt_size");
    expect(size.options).toEqual(["S", "M", "L"]);
    expect(size.showInList).toBe(true);
    expect(size.required).toBe(false);
    await expect(tx((t) => createFieldDef(t, rod, { label: "Shirt size", fieldType: "text", appliesTo: "athlete", visibility: "staff" }))).rejects.toThrow(/already exists/);
    await expect(tx((t) => createFieldDef(t, rod, { label: "Bad", key: "1bad", fieldType: "text", appliesTo: "athlete", visibility: "staff" }))).rejects.toThrow(/Key must/);
    await expect(tx((t) => createFieldDef(t, rod, { label: "One option", fieldType: "select", appliesTo: "athlete", visibility: "staff", options: "only" }))).rejects.toThrow(/two options/);
    await tx((t) => createFieldDef(t, rod, { label: "Clearance", key: "clearance", fieldType: "date", appliesTo: "athlete", visibility: "staff", required: "on" }));
    await tx((t) => createFieldDef(t, rod, { label: "Jersey number", fieldType: "number", appliesTo: "athlete", visibility: "staff" }));
    await tx((t) => createFieldDef(t, rod, { label: "Photo OK", fieldType: "boolean", appliesTo: "athlete", visibility: "staff", showInList: "on" }));
    await tx((t) => createFieldDef(t, rod, { label: "Referral source", fieldType: "text", appliesTo: "lead", visibility: "staff" }));
    const audits = await testDb().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "custom_field.create")));
    expect(audits.length).toBe(5);
  });

  it("applies fields by person kind", async () => {
    const defs = await listFieldDefs(testDb(), ctx.orgId);
    const athlete = applicableDefs(defs, { isAthlete: true, isLead: false }).map((d) => d.key);
    expect(athlete).toContain("shirt_size");
    expect(athlete).not.toContain("referral_source");
    expect(applicableDefs(defs, { isAthlete: false, isLead: false })).toEqual([]);
  });

  it("validates each type server-side", async () => {
    const defs = applicableDefs(await listFieldDefs(testDb(), ctx.orgId), { isAthlete: true, isLead: false });
    const bad = validateCustomValues(defs, { cf_shirt_size: "XXL", cf_clearance: "2026-02-30", cf_jersey_number: "12abc", cf_photo_ok: "maybe" });
    expect(Object.keys(bad.errors).sort()).toEqual(["cf_clearance", "cf_jersey_number", "cf_photo_ok", "cf_shirt_size"]);
    const missing = validateCustomValues(defs, {});
    expect(missing.errors.cf_clearance).toMatch(/required/);
    const ok = validateCustomValues(defs, { cf_shirt_size: "M", cf_clearance: "2026-02-28", cf_jersey_number: "7", cf_photo_ok: "false" });
    expect(ok.errors).toEqual({});
    expect(ok.values).toMatchObject({ shirt_size: "M", clearance: "2026-02-28", jersey_number: 7, photo_ok: false });
  });
});

describe("person custom values", () => {
  it("staff save typed values with an audit diff; invalid input changes nothing", async () => {
    const erin = await viewerFor(ctx, "erin");
    const maya = ctx.people.maya_parker;
    await expect(tx((t) => updatePersonCustomFields(t, erin, maya, { cf_shirt_size: "XXL", cf_clearance: "2026-02-28" }))).rejects.toThrow(/highlighted/);
    const res = await tx((t) => updatePersonCustomFields(t, erin, maya, { cf_shirt_size: "M", cf_clearance: "2026-02-28", cf_jersey_number: "12", cf_photo_ok: "true" }));
    expect(res.changed).toBe(4);
    const [p] = await testDb().select().from(people).where(eq(people.id, maya));
    expect(p.customFields).toMatchObject({ shirt_size: "M", clearance: "2026-02-28", jersey_number: 12, photo_ok: true });
    const [a] = await testDb().select().from(auditEvents).where(and(eq(auditEvents.entityId, maya), eq(auditEvents.action, "person.custom_fields.update")));
    expect(a.after).toMatchObject({ shirt_size: "M" });
    // Clearing an optional value removes the key; unchanged save is a no-op.
    await tx((t) => updatePersonCustomFields(t, erin, maya, { cf_shirt_size: "M", cf_clearance: "2026-02-28", cf_jersey_number: "", cf_photo_ok: "true" }));
    const [p2] = await testDb().select().from(people).where(eq(people.id, maya));
    expect("jersey_number" in p2.customFields).toBe(false);
    expect((await tx((t) => updatePersonCustomFields(t, erin, maya, { cf_shirt_size: "M", cf_clearance: "2026-02-28", cf_photo_ok: "true" }))).changed).toBe(0);
  });

  it("coaches and families cannot edit; families only see family-visible fields", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const alex = await viewerFor(ctx, "alex");
    await expect(tx((t) => updatePersonCustomFields(t, marcus, ctx.people.maya_parker, { cf_shirt_size: "S" }))).rejects.toThrow();
    await expect(tx((t) => updatePersonCustomFields(t, alex, ctx.people.maya_parker, { cf_shirt_size: "S" }))).rejects.toThrow();
    const famView = await customFieldsForView(testDb(), alex, ctx.people.maya_parker);
    expect(famView.map((f) => f.def.key)).toEqual(["shirt_size"]);
    expect(famView[0].value).toBe("M");
    const detail = await getPersonDetail(testDb(), alex, ctx.people.maya_parker);
    expect(detail?.person.customFields).toEqual({});
    const staffView = await customFieldsForView(testDb(), await viewerFor(ctx, "erin"), ctx.people.maya_parker);
    expect(staffView.map((f) => f.def.key)).toContain("clearance");
  });

  it("people list filters by a custom value and returns values for columns", async () => {
    const erin = await viewerFor(ctx, "erin");
    const hit = await searchPeople(testDb(), erin, { kind: "all", custom: { key: "photo_ok", value: "true" } });
    expect(hit.rows.map((r) => r.id)).toEqual([ctx.people.maya_parker]);
    expect(hit.rows[0].customFields).toMatchObject({ shirt_size: "M" });
    const none = await searchPeople(testDb(), erin, { kind: "all", custom: { key: "shirt_size", value: "S" } });
    expect(none.total).toBe(0);
  });

  it("editing and archiving a definition is audited and keeps stored values", async () => {
    const rod = await viewerFor(ctx, "rod");
    const [def] = (await listFieldDefs(testDb(), ctx.orgId)).filter((d) => d.key === "clearance");
    await tx((t) => updateFieldDef(t, rod, def.id, { label: "Clearance date", visibility: "staff", required: "", options: "" }));
    await tx((t) => setFieldDefArchived(t, rod, def.id, true));
    expect((await listFieldDefs(testDb(), ctx.orgId)).some((d) => d.key === "clearance")).toBe(false);
    // Archived field is not validated and its value survives other edits.
    const erin = await viewerFor(ctx, "erin");
    await tx((t) => updatePersonCustomFields(t, erin, ctx.people.maya_parker, { cf_shirt_size: "L", cf_photo_ok: "true" }));
    const [p] = await testDb().select().from(people).where(eq(people.id, ctx.people.maya_parker));
    expect(p.customFields).toMatchObject({ shirt_size: "L", clearance: "2026-02-28" });
    const actions = (await testDb().select().from(auditEvents).where(eq(auditEvents.entityId, def.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["custom_field.create", "custom_field.update", "custom_field.archive"]));
  });

  it("org export includes the definitions alongside people.customFields", async () => {
    const rod = await viewerFor(ctx, "rod");
    const out = await tx((t) => buildExport(t, rod, { kind: "org" }));
    expect(out.manifest.files.some((f) => f.path === "data/custom_field_defs.json")).toBe(true);
  });
});
