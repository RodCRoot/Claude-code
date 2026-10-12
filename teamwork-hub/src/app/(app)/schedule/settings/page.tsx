import { and, asc, eq, gt, inArray } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { busyBlocks, cancellationPolicies, classSeries, coachAvailability, formTemplates, resources, serviceTypes, users } from "@/db/schema";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, NotConfigured, PageHeader, StatusBadge } from "@/components/ui";
import { getOrg, requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { calendarStatus } from "@/lib/calendar/sync";
import { listCoaches } from "@/lib/scheduling/availability";
import { DEFAULT_TZ, fmt, todayLocal } from "@/lib/time";
import { generateSeriesAction, removeAvailabilityAction, removeBusyBlockAction } from "../actions";
import { ScheduleTabs } from "../_components/calendar";
import { AvailabilityForm, OneOffSessionForm, PolicyForm, ResourceForm, SeriesForm, ServiceTypeForm, TimeOffForm } from "./forms";

export const metadata = { title: "Schedule settings" };

const TABS = [
  { key: "services", label: "Services" },
  { key: "policies", label: "Cancellation policies" },
  { key: "resources", label: "Rooms & resources" },
  { key: "series", label: "Class series" },
  { key: "session", label: "One-off session" },
  { key: "availability", label: "Availability & time off" },
  { key: "calendar", label: "Calendar sync" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
const WD = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PEN: Record<string, string> = { none: "no penalty", forfeit_credit: "credit used", fee: "fee" };

function Details({ title, meta, children }: { title: React.ReactNode; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <details className="group rounded-lg border border-edge">
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="font-medium">{title}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          {meta}
          <span className="text-brand group-open:hidden">Edit</span>
        </span>
      </summary>
      <div className="border-t border-edge p-3">{children}</div>
    </details>
  );
}

export default async function ScheduleSettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const v = await requireStaff();
  const manager = can(v, "schedule.manage");
  const sp = await searchParams;
  const requested = (TABS.find((t) => t.key === sp.tab)?.key ?? "services") as TabKey;
  // Coaches can only manage their own availability & time off.
  if (!manager && requested !== "availability") redirect("/schedule/settings?tab=availability");
  const tab: TabKey = manager ? requested : "availability";
  const org = await getOrg(v.orgId);
  const tz = org?.timezone ?? DEFAULT_TZ;
  const today = todayLocal(tz);
  const coaches = (await listCoaches(db, v.orgId)).map((c) => ({ id: c.id, name: c.name }));
  const [svcs, pols, rooms] = await Promise.all([
    db.select().from(serviceTypes).where(eq(serviceTypes.orgId, v.orgId)).orderBy(asc(serviceTypes.name)),
    db.select().from(cancellationPolicies).where(eq(cancellationPolicies.orgId, v.orgId)).orderBy(asc(cancellationPolicies.name)),
    db.select().from(resources).where(eq(resources.orgId, v.orgId)).orderBy(asc(resources.name)),
  ]);
  const opt = <T extends { id: string; name: string }>(xs: T[]) => xs.map((x) => ({ id: x.id, name: x.name }));

  let body: React.ReactNode = null;
  if (tab === "services") {
    const forms = await db.select({ id: formTemplates.id, name: formTemplates.name }).from(formTemplates).where(and(eq(formTemplates.orgId, v.orgId), eq(formTemplates.active, true))).orderBy(asc(formTemplates.name));
    body = (
      <div className="space-y-6">
        <Card>
          <CardHeader title="Services" kicker={`${svcs.length} configured`} />
          <CardBody className="space-y-2">
            {svcs.length === 0 ? <EmptyState title="No services yet" /> : null}
            {svcs.map((st) => (
              <Details
                key={st.id}
                title={
                  <span className="flex items-center gap-2">
                    <span className="inline-block size-3 rounded-full" style={{ background: st.color }} aria-hidden /> {st.name}
                  </span>
                }
                meta={
                  <>
                    <Badge>{st.kind.replace("_", "-")}</Badge>
                    <span>
                      {st.defaultDurationMinutes} min · cap {st.defaultCapacity} · {st.creditCost} credit{st.creditCost === 1 ? "" : "s"}
                    </span>
                    {st.publicBookable ? <Badge variant="blue">self-book</Badge> : null}
                    {!st.active ? <Badge variant="red">inactive</Badge> : null}
                  </>
                }
              >
                <ServiceTypeForm st={st} policies={opt(pols)} forms={forms} />
              </Details>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Add a service" />
          <CardBody>
            <ServiceTypeForm policies={opt(pols)} forms={forms} />
          </CardBody>
        </Card>
      </div>
    );
  } else if (tab === "policies") {
    body = (
      <div className="space-y-6">
        <Callout tone="warn" title="Policies are business decisions">
          Teamwork Hub ships no real policy values. Anything labeled SAMPLE is demonstration data — replace it with Teamwork&apos;s approved policy before going live.
        </Callout>
        <Card>
          <CardHeader title="Cancellation & no-show policies" />
          <CardBody className="space-y-2">
            {pols.length === 0 ? <EmptyState title="No policies yet">Services without a policy always return the credit on cancellation.</EmptyState> : null}
            {pols.map((p) => (
              <Details key={p.id} title={p.name} meta={<span>{p.lateCancelWindowMinutes / 60} h window · late: {PEN[p.lateCancelPenalty]} · no-show: {PEN[p.noShowPenalty]}</span>}>
                <PolicyForm p={p} />
              </Details>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Add a policy" />
          <CardBody>
            <PolicyForm />
          </CardBody>
        </Card>
      </div>
    );
  } else if (tab === "resources") {
    body = (
      <div className="space-y-6">
        <Card>
          <CardHeader title="Rooms, areas & equipment" />
          <CardBody className="space-y-2">
            {rooms.length === 0 ? <EmptyState title="No resources yet" /> : null}
            {rooms.map((r) => (
              <Details key={r.id} title={r.name} meta={<>{r.exclusive ? <Badge variant="blue">exclusive</Badge> : null}{!r.active ? <Badge variant="red">inactive</Badge> : null}<span>{r.kind}</span></>}>
                <ResourceForm r={r} />
              </Details>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Add a resource" />
          <CardBody>
            <ResourceForm />
          </CardBody>
        </Card>
      </div>
    );
  } else if (tab === "series") {
    const series = await db.select().from(classSeries).where(eq(classSeries.orgId, v.orgId)).orderBy(asc(classSeries.title));
    const coachName = new Map(coaches.map((c) => [c.id, c.name]));
    body = (
      <div className="space-y-6">
        <Card>
          <CardHeader title="Weekly class series" kicker="Recurring" />
          <CardBody className="space-y-2">
            <p className="text-sm text-ink-3">Times are facility-local ({tz}); a 6:00 AM class stays at 6:00 AM across daylight-saving changes. Generating is safe to repeat — existing dates are skipped.</p>
            {series.length === 0 ? <EmptyState title="No series yet">Add one below, then generate sessions.</EmptyState> : null}
            {series.map((s) => (
              <Details
                key={s.id}
                title={s.title}
                meta={
                  <>
                    <span>
                      {s.weekdays.map((d) => WD[d]).join("/")} {s.startTimeLocal.slice(0, 5)} · {s.durationMinutes} min
                    </span>
                    <span>{s.coachUserId ? coachName.get(s.coachUserId) : "No coach"}</span>
                    {!s.active ? <Badge variant="red">inactive</Badge> : null}
                  </>
                }
              >
                <ActionForm action={generateSeriesAction} className="mb-4 flex flex-wrap items-end gap-2 rounded-lg bg-surface-2 p-3">
                  <input type="hidden" name="seriesId" value={s.id} />
                  <Field label="Generate sessions for the next (weeks)" htmlFor={`gw-${s.id}`}>
                    <Input id={`gw-${s.id}`} name="weeks" type="number" min={1} max={52} defaultValue={4} className="h-11 w-28" />
                  </Field>
                  <SubmitButton variant="secondary" className="min-h-11" pendingText="Generating…">
                    Generate sessions
                  </SubmitButton>
                </ActionForm>
                <SeriesForm s={s} services={opt(svcs)} coaches={coaches} rooms={opt(rooms)} today={today} />
              </Details>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Add a series" />
          <CardBody>
            <SeriesForm services={opt(svcs.filter((s) => s.active))} coaches={coaches} rooms={opt(rooms.filter((r) => r.active))} today={today} />
          </CardBody>
        </Card>
      </div>
    );
  } else if (tab === "session") {
    body = (
      <Card>
        <CardHeader title="Create a one-off session" kicker="Camp day, event, extra class" />
        <CardBody>
          <OneOffSessionForm services={opt(svcs.filter((s) => s.active))} coaches={coaches} rooms={opt(rooms.filter((r) => r.active))} today={today} />
          <p className="mt-3 text-xs text-ink-3">For private sessions and assessments use the slot finder under “Private sessions” so coach availability and buffers are respected.</p>
        </CardBody>
      </Card>
    );
  } else if (tab === "availability") {
    const scope = manager ? coaches.map((c) => c.id) : [v.userId];
    const [avail, off] = await Promise.all([
      db
        .select({ a: coachAvailability, name: users.displayName })
        .from(coachAvailability)
        .innerJoin(users, eq(users.id, coachAvailability.coachUserId))
        .where(and(eq(coachAvailability.orgId, v.orgId), inArray(coachAvailability.coachUserId, scope.length ? scope : [v.userId])))
        .orderBy(asc(users.displayName), asc(coachAvailability.weekday), asc(coachAvailability.startLocal)),
      db
        .select({ b: busyBlocks, name: users.displayName })
        .from(busyBlocks)
        .innerJoin(users, eq(users.id, busyBlocks.coachUserId))
        .where(and(eq(busyBlocks.orgId, v.orgId), inArray(busyBlocks.coachUserId, scope.length ? scope : [v.userId]), gt(busyBlocks.endsAt, new Date())))
        .orderBy(asc(busyBlocks.startsAt)),
    ]);
    body = (
      <div className="space-y-6">
        <Card>
          <CardHeader title={manager ? "Coach availability" : "My availability"} kicker="Private sessions & assessments" />
          <CardBody>
            {avail.length === 0 ? (
              <EmptyState title="No availability set">Without availability, no private or assessment times are offered.</EmptyState>
            ) : (
              <ul className="divide-y divide-edge">
                {avail.map(({ a, name }) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span>
                      {manager ? <span className="font-medium">{name} · </span> : null}
                      {WD[a.weekday]} {a.startLocal.slice(0, 5)}–{a.endLocal.slice(0, 5)}
                      {a.effectiveFrom || a.effectiveTo ? <span className="text-xs text-ink-3"> ({a.effectiveFrom ?? "…"} → {a.effectiveTo ?? "…"})</span> : null}
                    </span>
                    <ActionForm action={removeAvailabilityAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <SubmitButton variant="ghost" className="min-h-11" pendingText="…" confirm="Remove this availability window?">
                        Remove
                      </SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 border-t border-edge pt-4">
              <AvailabilityForm coaches={coaches} fixedCoachId={manager ? undefined : v.userId} />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Time off & busy time" kicker="Upcoming" />
          <CardBody>
            {off.length === 0 ? (
              <p className="text-sm text-ink-3">No upcoming time off.</p>
            ) : (
              <ul className="divide-y divide-edge">
                {off.map(({ b, name }) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span>
                      {manager ? <span className="font-medium">{name} · </span> : null}
                      {fmt(b.startsAt, "EEE MMM d h:mm a", tz)} → {fmt(b.endsAt, "EEE MMM d h:mm a", tz)}
                      {b.reason ? <span className="text-ink-3"> · {b.reason}</span> : null} <Badge>{b.source.replace("_", " ")}</Badge>
                    </span>
                    {b.source !== "google_freebusy" ? (
                      <ActionForm action={removeBusyBlockAction}>
                        <input type="hidden" name="id" value={b.id} />
                        <SubmitButton variant="ghost" className="min-h-11" pendingText="…">
                          Remove
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 border-t border-edge pt-4">
              <TimeOffForm coaches={coaches} fixedCoachId={manager ? undefined : v.userId} today={today} />
            </div>
          </CardBody>
        </Card>
      </div>
    );
  } else if (tab === "calendar") {
    const st = await calendarStatus(db, v.orgId);
    const userName = new Map(coaches.map((c) => [c.id, c.name]));
    body = (
      <div className="space-y-6">
        {!st.configured ? (
          <NotConfigured provider="Google Calendar" envVars={["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]}>
            Coach calendars are not syncing. Scheduling inside Teamwork Hub works normally; sessions just won&apos;t appear in Google Calendar and Google busy time isn&apos;t imported.
          </NotConfigured>
        ) : (
          <Callout tone="warn" title="Google OAuth credentials found — coach connection flow pending">
            Credentials are set, but per-coach OAuth consent and token storage are not enabled in this build yet, so no calendar is connected. Nothing is being sent to Google.
          </Callout>
        )}
        <Card>
          <CardHeader title="How sync works" />
          <CardBody className="space-y-2 text-sm text-ink-2">
            <p>Teamwork Hub is the source of truth for sessions. Each coach&apos;s connected Google Calendar receives a copy of their sessions; edits made in Google are overwritten on the next sync.</p>
            <p>Pushes run through the job queue with retries and exponential backoff. Google free/busy time is imported as “busy” blocks so the private-session slot finder avoids conflicts.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Connections" kicker={`${st.connections.length}`} />
          <CardBody>
            {st.connections.length === 0 ? (
              <p className="text-sm text-ink-3">No coach calendars are connected.</p>
            ) : (
              <ul className="divide-y divide-edge text-sm">
                {st.connections.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>{userName.get(c.userId) ?? "Staff member"}</span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={c.status} />
                      <span className="text-xs text-ink-3">{c.lastSyncAt ? `last sync ${fmt(c.lastSyncAt, "MMM d h:mm a", tz)}` : "never synced"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {Object.keys(st.linkCounts).length ? (
              <p className="mt-3 text-xs text-ink-3">
                Event copies: {Object.entries(st.linkCounts).map(([k, n]) => `${n} ${k}`).join(", ")}
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <>
      <PageHeader kicker="Schedule" title={manager ? "Schedule settings" : "My availability"} description={manager ? "Services, policies, rooms, recurring classes, coach availability and calendar sync." : "Set when you're available for private sessions and assessments, and add time off."} />
      <ScheduleTabs current="settings" staff manager={manager} />
      {manager ? (
        <nav aria-label="Settings sections" className="mb-5 flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={`/schedule/settings?tab=${t.key}`}
              aria-current={t.key === tab ? "page" : undefined}
              className={t.key === tab ? "inline-flex min-h-11 items-center rounded-full bg-ink px-4 text-sm font-medium text-surface" : "inline-flex min-h-11 items-center rounded-full border border-edge bg-surface px-4 text-sm font-medium text-ink-2 hover:bg-surface-2"}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      ) : null}
      {body}
    </>
  );
}
