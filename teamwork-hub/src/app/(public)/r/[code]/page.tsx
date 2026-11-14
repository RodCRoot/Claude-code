import { leadLists } from "@/lib/crm/lead-vocab";
import { StableForm, StableSubmit } from "@/app/(app)/messages/_components/stable-form";
import { InquiryFields } from "@/app/(public)/inquire/_components/inquiry-fields";
import { Callout, Card, CardBody } from "@/components/ui";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { publicOrg } from "@/lib/crm/public";
import { describeNewFamilyDiscount, growthFromSettings } from "@/lib/growth/settings";
import { eq } from "drizzle-orm";
import { submitReferredInquiry } from "./actions";

export const metadata = { title: "A friend invited you", robots: { index: false, follow: false } };

/**
 * Referral landing page. It deliberately does NOT look the code up: every well-formed or
 * malformed code renders exactly the same page, so the URL cannot be used to discover which
 * codes exist. The code is only checked when the (rate-limited) form is submitted, and the
 * answer is the same thanks page either way. Nothing about the referring family is shown.
 */
export default async function ReferralLanding({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  // Carry at most 16 URL-safe characters into the form; anything else is dropped.
  const ref = /^[A-Za-z0-9]{1,16}$/.test(code) ? code.toLowerCase() : "";
  // The offer text depends only on the organization's settings, never on the code, so the page
  // still looks the same for real, revoked and made-up codes.
  const org = await publicOrg(db, null);
  const [row] = org ? await db.select({ settings: organizations.settings, currency: organizations.currency }).from(organizations).where(eq(organizations.id, org.id)) : [];
  const growth = growthFromSettings(row?.settings);
  const discount = growth.referral.enabled ? describeNewFamilyDiscount(growth.referral.newFamilyDiscountMinor, row?.currency ?? "USD") : null;
  return (
    <>
      <h1 className="text-2xl font-bold tracking-tight">A friend thought you would like it here</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-3">
        Tell us a little about the athlete and we&apos;ll reach out to schedule an assessment. Fields marked * are required.
      </p>
      <Callout tone="info" className="mt-4">
        You opened a referral link. If it belongs to a Teamwork family, we will let them know a friend got in touch. We never share your contact details with them.
      </Callout>
      {discount ? (
        <Callout tone="ok" className="mt-3" title="A welcome from us">
          <span data-testid="new-family-offer">
            Families who join through a Teamwork family&apos;s link get <strong>{discount}</strong>. It comes off automatically when your first invoice is created. It is for families who are new to Teamwork, once per family, and cannot be combined with another referral.
          </span>
        </Callout>
      ) : null}
      <Card className="mt-6">
        <CardBody className="pt-5">
          <StableForm action={submitReferredInquiry}>
            <input type="hidden" name="ref" value={ref} />
            {/* Honeypot: hidden from people and assistive tech. */}
            <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label htmlFor="website">Website</label>
              <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
            </div>
            <InquiryFields lists={leadLists()} />
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <StableSubmit pendingText="Sending…" size="lg">
                Send inquiry
              </StableSubmit>
              <p className="text-xs text-ink-3">We only use your details to respond to this inquiry.</p>
            </div>
          </StableForm>
        </CardBody>
      </Card>
    </>
  );
}
