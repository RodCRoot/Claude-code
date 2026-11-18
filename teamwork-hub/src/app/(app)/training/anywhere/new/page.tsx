import { ActionForm, SubmitButton } from "@/components/forms";
import { ButtonLink, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { TrainingNav } from "../../_components/training-nav";
import { createSessionAction } from "../actions";
import { SessionFields } from "../_fields";

export const metadata = { title: "New On Your Own session" };

export default async function NewAnywhereSession() {
  const viewer = await requireCap("training.manage");
  return (
    <div>
      <PageHeader kicker="On Your Own" title="New session" description="Start with the basics. You add the steps from the exercise library on the next screen." actions={<ButtonLink href="/training/anywhere" variant="secondary">Back to the library</ButtonLink>} />
      <TrainingNav viewer={viewer} current="anywhere" />
      <Card className="max-w-2xl">
        <CardHeader title="Session details" kicker="Saved as a draft" />
        <CardBody>
          <ActionForm action={createSessionAction} className="space-y-4">
            <SessionFields />
            <SubmitButton>Create and add steps</SubmitButton>
          </ActionForm>
        </CardBody>
      </Card>
    </div>
  );
}
