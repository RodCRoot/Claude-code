import { StableForm, StableSubmit } from "@/app/(app)/messages/_components/stable-form";
import { Card, CardBody } from "@/components/ui";
import { db } from "@/db";
import { leadLists, utmFrom } from "@/lib/crm/lead-vocab";
import { publicOrg } from "@/lib/crm/public";
import { vocabOverridesFromSettings } from "@/lib/zenplanner/vocab";
import { submitInquiry } from "./actions";
import { InquiryFields } from "./_components/inquiry-fields";

export const metadata = { title: "Book an assessment" };

export default async function InquirePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const org = typeof sp.org === "string" ? sp.org : undefined;
  const o = await publicOrg(db, org ?? null);
  const lists = leadLists(vocabOverridesFromSettings(o?.settings));
  // Tracking values in the page address travel with the form (hidden fields) and are kept on the lead.
  const utm = utmFrom(Object.fromEntries(Object.entries(sp).filter(([, x]) => typeof x === "string")));
  return (
    <>
      <h1 className="text-2xl font-bold tracking-tight">Request an athlete assessment</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-3">
        Tell us a little about the athlete and we&apos;ll reach out to schedule an assessment. Fields marked * are required.
      </p>
      <Card className="mt-6">
        <CardBody className="pt-5">
          <StableForm action={submitInquiry}>
            {org ? <input type="hidden" name="org" value={org} /> : null}
            {/* Honeypot — hidden from people and assistive tech. */}
            <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label htmlFor="website">Website</label>
              <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
            </div>
            <InquiryFields lists={lists} utm={utm} />
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
