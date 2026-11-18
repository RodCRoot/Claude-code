import { eq, sql } from "drizzle-orm";
import { customFieldDefs, people } from "../../src/db/schema";
import type { SeedCtx } from "./context";

/**
 * SAMPLE custom fields (synthetic; an org defines its own in Settings → Custom fields):
 * one family-visible choice list shown in the People list, one staff-only date, one staff-only yes/no.
 */
export async function seedCustomFields(ctx: SeedCtx) {
  const { tx, orgId } = ctx;
  await tx.insert(customFieldDefs).values([
    { orgId, key: "shirt_size", label: "T-shirt size (sample)", fieldType: "select", options: ["YS", "YM", "YL", "AS", "AM", "AL"], appliesTo: "athlete", visibility: "family", showInList: true, sortOrder: 10 },
    { orgId, key: "clearance_date", label: "Medical clearance date (sample)", fieldType: "date", appliesTo: "athlete", visibility: "staff", sortOrder: 20 },
    { orgId, key: "photo_ok", label: "Photo release on file (sample)", fieldType: "boolean", appliesTo: "athlete", visibility: "staff", showInList: true, sortOrder: 30 },
  ]);
  const set = async (personKey: string, values: Record<string, unknown>) => {
    const id = ctx.people[personKey];
    if (!id) return;
    await tx.update(people).set({ customFields: sql`${people.customFields} || ${JSON.stringify(values)}::jsonb` }).where(eq(people.id, id));
  };
  await set("maya_parker", { shirt_size: "AS", photo_ok: true, clearance_date: ctx.today });
  await set("eli_parker", { shirt_size: "YM", photo_ok: false });
  await set("ava_parker", { shirt_size: "YL" });
}
