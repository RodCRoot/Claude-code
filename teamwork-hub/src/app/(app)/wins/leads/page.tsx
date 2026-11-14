import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ClipCard } from "@/components/newswatch/clip";
import { WinsStaffTabs } from "@/components/wins/staff";
import { Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, Select, Textarea } from "@/components/ui";
import { athletes, people, SUBMITTABLE_WIN_TYPES } from "@/db/schema";
import { getOrg, requireCap } from "@/lib/auth/viewer";
import { accessibleAthleteIds, athleteScopeFilter } from "@/lib/authz/policy";
import { fmt, todayLocal } from "@/lib/time";
import { listClips } from "@/lib/newswatch/clips";
import { canApproveNews } from "@/lib/newswatch/settings";
import { athleteWatchList, listAlumni } from "@/lib/newswatch/watch";
import { listLeads } from "@/lib/wins/leads";
import { HEADLINE_MAX, LEAD_NOTE_MAX, WIN_TYPE_LABEL } from "@/lib/wins/shared";
import { ModuleHero } from "../../training/_components/tb";
import { addLeadAction, convertLeadAction, dismissLeadAction } from "../actions";
import { addManualClipAction } from "../news-actions";

export const metadata = { title: "Leads to check" };

export default async function WinLeadsPage() {
  const v = await requireCap("wins.review");
  const tz = (await getOrg(v.orgId))?.timezone;
  const today = todayLocal(tz);
  const leads = await listLeads(db, v, { status: "open" });
  const clips = await listClips(db, v, { statuses: ["suggested", "confirmed"] });
  const approver = await canApproveNews(db, v);
  const watchOptions = [
    ...(await athleteWatchList(db, v)).filter((a) => a.optedIn).map((a) => ({ value: `athlete:${a.athleteId}`, label: a.name })),
    ...(await listAlumni(db, v)).filter((a) => a.watch && a.active).map((a) => ({ value: `alumni:${a.id}`, label: `${a.firstName} ${a.lastName} (alumni)` })),
  ];
  const scope = await accessibleAthleteIds(db, v, "profile.read");
  const roster = await db
    .select({ id: athletes.id, first: people.firstName, preferred: people.preferredName, last: people.lastName, sport: athletes.sport })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.orgId, v.orgId), eq(athletes.active, true), athleteScopeFilter(scope, athletes.id)))
    .orderBy(asc(people.firstName), asc(people.lastName));
  const options = roster.map((a) => (
    <option key={a.id} value={a.id}>
      {a.preferred ?? a.first} {a.last}
    </option>
  ));
  return (
    <div className="mx-auto max-w-6xl">
      <ModuleHero kicker="Wins" title="Leads to check" description="Heard something at the front desk, or saw a write-up? Note it here. A lead becomes a draft win only the family sees until they confirm it." />
      <WinsStaffTabs v={v} current="leads" />
      <Callout tone="info" className="mb-4" title="What this does not do">
        This app does not search social media and never opens the links you paste. News clips below come from News watch, which reads headlines from the news feeds the owner listed, only for athletes whose family switched it on and for alumni on the watch list. Nothing is shown to anyone until a person approves it.
      </Callout>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card id="news-clips">
            <CardHeader title="News clips" kicker={`${clips.length} to check`} />
            <CardBody>
              <p className="mb-3 text-sm text-ink-2">
                Is it our athlete? Marking a clip only sorts it. {approver ? (
                  <>
                    Approve clips on the{" "}
                    <Link href="/wins/news" className="font-semibold text-brand underline">
                      News clips
                    </Link>{" "}
                    tab.
                  </>
                ) : (
                  "The owner, an admin, or staff the owner allowed approve it before anyone sees it."
                )}
              </p>
              {clips.length === 0 ? <p className="text-sm text-ink-3">No news clips to check right now.</p> : null}
              <ul className="divide-y divide-edge">
                {clips.map((c) => (
                  <ClipCard key={c.id} c={c} tz={tz} mode="triage" />
                ))}
              </ul>
            </CardBody>
          </Card>
          <Card id="leads-open">
            <CardHeader title="Open leads" kicker={`${leads.length} to check`} />
            <CardBody>
              {leads.length === 0 ? <EmptyState title="No open leads">Add one with the form on this page.</EmptyState> : null}
              <ul className="divide-y divide-edge">
                {leads.map((l) => (
                  <li key={l.id} className="space-y-2 py-4 first:pt-0 last:pb-0">
                    <p className="font-medium">{l.note}</p>
                    <p className="text-xs text-ink-3">
                      {l.athleteName ? `About ${l.athleteName} · ` : "No athlete attached yet · "}
                      Added by {l.createdBy ?? "staff"} on {fmt(l.createdAt, "MMM d", tz)}
                      {l.sourceUrl ? (
                        <>
                          {" · "}
                          <a href={l.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold text-brand underline">
                            Pasted link<span className="sr-only"> for this lead (opens in a new tab)</span>
                          </a>
                        </>
                      ) : null}
                    </p>
                    <details>
                      <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-brand underline">
                        Turn into a draft win<span className="sr-only">: {l.note}</span>
                      </summary>
                      <ActionForm action={convertLeadAction} className="space-y-3">
                        <input type="hidden" name="leadId" value={l.id} />
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label="Athlete" htmlFor={`la-${l.id}`} required>
                            <Select id={`la-${l.id}`} name="athleteId" required defaultValue={l.athleteId ?? ""}>
                              <option value="" disabled>
                                Choose an athlete
                              </option>
                              {options}
                            </Select>
                          </Field>
                          <Field label="Kind of win" htmlFor={`lt-${l.id}`} required>
                            <Select id={`lt-${l.id}`} name="type" required defaultValue="placing">
                              {SUBMITTABLE_WIN_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {WIN_TYPE_LABEL[t]}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field label="Sport" htmlFor={`ls-${l.id}`} required>
                            <Input id={`ls-${l.id}`} name="sport" required maxLength={40} autoComplete="off" />
                          </Field>
                          <Field label="When did it happen?" htmlFor={`ld-${l.id}`} required>
                            <Input id={`ld-${l.id}`} name="occurredOn" type="date" required defaultValue={today} max={today} />
                          </Field>
                        </div>
                        <Field label="Headline" htmlFor={`lh-${l.id}`} required hint={`First name only, up to ${HEADLINE_MAX} characters. The family reads this exact wording.`}>
                          <Input id={`lh-${l.id}`} name="headline" required maxLength={HEADLINE_MAX} autoComplete="off" />
                        </Field>
                        <SubmitButton>Create draft for the family</SubmitButton>
                      </ActionForm>
                    </details>
                    <ActionForm action={dismissLeadAction}>
                      <input type="hidden" name="leadId" value={l.id} />
                      <SubmitButton variant="ghost" size="sm">
                        Dismiss<span className="sr-only">: {l.note}</span>
                      </SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
        <div>
          {watchOptions.length ? (
            <Card id="add-news-clip" className="mb-4">
              <CardHeader title="Add a news clip by hand" kicker="Saw an article the feeds missed?" />
              <CardBody>
                <ActionForm action={addManualClipAction} resetOnSuccess className="space-y-3">
                  <Field label="Who is it about?" htmlFor="mc-person" required hint="Only people on the news watch list.">
                    <Select id="mc-person" name="person" required defaultValue="">
                      <option value="" disabled>
                        Choose a person
                      </option>
                      {watchOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Article headline" htmlFor="mc-headline" required hint="As the publication wrote it. Do not paste any of the article itself.">
                    <Input id="mc-headline" name="headline" required minLength={5} maxLength={300} autoComplete="off" />
                  </Field>
                  <Field label="Publication" htmlFor="mc-source" required>
                    <Input id="mc-source" name="sourceName" required maxLength={120} autoComplete="off" />
                  </Field>
                  <Field label="Link to the article" htmlFor="mc-link" required hint="The app stores the link and never opens it.">
                    <Input id="mc-link" name="link" type="url" inputMode="url" required placeholder="https://" autoComplete="off" />
                  </Field>
                  <Field label="Published on" htmlFor="mc-date">
                    <Input id="mc-date" name="publishedOn" type="date" defaultValue={today} max={today} />
                  </Field>
                  <SubmitButton>Add news clip</SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
          <Card id="add-lead">
            <CardHeader title="Add a lead" kicker="Staff only" />
            <CardBody>
              <ActionForm action={addLeadAction} resetOnSuccess className="space-y-3">
                <Field label="What did you hear?" htmlFor="lead-note" required hint={`Up to ${LEAD_NOTE_MAX} characters. Keep it to the achievement: no health, injury, body weight or grades.`}>
                  <Textarea id="lead-note" name="note" rows={3} required maxLength={LEAD_NOTE_MAX} />
                </Field>
                <Field label="Link (optional)" htmlFor="lead-link" hint="Paste it by hand. The app never opens it.">
                  <Input id="lead-link" name="sourceUrl" type="url" inputMode="url" placeholder="https://" autoComplete="off" />
                </Field>
                <Field label="Athlete (optional)" htmlFor="lead-athlete">
                  <Select id="lead-athlete" name="athleteId" defaultValue="">
                    <option value="">Not sure yet</option>
                    {options}
                  </Select>
                </Field>
                <SubmitButton>Add lead</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
