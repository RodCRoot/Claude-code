import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { WinsStaffTabs } from "@/components/wins/staff";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, Textarea } from "@/components/ui";
import { getOrg, requireCap } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { fmt } from "@/lib/time";
import { alumniDisplayName, BASIS_MAX } from "@/lib/newswatch/shared";
import { athleteWatchList, listAlumni } from "@/lib/newswatch/watch";
import { ModuleHero } from "../../training/_components/tb";
import { createAlumnusAction, requestNewsOptInAction, setAlumniActiveAction, setAlumniWatchAction, setNewsOptInAction, setWatchTermsAction, updateAlumnusAction } from "../news-actions";

export const metadata = { title: "News watch list" };

export default async function NewsWatchListPage() {
  const v = await requireCap("wins.review");
  const tz = (await getOrg(v.orgId))?.timezone;
  const manage = can(v, "people.manage");
  const athletes = await athleteWatchList(db, v);
  const alumni = await listAlumni(db, v);
  const on = athletes.filter((a) => a.optedIn);
  const rest = athletes.filter((a) => !a.optedIn);
  return (
    <div className="mx-auto max-w-6xl">
      <ModuleHero kicker="Wins" title="News watch list" description="Whose names News watch looks for. Current athletes are watched only when their family switched it on. Alumni are added by staff with a recorded reason." />
      <WinsStaffTabs v={v} current="watch" />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card id="watch-athletes">
            <CardHeader title="Current athletes" kicker={`${on.length} watched of ${athletes.length}`} />
            <CardBody>
              <Callout tone="info" className="mb-3">
                Staff cannot switch this on. A parent or guardian who can sign forms decides for an athlete under 18, and an adult athlete decides alone, on their Wins page. &quot;Ask the family&quot; shows them the question in the app. It sends no message.
              </Callout>
              {on.length === 0 ? <p className="mb-3 text-sm text-ink-3">No family has switched News watch on yet.</p> : null}
              <ul className="divide-y divide-edge">
                {on.map((a) => (
                  <li key={a.athleteId} className="space-y-2 py-3 first:pt-0 last:pb-0">
                    <p className="flex flex-wrap items-center gap-2">
                      <Link href={`/people/${a.personId}`} className="font-semibold hover:underline">
                        {a.name}
                      </Link>
                      <Badge variant="green">Watched</Badge>
                      {a.hidden ? <Badge variant="yellow">Name hidden: clips cannot be shown</Badge> : null}
                    </p>
                    <p className="text-xs text-ink-3">
                      Switched on by the family{a.decidedAt ? ` on ${fmt(a.decidedAt, "MMM d, yyyy", tz)}` : ""}. Matching words: {[a.school, a.sport, a.town].filter(Boolean).join(", ") || "none yet"}.
                    </p>
                    <details>
                      <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-brand underline">
                        Matching words<span className="sr-only"> for {a.name}</span>
                      </summary>
                      <ActionForm action={setWatchTermsAction} className="grid gap-3 sm:grid-cols-3">
                        <input type="hidden" name="athleteId" value={a.athleteId} />
                        <Field label="School" htmlFor={`ws-${a.athleteId}`}>
                          <Input id={`ws-${a.athleteId}`} name="school" defaultValue={a.school ?? ""} maxLength={80} autoComplete="off" />
                        </Field>
                        <Field label="Sport" htmlFor={`wp-${a.athleteId}`}>
                          <Input id={`wp-${a.athleteId}`} name="sport" defaultValue={a.sport ?? ""} maxLength={40} autoComplete="off" />
                        </Field>
                        <Field label="Town" htmlFor={`wt-${a.athleteId}`}>
                          <Input id={`wt-${a.athleteId}`} name="town" defaultValue={a.town ?? ""} maxLength={60} autoComplete="off" />
                        </Field>
                        <div className="sm:col-span-3">
                          <SubmitButton size="sm">Save matching words</SubmitButton>
                        </div>
                      </ActionForm>
                    </details>
                    {manage ? (
                      <ActionForm action={setNewsOptInAction}>
                        <input type="hidden" name="athleteId" value={a.athleteId} />
                        <input type="hidden" name="optIn" value="off" />
                        <SubmitButton size="sm" variant="ghost" confirm={`Stop watching for ${a.name}? Their news clips are closed or taken down. Only the family can switch it back on.`}>
                          Stop watching<span className="sr-only"> {a.name}</span>
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          <Card id="watch-not-on">
            <CardHeader title="Not watched" kicker={`${rest.length} athletes`} />
            <CardBody>
              <ul className="divide-y divide-edge">
                {rest.map((a) => (
                  <li key={a.athleteId} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                    <span className="text-sm">
                      <Link href={`/people/${a.personId}`} className="font-semibold hover:underline">
                        {a.name}
                      </Link>{" "}
                      <span className="text-ink-3">{a.requested ? "Asked, waiting for the family" : a.declined ? "The family said no" : a.isMinor ? "Under 18: a guardian decides" : "Adult: decides alone"}</span>
                    </span>
                    {!a.requested && !a.declined && !a.hidden ? (
                      <ActionForm action={requestNewsOptInAction}>
                        <input type="hidden" name="athleteId" value={a.athleteId} />
                        <SubmitButton size="sm" variant="secondary">
                          Ask the family<span className="sr-only"> of {a.name}</span>
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          <Card id="watch-alumni">
            <CardHeader title="Alumni" kicker={`${alumni.filter((a) => a.watch).length} watched of ${alumni.length}`} />
            <CardBody>
              <Callout tone="info" className="mb-3">
                Alumni are adults competing publicly in college. Record why each one is watched. Families see an alumnus as first name and last initial unless you record that the full name is fine.
              </Callout>
              {alumni.length === 0 ? <EmptyState title="No alumni yet">Add one below, or use &quot;Mark as alumni&quot; on an athlete&apos;s profile.</EmptyState> : null}
              <ul className="divide-y divide-edge">
                {alumni.map((a) => (
                  <li key={a.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">
                        {a.firstName} {a.lastName}
                      </span>
                      {a.watch ? <Badge variant="green">Watched</Badge> : <Badge variant="neutral">Not watched</Badge>}
                      {!a.active ? <Badge variant="neutral">Inactive</Badge> : null}
                    </p>
                    <p className="text-xs text-ink-3">
                      {[a.sport, a.college, a.gradYear ? `Class of ${a.gradYear}` : null].filter(Boolean).join(" · ") || "No details yet"} · Shown to families as {alumniDisplayName(a)}
                      {a.watch && a.watchBasis ? ` · Basis: ${a.watchBasis}` : ""}
                    </p>
                    {manage ? (
                      <>
                        {a.watch ? (
                          <ActionForm action={setAlumniWatchAction}>
                            <input type="hidden" name="alumniId" value={a.id} />
                            <input type="hidden" name="watch" value="off" />
                            <SubmitButton size="sm" variant="secondary">
                              Remove from watch list<span className="sr-only">: {a.firstName} {a.lastName}</span>
                            </SubmitButton>
                          </ActionForm>
                        ) : a.active ? (
                          <details>
                            <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-brand underline">
                              Add to watch list<span className="sr-only">: {a.firstName} {a.lastName}</span>
                            </summary>
                            <ActionForm action={setAlumniWatchAction} className="space-y-2">
                              <input type="hidden" name="alumniId" value={a.id} />
                              <input type="hidden" name="watch" value="on" />
                              <Field label="On what basis?" htmlFor={`ab-${a.id}`} required hint='For example "gave permission at alumni day" or "public college roster".'>
                                <Input id={`ab-${a.id}`} name="basis" required minLength={5} maxLength={BASIS_MAX} autoComplete="off" />
                              </Field>
                              <SubmitButton size="sm">Start watching</SubmitButton>
                            </ActionForm>
                          </details>
                        ) : null}
                        <details>
                          <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-brand underline">
                            Edit<span className="sr-only">: {a.firstName} {a.lastName}</span>
                          </summary>
                          <AlumniFields action={updateAlumnusAction} a={a} idp={`e-${a.id}`} submit="Save" />
                          <ActionForm action={setAlumniActiveAction} className="mt-2">
                            <input type="hidden" name="alumniId" value={a.id} />
                            <input type="hidden" name="active" value={a.active ? "off" : "on"} />
                            <SubmitButton size="sm" variant="ghost">
                              {a.active ? "Make inactive" : "Make active"}
                              <span className="sr-only">: {a.firstName} {a.lastName}</span>
                            </SubmitButton>
                          </ActionForm>
                        </details>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
          {manage ? (
            <Card id="add-alumni">
              <CardHeader title="Add an alumnus" kicker="Owner, admin and operations" />
              <CardBody>
                <AlumniFields action={createAlumnusAction} idp="new" submit="Add alumnus" reset />
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type A = Awaited<ReturnType<typeof listAlumni>>[number];

function AlumniFields({ action, a, idp, submit, reset }: { action: typeof createAlumnusAction; a?: A; idp: string; submit: string; reset?: boolean }) {
  return (
    <ActionForm action={action} resetOnSuccess={reset} className="space-y-3">
      {a ? <input type="hidden" name="alumniId" value={a.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name" htmlFor={`${idp}-fn`} required>
          <Input id={`${idp}-fn`} name="firstName" required maxLength={60} defaultValue={a?.firstName ?? ""} autoComplete="off" />
        </Field>
        <Field label="Last name" htmlFor={`${idp}-ln`} required>
          <Input id={`${idp}-ln`} name="lastName" required maxLength={60} defaultValue={a?.lastName ?? ""} autoComplete="off" />
        </Field>
        <Field label="Sport" htmlFor={`${idp}-sp`}>
          <Input id={`${idp}-sp`} name="sport" maxLength={40} defaultValue={a?.sport ?? ""} autoComplete="off" />
        </Field>
        <Field label="College or team" htmlFor={`${idp}-co`}>
          <Input id={`${idp}-co`} name="college" maxLength={100} defaultValue={a?.college ?? ""} autoComplete="off" />
        </Field>
        <Field label="Graduation year" htmlFor={`${idp}-gy`}>
          <Input id={`${idp}-gy`} name="gradYear" type="number" min={1990} max={2100} defaultValue={a?.gradYear ?? ""} />
        </Field>
      </div>
      <Field label="Notes" htmlFor={`${idp}-no`}>
        <Textarea id={`${idp}-no`} name="notes" rows={2} maxLength={500} defaultValue={a?.notes ?? ""} />
      </Field>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" name="fullNameOk" defaultChecked={a?.fullNameOk ?? false} className="size-5 accent-brand" />
        They said showing their full name is fine
      </label>
      <SubmitButton size="sm">{submit}</SubmitButton>
    </ActionForm>
  );
}
