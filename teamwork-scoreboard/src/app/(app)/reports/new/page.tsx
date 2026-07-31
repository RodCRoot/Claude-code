import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { weekStartOf, todayStr } from "@/lib/periods";
import { save515 } from "@/app/actions/team";
import {
  PageHeader,
  Card,
  CardBody,
  Field,
  Textarea,
  Select,
  Button,
} from "@/components/ui";

export const metadata = { title: "New 5-15 Report" };

const SECTIONS: { name: string; label: string; hint?: string }[] = [
  { name: "wins", label: "Biggest wins this week" },
  { name: "kpiWins", label: "KPI wins", hint: "Numbers you beat or moved this week" },
  { name: "commitmentsCompleted", label: "Commitments completed" },
  { name: "commitmentsMissed", label: "Commitments missed", hint: "And what got in the way" },
  { name: "challenges", label: "Current challenges" },
  { name: "clientConcerns", label: "Athlete / client concerns", hint: "Anyone we might lose, anyone struggling" },
  { name: "facilityConcerns", label: "Facility or equipment concerns" },
  { name: "helpNeeded", label: "Help needed from leadership" },
  { name: "nextPriorities", label: "Priorities for next week" },
];

export default async function New515Page({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; from?: string }>;
}) {
  const me = await requireUser("submit_scorecard");
  const sp = await searchParams;
  const week =
    sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? weekStartOf(sp.week) : weekStartOf(todayStr());

  const existing = db.get<Record<string, string | number | null>>(sql`
    SELECT rating, wins, kpi_wins AS kpiWins, commitments_completed AS commitmentsCompleted,
           commitments_missed AS commitmentsMissed, challenges,
           client_concerns AS clientConcerns, facility_concerns AS facilityConcerns,
           help_needed AS helpNeeded, next_priorities AS nextPriorities
    FROM reports_515 WHERE user_id = ${me.id} AND week_start = ${week}
  `);

  return (
    <>
      <PageHeader
        kicker={`Week of ${week}`}
        title="5-15 Report"
        subtitle={
          sp.from === "scorecard"
            ? "Scorecard submitted ✓ — finish the loop with your 5-15."
            : "Takes about fifteen minutes. Your manager reads and responds."
        }
      />
      <Card className="max-w-3xl">
        <CardBody className="pt-5">
          <form action={save515} className="space-y-4">
            <input type="hidden" name="weekStart" value={week} />
            <Field label="Overall week rating (1–10)">
              <Select name="rating" defaultValue={String(existing?.rating ?? "7")} className="w-28">
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            {SECTIONS.map((s) => (
              <Field key={s.name} label={s.label} hint={s.hint}>
                <Textarea
                  name={s.name}
                  rows={s.name === "wins" ? 3 : 2}
                  defaultValue={(existing?.[s.name] as string) ?? ""}
                />
              </Field>
            ))}
            <div className="flex items-center gap-3">
              <Button type="submit" size="lg">Submit 5-15</Button>
              <p className="text-xs text-ink-3">Submitting saves the report to your manager&apos;s review queue.</p>
            </div>
          </form>
        </CardBody>
      </Card>
    </>
  );
}
