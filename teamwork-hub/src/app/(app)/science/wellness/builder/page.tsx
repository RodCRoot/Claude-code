import { asc, eq } from "drizzle-orm";
import { Callout, Card, CardBody, PageHeader } from "@/components/ui";
import { db } from "@/db";
import { groups } from "@/db/schema";
import { requireCap } from "@/lib/auth/viewer";
import { getQuestionnaire } from "@/lib/science/wellness";
import { saveQuestionnaireAction } from "../../actions";
import { BackLink, sp1, type SP } from "../../_components/shared";
import { QuestionnaireBuilder } from "./builder";

export const metadata = { title: "Questionnaire builder" };

export default async function BuilderPage({ searchParams }: { searchParams: SP }) {
  const v = await requireCap("science.manage");
  const p = await searchParams;
  const existing = sp1(p.id) ? await getQuestionnaire(db, v, sp1(p.id)) : null;
  const gs = await db.select({ id: groups.id, name: groups.name }).from(groups).where(eq(groups.orgId, v.orgId)).orderBy(asc(groups.name));
  return (
    <>
      <BackLink href="/science/wellness">Wellness</BackLink>
      <PageHeader kicker="Wellness" title={existing ? `Edit “${existing.name}” (currently v${existing.version})` : "New questionnaire"} />
      <Callout className="mb-4">
        Changing questions creates a new version. Responses already submitted stay linked to the version they answered, so history is never rewritten. Schedule, targets, and flag thresholds can change without a new version.
      </Callout>
      <Card>
        <CardBody className="pt-5">
          <QuestionnaireBuilder
            action={saveQuestionnaireAction}
            groups={gs}
            init={
              existing
                ? { id: existing.id, name: existing.name, frequency: existing.schedule.frequency, groupIds: existing.schedule.groupIds, active: existing.active, questions: existing.questions, flagRules: existing.schedule.flagRules }
                : { name: "", frequency: "daily", groupIds: [], active: true, questions: [], flagRules: {} }
            }
          />
        </CardBody>
      </Card>
    </>
  );
}
