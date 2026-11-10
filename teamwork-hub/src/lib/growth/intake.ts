import type { Tx } from "@/db";
import { createLeadFromInquiry, type InquiryInput, type IntakeMeta } from "@/lib/crm/intake";
import { attributeReferral } from "./referrals";

/**
 * Public inquiry that arrived through a referral link (/r/<code>). The lead is created by the
 * normal intake (same validation, per-IP and org-wide rate limits), then the code is attributed
 * in the same transaction. The caller always answers the same way whether or not the code was
 * real, so the public form cannot be used to test codes.
 */
export async function createReferredInquiry(tx: Tx, orgId: string, input: InquiryInput, code: string | null | undefined, meta: IntakeMeta = {}) {
  const lead = await createLeadFromInquiry(tx, orgId, input, { ...meta, source: "web_inquiry" });
  const referral = await attributeReferral(tx, orgId, lead.leadId, code, { via: "link", isDemo: meta.isDemo });
  return { leadId: lead.leadId, referral };
}
