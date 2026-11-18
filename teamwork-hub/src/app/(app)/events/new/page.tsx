import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { ButtonLink, Card, CardBody, PageHeader } from "@/components/ui";
import { formTemplates, resources, users } from "@/db/schema";
import { requireCap } from "@/lib/auth/viewer";
import { EventForm } from "../_form";

export const metadata = { title: "New event" };

export default async function NewEventPage() {
  const v = await requireCap("schedule.manage");
  const [forms, coaches, rooms] = await Promise.all([
    db.select({ id: formTemplates.id, name: formTemplates.name }).from(formTemplates).where(and(eq(formTemplates.orgId, v.orgId), eq(formTemplates.active, true))).orderBy(asc(formTemplates.name)),
    db
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(and(eq(users.orgId, v.orgId), inArray(users.role, ["owner", "admin", "operations", "coach"]), isNull(users.disabledAt)))
      .orderBy(asc(users.displayName)),
    db.select({ id: resources.id, name: resources.name }).from(resources).where(and(eq(resources.orgId, v.orgId), eq(resources.active, true))).orderBy(asc(resources.name)),
  ]);
  return (
    <>
      <PageHeader
        kicker="Camps & clinics"
        title="New camp, clinic or event"
        description="It starts as a draft. Families see it only after you publish it. Prices are yours to set; nothing is filled in for you."
        actions={
          <ButtonLink href="/events" variant="secondary">
            Back to events
          </ButtonLink>
        }
      />
      <Card className="max-w-5xl">
        <CardBody>
          <EventForm forms={forms} coaches={coaches} resources={rooms} />
        </CardBody>
      </Card>
    </>
  );
}
