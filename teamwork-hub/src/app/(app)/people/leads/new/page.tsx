import Link from "next/link";
import { StableForm, StableSubmit } from "@/app/(app)/messages/_components/stable-form";
import { Card, CardBody, PageHeader } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { InquiryFields } from "@/app/(public)/inquire/_components/inquiry-fields";
import { createLeadAction } from "../actions";

export const metadata = { title: "Add lead" };

export default async function NewLeadPage() {
  await requireCap("crm.manage");
  return (
    <>
      <PageHeader
        kicker="Leads"
        title="Add a lead"
        description="For walk-ins and phone calls. Existing people with the same email or phone are flagged for review — nothing is merged automatically."
      />
      <Card className="max-w-3xl">
        <CardBody className="pt-5">
          <StableForm action={createLeadAction}>
            <InquiryFields staff />
            <div className="mt-6 flex items-center gap-3">
              <StableSubmit>Create lead</StableSubmit>
              <Link href="/people/leads" className="text-sm text-ink-3 underline">
                Cancel
              </Link>
            </div>
          </StableForm>
        </CardBody>
      </Card>
    </>
  );
}
