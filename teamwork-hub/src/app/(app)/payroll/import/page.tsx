import { db } from "@/db";
import { staffMembers } from "@/lib/payroll/service";
import { Callout, Card, CardBody, PageHeader } from "@/components/ui";
import { PayrollTabs, requirePayroll } from "../_shared";
import { ImportForm } from "./import-form";

export const metadata = { title: "Payroll · Import" };
export const dynamic = "force-dynamic";

export default async function PayrollImportPage() {
  const { v, tz } = await requirePayroll();
  const staff = (await staffMembers(db, v.orgId)).map((s) => ({ userId: s.userId, name: s.name }));
  return (
    <>
      <PageHeader
        kicker="Payroll"
        title="Import past entries from Zen Planner"
        description="Paste one staff member's rows from Zen Planner's payroll / time-clock report. Preview first; nothing is saved until you import. Rows already recorded are skipped, so overlapping pay periods can be pasted safely."
      />
      <PayrollTabs current="import" />
      <Callout tone="warn" className="mb-5" title="Unverified column mapping">
        Built from the report&apos;s on-screen layout (<code>Ddd, DD Mon YYYY | Pay rate | $XX.XX / hour | Time In | Time Out | X.XX hours | $XX.XX</code>; rows ending in “Add” have no entry). Check the
        preview against Zen Planner. If columns are in a different order, change them in Payroll → Settings. Times are read in the facility timezone ({tz}). Imported pay rates are shown for
        comparison only — set rates under Staff, rates &amp; PINs.
      </Callout>
      <Card>
        <CardBody className="pt-4">
          <ImportForm staff={staff} tz={tz} />
        </CardBody>
      </Card>
    </>
  );
}
