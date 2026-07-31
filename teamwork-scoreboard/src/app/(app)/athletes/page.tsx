import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { getAtRiskAthletes } from "@/lib/kpi";
import { getSetting } from "@/lib/settings";
import { addAthlete, logOutreach, updateAthleteStatus, setAthleteRisk } from "@/app/actions/crm";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Button,
  Input,
  Select,
  Textarea,
  Field,
} from "@/components/ui";
import { cn } from "@/lib/cn";

export const metadata = { title: "Athletes" };

export default async function AthletesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; athlete?: string }>;
}) {
  const me = await requireUser("view_dashboard");
  const canEdit = me.permissions.includes("edit_records");
  const sp = await searchParams;
  const filter = sp.filter ?? "active";
  const programs = getSetting("programs");
  const atRisk = getAtRiskAthletes();
  const atRiskIds = new Set(atRisk.map((a) => a.id));

  const rows = db.all<{
    id: number;
    name: string;
    guardian_name: string | null;
    program: string | null;
    start_date: string;
    status: string;
    expected: number;
    last_att: string | null;
    last_outreach: string | null;
    risk_override: string | null;
  }>(sql`
    SELECT a.id, a.name, a.guardian_name, a.program, a.start_date, a.status,
      a.expected_sessions_per_week AS expected, a.risk_override,
      (SELECT MAX(att.date) FROM attendance att WHERE att.athlete_id = a.id AND att.status='attended') AS last_att,
      (SELECT MAX(o.at) FROM outreach o WHERE o.athlete_id = a.id) AS last_outreach
    FROM athletes a
    ${filter === "all" ? sql`` : filter === "at_risk" ? sql`WHERE a.status = 'active'` : sql`WHERE a.status = ${filter}`}
    ORDER BY a.name LIMIT 300
  `);
  const list = filter === "at_risk" ? rows.filter((r) => atRiskIds.has(r.id)) : rows;
  const open = sp.athlete ? list.find((a) => a.id === parseInt(sp.athlete!, 10)) : undefined;

  return (
    <>
      <PageHeader
        kicker="Records"
        title="Athletes"
        subtitle="Roster normally syncs from Zen Planner; manual management always available."
        actions={
          <div className="flex gap-2">
            <Badge variant="neutral">{rows.filter((r) => r.status === "active").length} active</Badge>
            <Badge variant={atRisk.length > 0 ? "red" : "green"}>{atRisk.length} at risk</Badge>
          </div>
        }
      />

      <div className="mb-4 flex overflow-hidden rounded-lg border border-edge w-fit">
        {[
          { key: "active", label: "Active" },
          { key: "at_risk", label: `At risk (${atRisk.length})` },
          { key: "hold", label: "On hold" },
          { key: "canceled", label: "Canceled" },
          { key: "all", label: "All" },
        ].map((f) => (
          <Link
            key={f.key}
            href={`/athletes?filter=${f.key}`}
            className={cn(
              "px-3 py-1.5 text-xs font-semibold",
              filter === f.key ? "bg-brand-600 text-white" : "bg-surface-2 text-ink-2 hover:bg-surface-3"
            )}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader kicker={`${list.length} shown`} title="Roster" />
            <CardBody>
              <ul className="divide-y divide-edge/60">
                {list.map((a) => {
                  const risk = atRiskIds.has(a.id);
                  const riskInfo = atRisk.find((r) => r.id === a.id);
                  return (
                    <li key={a.id} className={cn("py-2.5", open?.id === a.id && "rounded-lg bg-surface-3/50 px-2")}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <Link href={`/athletes?filter=${filter}&athlete=${a.id}`} className="font-semibold hover:underline">
                            {a.name}
                          </Link>
                          <span className="ml-2 text-xs text-ink-3">
                            {a.program ?? "no program"} · since {a.start_date}
                            {a.guardian_name ? ` · ${a.guardian_name}` : ""}
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          {risk && <Badge variant="red">{riskInfo?.reason ?? "at risk"}</Badge>}
                          <Badge
                            variant={a.status === "active" ? "green" : a.status === "hold" ? "yellow" : "neutral"}
                          >
                            {a.status}
                          </Badge>
                        </span>
                      </div>
                      {open?.id === a.id && (
                        <div className="mt-3 grid gap-3 border-t border-edge/60 pt-3 sm:grid-cols-2">
                          <div className="text-sm text-ink-2">
                            <p>Last attendance: {a.last_att ?? "never"}</p>
                            <p>Last outreach: {a.last_outreach ? a.last_outreach.slice(0, 10) : "never"}</p>
                            <p>Expected: {a.expected}× / week</p>
                            <p className="mt-1">
                              <Link href={`/onboarding/${a.id}`} className="text-brand-600 hover:underline">
                                Onboarding checklist →
                              </Link>
                            </p>
                          </div>
                          {canEdit && (
                            <div className="space-y-2">
                              <form action={logOutreach} className="flex items-end gap-2">
                                <input type="hidden" name="athleteId" value={a.id} />
                                <Field label="Log outreach">
                                  <Select name="type" className="w-36">
                                    <option value="call">Call</option>
                                    <option value="text">Text</option>
                                    <option value="email">Email</option>
                                    <option value="first_workout_followup">1st-workout follow-up</option>
                                    <option value="recognition">Recognition</option>
                                  </Select>
                                </Field>
                                <Input name="note" placeholder="note" className="flex-1" />
                                <Button size="sm" type="submit">Log</Button>
                              </form>
                              <div className="flex flex-wrap items-end gap-2">
                                <form action={updateAthleteStatus} className="flex items-end gap-2">
                                  <input type="hidden" name="athleteId" value={a.id} />
                                  <Field label="Status">
                                    <Select name="status" defaultValue={a.status} className="w-28">
                                      <option value="active">active</option>
                                      <option value="hold">hold</option>
                                      <option value="canceled">canceled</option>
                                    </Select>
                                  </Field>
                                  <Button size="sm" variant="secondary" type="submit">Set</Button>
                                </form>
                                <form action={setAthleteRisk} className="flex items-end gap-2">
                                  <input type="hidden" name="athleteId" value={a.id} />
                                  <Field label="Risk flag">
                                    <Select name="riskOverride" defaultValue={a.risk_override ?? "auto"} className="w-28">
                                      <option value="auto">auto</option>
                                      <option value="at_risk">at risk</option>
                                      <option value="ok">ok</option>
                                    </Select>
                                  </Field>
                                  <Button size="sm" variant="secondary" type="submit">Set</Button>
                                </form>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
                {list.length === 0 && <li className="py-4 text-sm text-ink-3">No athletes match this filter.</li>}
              </ul>
            </CardBody>
          </Card>
        </div>

        <Card id="add" className="h-fit">
          <CardHeader kicker="Quick action" title="Add athlete" />
          <CardBody>
            {canEdit ? (
              <form action={addAthlete} className="space-y-3">
                <Field label="Athlete name">
                  <Input name="name" required />
                </Field>
                <Field label="Parent or guardian">
                  <Input name="guardianName" />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Birth year" hint="Year only — no full DOB stored">
                    <Input name="birthYear" type="number" min="1950" max="2030" />
                  </Field>
                  <Field label="Start date">
                    <Input name="startDate" type="date" />
                  </Field>
                </div>
                <Field label="Program">
                  <Select name="program">
                    {programs.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Plan name">
                    <Input name="plan" placeholder="e.g. 2x/week membership" />
                  </Field>
                  <Field label="Monthly rate">
                    <Input name="monthlyRate" type="number" step="any" />
                  </Field>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="isTrial" value="1" id="isTrial" className="size-4" />
                  <label htmlFor="isTrial">This is a trial / intro offer</label>
                </div>
                <Field label="Expected sessions per week">
                  <Input name="expectedSessionsPerWeek" type="number" defaultValue="2" min="1" max="7" />
                </Field>
                <Field label="Notes">
                  <Textarea name="notes" rows={2} />
                </Field>
                <Button type="submit" className="w-full">
                  Add athlete & start onboarding
                </Button>
              </form>
            ) : (
              <p className="text-sm text-ink-3">Your role cannot add records.</p>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
