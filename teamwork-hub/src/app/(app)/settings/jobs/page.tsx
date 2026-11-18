import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SettingsTabs } from "@/components/settings-tabs";
import { Badge, Callout, Card, CardBody, CardHeader, PageHeader, Table, Td, Th } from "@/components/ui";
import { getOrg, requireCap } from "@/lib/auth/viewer";
import { scheduledJobStatus } from "@/lib/scheduled/jobs";
import { DEFAULT_TZ, fmt } from "@/lib/time";
import { runScheduledJobAction } from "./actions";

export const metadata = { title: "Scheduled jobs" };

const OUTCOME = { ok: ["green", "Completed"], partial: ["yellow", "Completed with problems"], failed: ["red", "Failed"] } as const;

export default async function ScheduledJobsPage() {
  const v = await requireCap("settings.manage");
  const org = (await getOrg(v.orgId))!;
  const tz = org.timezone || DEFAULT_TZ;
  const rows = await scheduledJobStatus(db, v);
  const neverRan = rows.every((r) => !r.last);
  return (
    <>
      <PageHeader
        kicker="Settings"
        title="Scheduled jobs"
        description="Work the Hub does on its own each night so results do not wait for someone to open a page. These jobs never send email or text messages."
      />
      <SettingsTabs current="jobs" />
      {neverRan ? (
        <Callout tone="info" title="No scheduled job has run yet" className="mb-4">
          Jobs are started by the background worker (see docs/DEPLOY.md). Until a worker is running, each page still brings its own data up to date when it is opened, and you can use Run now below.
        </Callout>
      ) : null}
      <Card>
        <CardHeader title="Last run of each job" kicker={`Times shown in facility time (${tz})`} />
        <CardBody>
          <Table caption="Scheduled jobs, when each last ran and its result">
            <thead>
              <tr>
                <Th>Job</Th>
                <Th>Schedule</Th>
                <Th>Last run</Th>
                <Th>Result</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.type}>
                  <Td>
                    <span className="font-semibold">{r.label}</span>
                    <span className="block max-w-md text-xs text-ink-3">{r.does}</span>
                  </Td>
                  <Td>{r.schedule}</Td>
                  <Td>
                    {r.last ? fmt(r.last.at, "EEE MMM d, h:mm a", tz) : <span className="text-ink-3">Never</span>}
                    {r.waiting ? (
                      <span className="block text-xs text-ink-3">
                        {r.waiting.status === "running" ? "Running now" : r.waiting.attempts > 0 ? `Retrying (attempt ${r.waiting.attempts + 1}) at ${fmt(r.waiting.runAt, "h:mm a", tz)}` : "Waiting for the worker"}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {r.last ? (
                      <>
                        <Badge variant={OUTCOME[r.last.outcome][0]}>{OUTCOME[r.last.outcome][1]}</Badge>
                        <span className="mt-1 block max-w-md text-xs text-ink-2">{r.last.summary}</span>
                      </>
                    ) : (
                      <span className="text-ink-3">No result yet</span>
                    )}
                    {r.waiting?.lastError ? <span className="mt-1 block max-w-md text-xs text-bad">Last attempt: {r.waiting.lastError.slice(0, 200)}</span> : null}
                  </Td>
                  <Td>
                    <ActionForm action={runScheduledJobAction}>
                      <input type="hidden" name="type" value={r.type} />
                      <SubmitButton variant="secondary" size="sm" pendingText="Running...">
                        Run now<span className="sr-only">: {r.label}</span>
                      </SubmitButton>
                    </ActionForm>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-3 text-xs text-ink-3">
            Running a job twice is safe: each one only adds what is missing. One athlete or referral with a problem is reported here and does not stop the others. Retention pages are worked out live and have no job.
          </p>
        </CardBody>
      </Card>
    </>
  );
}
