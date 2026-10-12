import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { groups, people } from "@/db/schema";
import { requireCap } from "@/lib/auth/viewer";
import { Card, CardBody, PageHeader } from "@/components/ui";
import { FamilyForm } from "./family-form";

export const metadata = { title: "Register athlete" };

export default async function NewAthletePage() {
  const v = await requireCap("people.manage");
  const guardianRows = await db
    .select({ id: people.id, firstName: people.firstName, lastName: people.lastName, email: people.email })
    .from(people)
    .where(and(eq(people.orgId, v.orgId), sql`not exists (select 1 from athletes a where a.person_id = ${people.id})`))
    .orderBy(asc(people.lastName), asc(people.firstName))
    .limit(500);
  const groupRows = await db.select({ id: groups.id, name: groups.name }).from(groups).where(eq(groups.orgId, v.orgId)).orderBy(asc(groups.name));
  return (
    <>
      <PageHeader kicker="People" title="Register an athlete" description="Creates the athlete, links or creates a guardian, and sets up a household and payer account. Possible duplicates are flagged for your review — nothing is merged automatically." />
      <Card className="max-w-3xl">
        <CardBody className="pt-5">
          <FamilyForm guardians={guardianRows.map((g) => ({ id: g.id, name: `${g.firstName} ${g.lastName}`, email: g.email }))} groups={groupRows} />
        </CardBody>
      </Card>
    </>
  );
}
