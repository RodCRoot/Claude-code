import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { journeyCompletionReport } from "@/lib/journey/reports";
import { fmtDate } from "@/lib/time";
import { Card, CardHeader, PageHeader, Table, Td, Th } from "@/components/ui";
import { FollowUpTabs } from "@/components/journey/tabs";

export const metadata = { title: "Journey report" };

const monthLabel = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1, 12)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const pct = (n: number | null) => (n === null ? "—" : `${n}%`);

export default async function JourneyReportPage() {
  const v = await requireCap("journey.report");
  const r = await journeyCompletionReport(db, v, { months: 6 });
  return (
    <>
      <PageHeader
        kicker="Business"
        title="Journey report"
        description={`Completion by month, last six months to ${fmtDate(r.today)}. Counts cover steps the journey generated; anything older than the backfill window when the journey was switched on is not in these numbers.`}
      />
      <FollowUpTabs current="report" showReport />
      <div className="space-y-4">
        <Card>
          <CardHeader title="Onboarding" kicker="By the month the membership or trial started" />
          <Table caption="Onboarding completion rate and time by month">
            <thead>
              <tr>
                <Th>Month</Th>
                <Th align="right">Started</Th>
                <Th align="right">Completed</Th>
                <Th align="right">In progress</Th>
                <Th align="right">Completion rate</Th>
                <Th align="right">Average days to complete</Th>
              </tr>
            </thead>
            <tbody>
              {r.onboarding.map((m) => (
                <tr key={m.month}>
                  <Td>{monthLabel(m.month)}</Td>
                  <Td align="right">{m.started}</Td>
                  <Td align="right">{m.completed}</Td>
                  <Td align="right">{m.inProgress}</Td>
                  <Td align="right">{pct(m.completionRatePercent)}</Td>
                  <Td align="right">{m.avgDaysToComplete ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Touchpoints" kicker="By the month the check-in was due" />
          <Table caption="Touchpoints on time and late by month">
            <thead>
              <tr>
                <Th>Month</Th>
                <Th align="right">Due</Th>
                <Th align="right">On time</Th>
                <Th align="right">Done late</Th>
                <Th align="right">Still overdue</Th>
                <Th align="right">Skipped</Th>
                <Th align="right">On time</Th>
              </tr>
            </thead>
            <tbody>
              {r.touchpoints.map((m) => (
                <tr key={m.month}>
                  <Td>{monthLabel(m.month)}</Td>
                  <Td align="right">{m.due}</Td>
                  <Td align="right">{m.onTime}</Td>
                  <Td align="right">{m.late}</Td>
                  <Td align="right">{m.overdue}</Td>
                  <Td align="right">{m.skipped}</Td>
                  <Td align="right">{pct(m.onTimePercent)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Visit milestones" kicker="By the month the recognition was due" />
          <Table caption="Milestones recognised and missed by month">
            <thead>
              <tr>
                <Th>Month</Th>
                <Th align="right">Reached</Th>
                <Th align="right">Recognised</Th>
                <Th align="right">Missed</Th>
                <Th align="right">Waiting</Th>
                <Th align="right">Recognised</Th>
              </tr>
            </thead>
            <tbody>
              {r.milestones.map((m) => (
                <tr key={m.month}>
                  <Td>{monthLabel(m.month)}</Td>
                  <Td align="right">{m.reached}</Td>
                  <Td align="right">{m.recognised}</Td>
                  <Td align="right">{m.missed}</Td>
                  <Td align="right">{m.waiting}</Td>
                  <Td align="right">{pct(m.recognisedPercent)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
