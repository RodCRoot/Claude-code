import { eq } from "drizzle-orm";
import { organizations } from "@/db/schema";
import type { InquiryInput } from "@/lib/crm/intake";
import { DEFAULT_GROWTH, growthFromSettings, type GrowthSettings } from "@/lib/growth/settings";
import { testDb } from "./helpers/db";

type Patch = { referral?: Partial<GrowthSettings["referral"]>; offers?: Partial<GrowthSettings["offers"]> };

/** Writes growth settings straight into the org row (the settings form is tested separately). */
export async function setGrowth(orgId: string, patch: Patch) {
  const db = testDb();
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  const cur = growthFromSettings(org.settings);
  const growth: GrowthSettings = { referral: { ...cur.referral, ...(patch.referral ?? {}) }, offers: { ...cur.offers, ...(patch.offers ?? {}) } };
  await db.update(organizations).set({ settings: { ...org.settings, growth } }).where(eq(organizations.id, orgId));
  return growth;
}

export const SAMPLE_CREDIT = { type: "account_credit" as const, amountMinor: 2500, credits: null, creditExpiryDays: null };
export const NO_REWARD = DEFAULT_GROWTH.referral.reward;

let n = 0;
/** A unique synthetic inquiry (child athlete + parent contact). */
export function inquiry(x: Partial<InquiryInput> = {}): InquiryInput {
  n += 1;
  return {
    inquiringFor: "child",
    contactFirstName: "Friend",
    contactLastName: `Testfamily${n}`,
    email: `friend${n}.${Date.now()}@example.test`,
    athleteFirstName: "Kid",
    athleteLastName: `Testfamily${n}`,
    athleteAge: 13,
    consentEmail: false,
    consentSms: false,
    preferredTimes: [],
    ...x,
  };
}
