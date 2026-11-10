import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, Input, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ANYWHERE_CATEGORIES } from "@/db/schema";
import { assignmentBoard } from "@/lib/anywhere/assignments";
import { CATEGORY_LABEL, EQUIPMENT_LABEL, orgAnywhere, SAFETY_COPY } from "@/lib/anywhere/common";
import { completionReviewQueue, listSessionsForStaff } from "@/lib/anywhere/sessions";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { addDaysYmd, fmt, fmtDate, startOfWeekYmd, todayLocal } from "@/lib/time";
import { groupsForViewer } from "@/lib/training/assignments";
import { writableAthletes } from "@/lib/training/common";
import { TrainingNav } from "../_components/training-nav";
import { HeroLink, HeroStat, ModuleHero } from "../_components/tb";
import { anywhereSettingsAction, assignAction, cancelAssignmentAction, reviewCompletionAction } from "./actions";

export const metadata = { title: "On Your Own" };

export default async function AnywhereCoachPage() {
  const viewer = await requireStaff();
  const canManage = can(viewer, "training.manage");
  const { tz, settings } = await orgAnywhere(db, viewer.orgId);
  const today = todayLocal(tz);
  const [sessions, board, queue, groups, athletes] = await Promise.all([
    listSessionsForStaff(db, viewer),
    assignmentBoard(db, viewer, today),
    completionReviewQueue(db, viewer),
    canManage ? groupsForViewer(db, viewer) : Promise.resolve([]),
    canManage ? writableAthletes(db, viewer) : Promise.resolve([]),
  ]);
  const published = sessions.filter((s) => s.status === "published");
  const openAssignments = board.filter((b) => b.endDate >= today);
  const weekStart = startOfWeekYmd(today);

  return (
    <div>
      <ModuleHero
        kicker="Training · On Your Own"
        title="On Your Own sessions"
        description="Short sessions athletes can do away from the gym, built from your exercise library. Assign them for specific days and see who did them."
        actions={canManage ? <HeroLink href="/training/anywhere/new" primary>New session</HeroLink> : undefined}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <HeroStat label="Published sessions" value={published.length} hint={`${sessions.length - published.length} draft or archived`} />
          <HeroStat label="Open assignments" value={openAssignments.length} hint="Ending today or later" />
          <HeroStat label="Finished, to review" value={queue.length} hint="In your scope" />
        </div>
      </ModuleHero>
      <TrainingNav viewer={viewer} current="anywhere" />

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card>
            <CardHeader title="Library" kicker={`Every session shows: "${SAFETY_COPY}"`} />
            <CardBody>
              {sessions.length === 0 ? (
                <EmptyState title="No sessions yet">Create the first one from your exercise library.</EmptyState>
              ) : (
                <Table caption="On Your Own sessions">
                  <thead>
                    <tr>
                      <Th>Session</Th>
                      <Th>Type</Th>
                      <Th align="right">Min</Th>
                      <Th>Equipment</Th>
                      <Th>Under 13</Th>
                      <Th align="right">Steps</Th>
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <Td>
                          <Link href={`/training/anywhere/${s.id}`} className="font-semibold text-brand underline">
                            {s.title}
                          </Link>{" "}
                          {s.isSample ? <Badge variant="yellow">Sample</Badge> : null}
                        </Td>
                        <Td>{CATEGORY_LABEL[s.category]}</Td>
                        <Td align="right">{s.durationMinutes}</Td>
                        <Td>{s.equipment.map((e) => EQUIPMENT_LABEL[e]).join(", ")}</Td>
                        <Td>{s.suitableUnder13 ? "Yes" : "No"}</Td>
                        <Td align="right">{s.stepCount}</Td>
                        <Td>
                          <StatusBadge status={s.status} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Assignments" kicker="Completion by athlete · last two weeks onward" />
            <CardBody>
              {board.length === 0 ? (
                <p className="text-sm text-ink-3">Nothing assigned yet.</p>
              ) : (
                <ul className="divide-y divide-edge">
                  {board.map((b) => {
                    const done = b.athletes.filter((a) => a.complete).length;
                    return (
                      <li key={b.id} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-semibold leading-snug">
                              {b.title} <span className="font-normal text-ink-2">for {b.target}</span>
                            </p>
                            <p className="text-sm text-ink-2 tabular">
                              {b.targetCount} time{b.targetCount === 1 ? "" : "s"} · {fmtDate(b.startDate)} to {fmtDate(b.endDate)} · {done} of {b.athletes.length} athlete{b.athletes.length === 1 ? "" : "s"} done
                            </p>
                            {b.note ? <p className="text-xs text-ink-3">{b.note}</p> : null}
                          </div>
                          {canManage && b.endDate >= today ? (
                            <ActionForm action={cancelAssignmentAction}>
                              <input type="hidden" name="assignmentId" value={b.id} />
                              <SubmitButton variant="ghost" size="sm" confirm="Cancel this assignment? Athletes will no longer see it.">
                                Cancel<span className="sr-only">: {b.title} for {b.target}</span>
                              </SubmitButton>
                            </ActionForm>
                          ) : null}
                        </div>
                        <ul className="mt-2 flex flex-wrap gap-1.5">
                          {b.athletes.map((a) => (
                            <li key={a.athleteId}>
                              <Badge variant={a.complete ? "green" : a.done > 0 ? "yellow" : "neutral"}>
                                {a.name}: {a.complete ? "done" : `${a.done} of ${b.targetCount}`}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card id="review">
            <CardHeader title="Finished sessions to review" kicker="Newest first" />
            <CardBody>
              {queue.length === 0 ? (
                <p className="text-sm text-ink-3">Nothing waiting.</p>
              ) : (
                <Table caption="Finished On Your Own sessions awaiting review">
                  <thead>
                    <tr>
                      <Th>Athlete</Th>
                      <Th>Session</Th>
                      <Th>When</Th>
                      <Th align="right">Steps</Th>
                      <Th align="right">Min</Th>
                      <Th align="right">sRPE</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {queue.map((c) => (
                      <tr key={c.id}>
                        <Td>
                          <Link href={`/training/athletes/${c.athleteId}`} className="font-semibold hover:underline">
                            {c.athleteName}
                          </Link>
                        </Td>
                        <Td>{c.sessionTitle}</Td>
                        <Td>{fmt(c.completedAt, "EEE MMM d, h:mm a", tz)}</Td>
                        <Td align="right">
                          {c.stepsDone}/{c.stepsTotal}
                        </Td>
                        <Td align="right">{c.durationMinutes ?? "—"}</Td>
                        <Td align="right">{c.rpe ?? "—"}</Td>
                        <Td>
                          <ActionForm action={reviewCompletionAction}>
                            <input type="hidden" name="completionId" value={c.id} />
                            <SubmitButton variant="secondary" size="sm" pendingText="...">
                              Mark reviewed<span className="sr-only">: {c.athleteName}, {c.sessionTitle}</span>
                            </SubmitButton>
                          </ActionForm>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <p className="mt-2 text-xs text-ink-3">A dash means the athlete did not give minutes or effort. Only sessions with both count in training load (source: on your own).</p>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-5">
          {canManage ? (
            <Card>
              <CardHeader title="Assign" kicker="For specific days" />
              <CardBody>
                {published.length === 0 ? (
                  <p className="text-sm text-ink-3">Publish a session first.</p>
                ) : (
                  <ActionForm action={assignAction} resetOnSuccess className="space-y-3">
                    <Field label="What" htmlFor="as-what" required>
                      <Select id="as-what" name="what" required defaultValue="">
                        <option value="" disabled>
                          Choose
                        </option>
                        <optgroup label="Any session of a type">
                          {ANYWHERE_CATEGORIES.filter((c) => published.some((s) => s.category === c)).map((c) => (
                            <option key={c} value={`category:${c}`}>
                              Any {CATEGORY_LABEL[c].toLowerCase()} session
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="One session">
                          {published.map((s) => (
                            <option key={s.id} value={`session:${s.id}`}>
                              {s.title} ({s.durationMinutes} min)
                            </option>
                          ))}
                        </optgroup>
                      </Select>
                    </Field>
                    <Field label="Who" htmlFor="as-who" required>
                      <Select id="as-who" name="who" required defaultValue="">
                        <option value="" disabled>
                          Choose
                        </option>
                        <optgroup label="Groups">
                          {groups.map((g) => (
                            <option key={g.id} value={`group:${g.id}`}>
                              {g.name}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="Athletes">
                          {athletes.map(([id, name]) => (
                            <option key={id} value={`athlete:${id}`}>
                              {name}
                            </option>
                          ))}
                        </optgroup>
                      </Select>
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="From" htmlFor="as-from" required>
                        <Input id="as-from" name="startDate" type="date" defaultValue={today} required />
                      </Field>
                      <Field label="To" htmlFor="as-to" required>
                        <Input id="as-to" name="endDate" type="date" defaultValue={addDaysYmd(weekStart, 6)} required />
                      </Field>
                    </div>
                    <Field label="How many times" htmlFor="as-n" required>
                      <Input id="as-n" name="targetCount" type="number" min={1} max={14} defaultValue={1} required />
                    </Field>
                    <Field label="Note to the athlete (optional)" htmlFor="as-note">
                      <Input id="as-note" name="note" maxLength={200} />
                    </Field>
                    <SubmitButton>Assign</SubmitButton>
                    <p className="text-xs text-ink-3">Athletes under 13 are only shown sessions marked suitable for them, even when their group is assigned something else.</p>
                  </ActionForm>
                )}
              </CardBody>
            </Card>
          ) : null}
          {can(viewer, "settings.manage") ? (
            <Card>
              <CardHeader title="Settings" kicker="Owner and admin" />
              <CardBody>
                <ActionForm action={anywhereSettingsAction} className="space-y-3">
                  <label className="flex min-h-11 items-start gap-2 text-sm">
                    <input type="checkbox" name="showInSeasonOption" defaultChecked={settings.showInSeasonOption} className="mt-1" />
                    <span>
                      Mention the In Season membership while a family&apos;s season is active
                      <span className="block text-xs text-ink-3">Off by default. Shows a link that opens a message to the front desk. It never changes a membership.</span>
                    </span>
                  </label>
                  <SubmitButton variant="secondary">Save</SubmitButton>
                </ActionForm>
                <p className="mt-3 text-xs text-ink-3">
                  XP for a finished On Your Own session is set under{" "}
                  <Link href="/settings/engagement" className="font-semibold text-brand underline">
                    Settings, Engagement
                  </Link>
                  .
                </p>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
