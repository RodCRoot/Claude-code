import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { WinsStaffTabs } from "@/components/wins/staff";
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, Input, Select, Textarea } from "@/components/ui";
import { athletes, people, TEAM_EVENT_KINDS, TEAM_KINDS } from "@/db/schema";
import { requireCap } from "@/lib/auth/viewer";
import { accessibleAthleteIds, athleteScopeFilter } from "@/lib/authz/policy";
import { fmt } from "@/lib/time";
import { listTeams } from "@/lib/wins/calendar";
import { COMPETITION_KIND_LABEL, TEAM_KIND_LABEL } from "@/lib/wins/shared";
import { ModuleHero } from "../../training/_components/tb";
import { addTeamEventsAction, archiveTeamAction, createTeamAction, removeTeamEventAction, setTeamAthletesAction } from "../actions";

export const metadata = { title: "Team schedules" };

const day = (ymd: string) => fmt(new Date(`${ymd}T12:00:00Z`), "EEE MMM d, yyyy", "UTC");

export default async function TeamSchedulesPage() {
  const v = await requireCap("wins.review");
  const teams = await listTeams(db, v);
  const scope = await accessibleAthleteIds(db, v, "profile.read");
  const roster = await db
    .select({ id: athletes.id, first: people.firstName, preferred: people.preferredName, last: people.lastName, sport: athletes.sport })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.orgId, v.orgId), eq(athletes.active, true), athleteScopeFilter(scope, athletes.id)))
    .orderBy(asc(people.firstName), asc(people.lastName));
  return (
    <div className="mx-auto max-w-6xl">
      <ModuleHero kicker="Wins" title="Team schedules" description="Enter a school or club season once and attach it to every athlete on that team. It feeds the competition calendar and the Today widget. Families can still add their own season under My Season." />
      <WinsStaffTabs v={v} current="teams" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {teams.length === 0 ? <EmptyState title="No team schedules yet">Add a team on this page, then paste its dates.</EmptyState> : null}
          {teams.map((t) => (
            <Card key={t.id} id={`team-${t.id}`}>
              <CardHeader title={t.name} kicker={`${TEAM_KIND_LABEL[t.kind]} · ${t.sport}${t.seasonLabel ? ` · ${t.seasonLabel}` : ""}`} action={<Badge variant="neutral">{t.events.length} dates</Badge>} />
              <CardBody className="space-y-4">
                <details open={t.events.length <= 6}>
                  <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">
                    Dates<span className="sr-only"> for {t.name}</span>
                  </summary>
                  {t.events.length === 0 ? <p className="text-sm text-ink-3">No dates yet.</p> : null}
                  <ul className="divide-y divide-edge text-sm">
                    {t.events.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                        <span>
                          <span className="font-semibold tabular">{day(e.eventDate)}</span>
                          {e.startTimeLocal ? <span className="tabular">, {e.startTimeLocal}</span> : null}{" "}
                          <span className="text-ink-2">
                            {COMPETITION_KIND_LABEL[e.kind]}
                            {e.opponent ? ` vs ${e.opponent}` : ""}
                            {e.location ? ` · ${e.location}` : ""}
                          </span>
                        </span>
                        <ActionForm action={removeTeamEventAction}>
                          <input type="hidden" name="eventId" value={e.id} />
                          <SubmitButton variant="ghost" size="sm" pendingText="Removing…">
                            Remove<span className="sr-only"> {day(e.eventDate)} from {t.name}</span>
                          </SubmitButton>
                        </ActionForm>
                      </li>
                    ))}
                  </ul>
                </details>

                <details>
                  <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">
                    Add dates<span className="sr-only"> to {t.name}</span>
                  </summary>
                  <ActionForm action={addTeamEventsAction} resetOnSuccess className="space-y-3">
                    <input type="hidden" name="teamId" value={t.id} />
                    <Field label="Kind" htmlFor={`kind-${t.id}`}>
                      <Select id={`kind-${t.id}`} name="kind" defaultValue="game">
                        {TEAM_EVENT_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {COMPETITION_KIND_LABEL[k]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Dates, one per line" htmlFor={`lines-${t.id}`} required hint="Date first, then optionally a 24-hour time, the opponent and the place, separated by commas. Example: 2026-11-20, 19:00, Sample Valley, Away">
                      <Textarea id={`lines-${t.id}`} name="lines" rows={5} required className="font-mono" />
                    </Field>
                    <SubmitButton>Add dates</SubmitButton>
                  </ActionForm>
                </details>

                <details>
                  <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">
                    Athletes on this team ({t.athleteIds.length}
                    {t.otherAthletes ? ` on your roster, ${t.otherAthletes} more outside it` : ""})
                  </summary>
                  <ActionForm action={setTeamAthletesAction} className="space-y-3">
                    <input type="hidden" name="teamId" value={t.id} />
                    <fieldset>
                      <legend className="sr-only">Athletes on {t.name}</legend>
                      <div className="grid gap-x-4 sm:grid-cols-2">
                        {roster.map((a) => (
                          <label key={a.id} className="flex min-h-11 items-center gap-3 text-sm">
                            <input type="checkbox" name="athleteIds" value={a.id} defaultChecked={t.athleteIds.includes(a.id)} className="size-5 shrink-0 accent-brand" />
                            <span>
                              {a.preferred ?? a.first} {a.last}
                              {a.sport ? <span className="text-ink-3"> · {a.sport}</span> : null}
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <SubmitButton>
                      Save athletes<span className="sr-only"> for {t.name}</span>
                    </SubmitButton>
                  </ActionForm>
                </details>

                <ActionForm action={archiveTeamAction}>
                  <input type="hidden" name="teamId" value={t.id} />
                  <SubmitButton variant="ghost" size="sm" confirm={`Archive ${t.name}? Its dates leave the calendar.`}>
                    Archive team<span className="sr-only">: {t.name}</span>
                  </SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          ))}
        </div>
        <div>
          <Card id="add-team">
            <CardHeader title="Add a team" kicker="School or club" />
            <CardBody>
              <ActionForm action={createTeamAction} resetOnSuccess className="space-y-3">
                <Field label="Team name" htmlFor="team-name" required>
                  <Input id="team-name" name="name" required maxLength={80} autoComplete="off" />
                </Field>
                <Field label="Sport" htmlFor="team-sport" required>
                  <Input id="team-sport" name="sport" required maxLength={40} autoComplete="off" />
                </Field>
                <Field label="Kind" htmlFor="team-kind">
                  <Select id="team-kind" name="kind" defaultValue="school">
                    {TEAM_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {TEAM_KIND_LABEL[k]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Season (optional)" htmlFor="team-season" hint="For example Fall 2026.">
                  <Input id="team-season" name="seasonLabel" maxLength={40} autoComplete="off" />
                </Field>
                <SubmitButton>Add team</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
