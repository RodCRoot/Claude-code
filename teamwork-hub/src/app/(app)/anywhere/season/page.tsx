import { randomUUID } from "node:crypto";
import Link from "next/link";
import { db } from "@/db";
import { SportLogForm } from "@/components/anywhere/sport-log-form";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, Select } from "@/components/ui";
import { SEASON_EVENT_KINDS } from "@/db/schema";
import { anywhereAccess, EVENT_KIND_LABEL, orgAnywhere, WEEKDAY_SHORT } from "@/lib/anywhere/common";
import { stagedImport } from "@/lib/anywhere/ics";
import { calendarForAthlete, seasonsForAthlete, type CalendarItem, type SeasonEvent } from "@/lib/anywhere/season";
import { getOrg } from "@/lib/auth/viewer";
import { addDaysYmd, fmtDate, fmtTime, localToUtc, fmt, todayLocal } from "@/lib/time";
import { ModuleHero } from "../../training/_components/tb";
import { addEventAction, createSeasonAction, deleteSeasonAction, importIcsAction, removeEventAction, uploadIcsAction } from "../actions";
import { AnywhereTabs, AthletePills, familyContext } from "../_shared";

export const metadata = { title: "My Season" };

const KIND_BADGE: Record<string, "brand" | "blue" | "neutral" | "yellow"> = { game: "brand", tournament: "brand", practice: "blue", travel: "yellow", rest: "neutral" };

const eventWhat = (i: Pick<CalendarItem, "kind" | "title" | "opponent">) => i.title ?? (i.opponent ? `${EVENT_KIND_LABEL[i.kind]} vs ${i.opponent}` : EVENT_KIND_LABEL[i.kind]);

function describeEvent(e: SeasonEvent): string {
  const when = e.weekdays ? `Every ${e.weekdays.map((d) => WEEKDAY_SHORT[d - 1]).join(", ")}, ${fmtDate(e.startsOn)} to ${fmtDate(e.endsOn)}` : fmtDate(e.startsOn);
  const time = e.startTimeLocal ? ` at ${fmt(localToUtc(e.startsOn, e.startTimeLocal, e.timezone), "h:mm a", e.timezone)}` : "";
  return `${when}${time}${e.durationMinutes ? `, ${e.durationMinutes} min` : ""}`;
}

export default async function SeasonPage({ searchParams }: { searchParams: Promise<{ athlete?: string }> }) {
  const sp = await searchParams;
  const { v, children, child, isAthlete } = await familyContext(sp.athlete);
  const first = child?.name.split(" ")[0];
  const hero = (
    <ModuleHero kicker="On Your Own" title={isAthlete || !first ? "My Season" : `${first}'s season`} description="Add your team's practices and games. Log how they went so your coaches can plan gym days around them.">
      <AthletePills base="/anywhere/season" items={children} current={child?.athleteId} />
    </ModuleHero>
  );
  if (!child) {
    return (
      <div className="mx-auto max-w-5xl">
        {hero}
        <EmptyState title="No athletes linked to your account yet">Ask the front desk to link your athlete to your account.</EmptyState>
      </div>
    );
  }
  const multi = children.length > 1;
  const access = await anywhereAccess(db, v, child.athleteId);
  if (!access?.canSeeSeason) {
    return (
      <div className="mx-auto max-w-5xl">
        {hero}
        <EmptyState title="The season calendar is not shared with this account" />
      </div>
    );
  }
  const tz = (await getOrg(v.orgId))?.timezone;
  const today = todayLocal(tz);
  const now = new Date();
  const [seasons, org] = await Promise.all([seasonsForAthlete(db, v, child.athleteId), orgAnywhere(db, v.orgId)]);
  const season = seasons.find((s) => s.startsOn <= today && s.endsOn >= today) ?? seasons.find((s) => s.startsOn > today) ?? seasons[0];
  const items = season ? await calendarForAthlete(db, v, child.athleteId, addDaysYmd(today, -14), addDaysYmd(today, 28)) : [];
  const started = (i: CalendarItem) => i.date < today || (i.date === today && (!i.startsAt || i.startsAt <= now));
  const past = items.filter(started).reverse();
  const upcoming = items.filter((i) => !started(i));
  const staged = season && access.canEditSeason ? await stagedImport(db, v, season.id) : null;
  const active = !!season && season.startsOn <= today && season.endsOn >= today;

  const NewSeasonForm = (
    <ActionForm action={createSeasonAction} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="athleteId" value={child.athleteId} />
      <Field label="Team name" htmlFor="sn-team" required>
        <Input id="sn-team" name="teamName" maxLength={80} required className="h-12 text-base" />
      </Field>
      <Field label="Sport" htmlFor="sn-sport" required>
        <Input id="sn-sport" name="sport" maxLength={40} required className="h-12 text-base" />
      </Field>
      <Field label="First day" htmlFor="sn-start" required>
        <Input id="sn-start" name="startsOn" type="date" defaultValue={today} required className="h-12 text-base" />
      </Field>
      <Field label="Last day" htmlFor="sn-end" required>
        <Input id="sn-end" name="endsOn" type="date" defaultValue={addDaysYmd(today, 84)} required className="h-12 text-base" />
      </Field>
      <div className="sm:col-span-2">
        <SubmitButton size="lg" className="w-full sm:w-auto">
          Add season
        </SubmitButton>
      </div>
    </ActionForm>
  );

  return (
    <div className="mx-auto max-w-5xl">
      {hero}
      <AnywhereTabs current="season" athleteId={child.athleteId} multi={multi} />

      {!season ? (
        access.canEditSeason ? (
          <Card>
            <CardHeader title="Add a season" kicker="Start here" />
            <CardBody>{NewSeasonForm}</CardBody>
          </Card>
        ) : (
          <EmptyState title="No season added yet">A parent or guardian who books sessions can add it.</EmptyState>
        )
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <section className="rounded-md border border-edge border-l-4 border-l-brand bg-surface px-4 py-4 shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
              <div className="kicker">{active ? "In season now" : season.startsOn > today ? "Coming up" : "Finished"}</div>
              <h2 className="mt-1 text-xl leading-tight font-extrabold">{season.teamName}</h2>
              <p className="mt-0.5 text-sm text-ink-2">
                {season.sport} · {fmtDate(season.startsOn)} to {fmtDate(season.endsOn)}
              </p>
              {active && org.settings.showInSeasonOption ? (
                <p className="mt-2 text-sm text-ink-2">
                  Busy season? Teamwork has an In Season membership option.{" "}
                  <Link href={`/messages/new?athlete=${child.athleteId}`} className="inline-flex min-h-11 items-center font-semibold text-brand underline">
                    Ask the front desk about In Season
                  </Link>
                  <span className="block text-xs text-ink-3">This only starts a conversation. Nothing about your membership changes on its own.</span>
                </p>
              ) : null}
            </section>

            <Card>
              <CardHeader title="Coming up" kicker="Next 4 weeks" />
              <CardBody>
                {upcoming.length === 0 ? (
                  <p className="text-sm text-ink-3">Nothing on the calendar for the next four weeks.</p>
                ) : (
                  <ul className="divide-y divide-edge">
                    {upcoming.slice(0, 14).map((i) => (
                      <li key={`${i.eventId}-${i.date}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                        <OccurrenceLine i={i} tz={tz} today={today} />
                        {access.canEditSeason && i.weekly ? (
                          <ActionForm action={removeEventAction}>
                            <input type="hidden" name="eventId" value={i.eventId} />
                            <input type="hidden" name="date" value={i.date} />
                            <SubmitButton variant="ghost" size="sm" className="h-11!" confirm={`Skip ${EVENT_KIND_LABEL[i.kind].toLowerCase()} on ${fmtDate(i.date)}?`}>
                              Skip<span className="sr-only"> {fmtDate(i.date)}</span>
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Last 2 weeks" kicker={access.canSeeTraining ? "Log how it went" : undefined} />
              <CardBody>
                {past.length === 0 ? (
                  <p className="text-sm text-ink-3">Nothing in the last two weeks.</p>
                ) : (
                  <ul className="divide-y divide-edge">
                    {past.map((i) => (
                      <li key={`${i.eventId}-${i.date}`} className="py-2.5 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <OccurrenceLine i={i} tz={tz} today={today} />
                          {i.loggable && i.log ? (
                            <span className="text-sm font-semibold text-ok tabular">
                              Logged: {i.log.durationMinutes ?? "?"} min, effort {i.log.rpe ?? "?"}
                            </span>
                          ) : i.loggable && i.log === null ? (
                            <span className="text-sm text-ink-3">Not logged</span>
                          ) : null}
                        </div>
                        {i.loggable && access.canLog && i.date >= addDaysYmd(today, -30) ? (
                          <details className="mt-1">
                            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-brand underline">
                              {i.log ? "Change" : "Log it"}
                              <span className="sr-only">
                                : {eventWhat(i)} on {fmtDate(i.date)}
                              </span>
                            </summary>
                            <div className="mt-2 rounded-md border border-edge bg-surface-2 p-3">
                              <SportLogForm athleteId={child.athleteId} eventId={i.eventId} date={i.date} defaultMinutes={i.log?.durationMinutes ?? i.durationMinutes} defaultRpe={i.log?.rpe} idPrefix={`sl-${i.eventId.slice(0, 8)}-${i.date}`} />
                            </div>
                          </details>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {access.canSeeTraining ? <p className="mt-3 text-xs text-ink-3">A practice or game that is not logged stays unknown. It is never counted as zero.</p> : null}
              </CardBody>
            </Card>

            {access.canLog ? (
              <Card>
                <CardHeader title="Log something that is not on the calendar" />
                <CardBody>
                  <SportLogForm athleteId={child.athleteId} date={today} idPrefix="sl-adhoc" submitLabel="Log it" adHoc={{ clientKey: `adhoc-${randomUUID()}`, maxDate: today, minDate: addDaysYmd(today, -30) }} />
                </CardBody>
              </Card>
            ) : null}
          </div>

          <div className="space-y-4">
            {access.canEditSeason ? (
              <Card>
                <CardHeader title="Add to the calendar" />
                <CardBody>
                  <ActionForm action={addEventAction} resetOnSuccess className="space-y-3">
                    <input type="hidden" name="seasonId" value={season.id} />
                    <Field label="What" htmlFor="ev-kind">
                      <Select id="ev-kind" name="kind" defaultValue="practice" className="h-12 text-base">
                        {SEASON_EVENT_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {EVENT_KIND_LABEL[k]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <fieldset>
                      <legend className="text-sm font-medium text-ink-2">How often</legend>
                      <div className="mt-1 flex gap-4">
                        <label className="flex min-h-11 items-center gap-2 text-sm">
                          <input type="radio" name="repeat" value="once" defaultChecked /> One day
                        </label>
                        <label className="flex min-h-11 items-center gap-2 text-sm">
                          <input type="radio" name="repeat" value="weekly" /> Every week
                        </label>
                      </div>
                    </fieldset>
                    <Field label="Date" htmlFor="ev-date" hint="For a weekly event, this is the first week. Leave it empty to start with the season.">
                      <Input id="ev-date" name="date" type="date" min={season.startsOn} max={season.endsOn} defaultValue={today >= season.startsOn && today <= season.endsOn ? today : season.startsOn} className="h-12 text-base" />
                    </Field>
                    <fieldset>
                      <legend className="text-sm font-medium text-ink-2">Days of the week (weekly only)</legend>
                      <div className="mt-1 grid grid-cols-4 gap-1.5">
                        {WEEKDAY_SHORT.map((d, i) => (
                          <label key={d} className="flex min-h-11 items-center gap-1.5 rounded-md border border-edge px-2 text-sm">
                            <input type="checkbox" name="weekdays" value={i + 1} /> {d}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Start time" htmlFor="ev-time">
                        <Input id="ev-time" name="startTime" type="time" className="h-12 text-base" />
                      </Field>
                      <Field label="Minutes" htmlFor="ev-dur">
                        <Input id="ev-dur" name="durationMinutes" type="number" inputMode="numeric" min={5} max={720} className="h-12 text-base" />
                      </Field>
                    </div>
                    <Field label="Opponent" htmlFor="ev-opp">
                      <Input id="ev-opp" name="opponent" maxLength={80} className="h-12 text-base" />
                    </Field>
                    <Field label="Where" htmlFor="ev-loc" hint="Shown exactly as you type it. It is never looked up on a map.">
                      <Input id="ev-loc" name="location" maxLength={120} className="h-12 text-base" />
                    </Field>
                    <SubmitButton size="lg" className="w-full">
                      Add
                    </SubmitButton>
                  </ActionForm>
                </CardBody>
              </Card>
            ) : null}

            {access.canEditSeason ? (
              <Card>
                <CardHeader title="Import a calendar file" kicker=".ics, up to 256 KB" />
                <CardBody className="space-y-3">
                  {staged ? (
                    <div>
                      <p className="text-sm font-semibold">
                        Preview of {staged.fileName}: {staged.events.length} event{staged.events.length === 1 ? "" : "s"}
                      </p>
                      {staged.warnings.length ? (
                        <Callout tone="warn" className="mt-2">
                          <ul className="list-disc space-y-0.5 pl-4">
                            {staged.warnings.map((w) => (
                              <li key={w}>{w}</li>
                            ))}
                          </ul>
                        </Callout>
                      ) : null}
                      <ul className="mt-2 max-h-64 divide-y divide-edge overflow-auto rounded-md border border-edge text-sm" tabIndex={0} aria-label="Events found in the file">
                        {staged.events.map((e) => (
                          <li key={e.uid} className="px-2.5 py-1.5">
                            <span className="font-semibold">{e.title ?? EVENT_KIND_LABEL[e.kind]}</span> <span className="text-ink-3">({EVENT_KIND_LABEL[e.kind]})</span>
                            <span className="block text-xs text-ink-2">
                              {e.weekdays ? `Every ${e.weekdays.map((d) => WEEKDAY_SHORT[d - 1]).join(", ")}, ${fmtDate(e.startsOn)} to ${fmtDate(e.endsOn)}` : fmtDate(e.startsOn)}
                              {e.startTimeLocal ? ` at ${e.startTimeLocal}` : ""}
                              {e.location ? ` · ${e.location}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <ActionForm action={importIcsAction} className="mt-3">
                        <input type="hidden" name="importId" value={staged.id} />
                        <div className="flex flex-wrap gap-2">
                          <SubmitButton name="do" value="import" size="lg" className="flex-1">
                            Import these
                          </SubmitButton>
                          <SubmitButton name="do" value="discard" variant="secondary" size="lg">
                            Discard
                          </SubmitButton>
                        </div>
                      </ActionForm>
                      <p className="mt-2 text-xs text-ink-3">Importing the same file again updates these events. It never adds them twice.</p>
                    </div>
                  ) : (
                    <ActionForm action={uploadIcsAction} resetOnSuccess className="space-y-3">
                      <input type="hidden" name="seasonId" value={season.id} />
                      <Field label="Calendar file" htmlFor="ics-file" hint="Export an .ics file from your team's calendar app. You will see a preview before anything is added. Links to online calendars are not supported.">
                        <input id="ics-file" name="file" type="file" accept=".ics,text/calendar" required className="block w-full text-sm file:mr-3 file:h-11 file:rounded-md file:border file:border-edge file:bg-surface file:px-3 file:font-semibold" />
                      </Field>
                      <SubmitButton variant="secondary" size="lg" className="w-full" pendingText="Reading...">
                        Upload and preview
                      </SubmitButton>
                    </ActionForm>
                  )}
                </CardBody>
              </Card>
            ) : null}

            <Card>
              <CardHeader title="Everything in this season" kicker={`${season.events.length} item${season.events.length === 1 ? "" : "s"}`} />
              <CardBody>
                {season.events.length === 0 ? (
                  <p className="text-sm text-ink-3">No practices or games yet.</p>
                ) : (
                  <ul className="divide-y divide-edge text-sm">
                    {season.events.map((e) => (
                      <li key={e.id} className="flex items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
                        <span className="min-w-0">
                          <span className="font-semibold">{eventWhat(e)}</span>
                          <span className="block text-xs text-ink-2">{describeEvent(e)}</span>
                          {e.location ? <span className="block text-xs text-ink-3">{e.location}</span> : null}
                        </span>
                        {access.canEditSeason ? (
                          <ActionForm action={removeEventAction}>
                            <input type="hidden" name="eventId" value={e.id} />
                            <SubmitButton variant="ghost" size="sm" className="h-11!" confirm="Remove this from the season?">
                              Remove<span className="sr-only">: {eventWhat(e)}, {describeEvent(e)}</span>
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            {access.canEditSeason ? (
              <Card>
                <CardBody>
                  <details>
                    <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-brand underline">Add another season, or remove this one</summary>
                    <div className="mt-3 space-y-4">
                      {NewSeasonForm}
                      <ActionForm action={deleteSeasonAction}>
                        <input type="hidden" name="seasonId" value={season.id} />
                        <SubmitButton variant="outline" confirm={`Remove ${season.teamName} and its calendar? Anything already logged stays in your training load.`}>
                          Remove {season.teamName}
                        </SubmitButton>
                      </ActionForm>
                    </div>
                  </details>
                </CardBody>
              </Card>
            ) : null}
            {seasons.length > 1 ? (
              <p className="text-xs text-ink-3">
                Other seasons on file: {seasons.filter((s) => s.id !== season.id).map((s) => `${s.teamName} (${fmtDate(s.startsOn)} to ${fmtDate(s.endsOn)})`).join("; ")}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function OccurrenceLine({ i, tz, today }: { i: CalendarItem; tz?: string; today: string }) {
  return (
    <>
      <div aria-hidden className="flex w-12 shrink-0 flex-col items-center overflow-hidden rounded-lg border border-edge text-center">
        <span className="w-full bg-surface-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink-2">{fmt(localToUtc(i.date, "12:00", tz), "EEE", tz)}</span>
        <span className="py-0.5 text-lg leading-none font-extrabold tabular">{Number(i.date.slice(8))}</span>
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <p className="flex flex-wrap items-center gap-1.5 font-semibold leading-snug">
          {eventWhat(i)}
          <Badge variant={KIND_BADGE[i.kind]}>{EVENT_KIND_LABEL[i.kind]}</Badge>
          {i.date === today ? <Badge variant="green">Today</Badge> : null}
        </p>
        <p className="text-sm text-ink-2">
          {fmtDate(i.date)}
          {i.startsAt ? ` · ${fmtTime(i.startsAt, tz)}` : ""}
          {i.location ? ` · ${i.location}` : ""}
        </p>
      </div>
    </>
  );
}
