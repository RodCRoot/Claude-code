import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { organizations } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { actorOf, scienceSettings } from "./access";

export const settingsInput = z.object({
  sorenessReviewThreshold: z.coerce.number().int().min(1).max(10),
  acwrMinCoveragePct: z.coerce.number().int().min(50).max(100),
  acwrAlertHigh: z.coerce.number().min(1).max(3),
  acwrAlertLow: z.coerce.number().min(0.1).max(1),
  readinessFlagBelow: z.coerce.number().int().min(0).max(100),
});

/** Update the `science` namespace of org settings only (thresholds are Teamwork-configurable, not norms). */
export async function updateScienceSettings(tx: Tx, v: Viewer, raw: z.input<typeof settingsInput>) {
  assertCan(v, "science.manage");
  const input = settingsInput.parse(raw);
  if (input.acwrAlertLow >= input.acwrAlertHigh) throw new UserError("Low ACWR alert must be below the high alert.");
  const before = await scienceSettings(tx, v.orgId);
  const after = { sorenessReviewThreshold: input.sorenessReviewThreshold, acwrMinCoverage: input.acwrMinCoveragePct / 100, acwrAlertHigh: input.acwrAlertHigh, acwrAlertLow: input.acwrAlertLow, readinessFlagBelow: input.readinessFlagBelow };
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  await tx.update(organizations).set({ settings: { ...(o?.settings ?? {}), science: after } }).where(eq(organizations.id, v.orgId));
  await audit(tx, actorOf(v), "science.settings.update", "organization", v.orgId, { before, after });
}
