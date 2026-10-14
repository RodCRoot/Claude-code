import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { resources, serviceTypes } from "@/db/schema";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { can, isStaff } from "@/lib/authz/policy";
import { findAvailableSlots, listCoaches } from "@/lib/scheduling/availability";
import { parseYmd } from "@/lib/scheduling/calendar-range";
import { bookableAthletes, familyAthletes } from "@/lib/scheduling/queries";
import { DEFAULT_TZ, fmt, localYmd, todayLocal } from "@/lib/time";
import { bookSlotAction } from "../actions";
import { dayLabel, ScheduleTabs } from "../_components/calendar";
import { flatParams } from "../_components/nav";

export const metadata = { title: "Book a private session" };

export default async function BookPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireViewer();
  const p = flatParams(await searchParams);
  const org = await getOrg(v.orgId);
  const tz = org?.timezone ?? DEFAULT_TZ;
  const today = todayLocal(tz);
  const staff = isStaff(v);
  const manager = can(v, "schedule.manage");

  const services = await db
    .select()
    .from(serviceTypes)
    .where(and(eq(serviceTypes.orgId, v.orgId), eq(serviceTypes.active, true), inArray(serviceTypes.kind, ["private", "semi_private", "assessment"])))
    .orderBy(asc(serviceTypes.name));
  const offered = staff ? services : services.filter((s) => s.publicBookable);
  const athletes = staff
    ? (await bookableAthletes(db, v)).map((a) => ({ id: a.id, label: `${a.last}, ${a.first}` }))
    : (await familyAthletes(db, v)).filter((a) => a.canBook).map((a) => ({ id: a.id, label: `${a.first} ${a.last}` }));
  const coaches = await listCoaches(db, v.orgId);
  const rooms = staff ? await db.select().from(resources).where(and(eq(resources.orgId, v.orgId), eq(resources.active, true))).orderBy(asc(resources.name)) : [];

  const serviceId = offered.find((s) => s.id === p.service)?.id ?? offered[0]?.id;
  const athleteId = athletes.find((a) => a.id === p.athlete)?.id ?? athletes[0]?.id;
  const from = parseYmd(p.from, today) < today ? today : parseYmd(p.from, today);
  const coachId = coaches.find((c) => c.id === p.coach)?.id ?? null;
  const resourceId = rooms.find((r) => r.id === p.resource)?.id ?? null;
  const comp = staff && p.comp === "on";
  const searched = !!p.service;

  let slots: Awaited<ReturnType<typeof findAvailableSlots>> = [];
  let error: string | null = null;
  if (searched && serviceId) {
    try {
      slots = await findAvailableSlots(db, v, { serviceTypeId: serviceId, fromYmd: from, days: 7, coachUserId: coachId, resourceId });
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const grouped = new Map<string, typeof slots>();
  for (const s of slots) {
    const d = localYmd(s.startsAt, tz);
    grouped.set(d, [...(grouped.get(d) ?? []), s]);
  }
  const svc = offered.find((s) => s.id === serviceId);

  return (
    <>
      <PageHeader kicker="Schedule" title={staff ? "Private sessions & assessments" : "Book a private session or assessment"} description="Open times come from each coach's availability, minus booked sessions, buffers, and time off." />
      <ScheduleTabs current="book" staff={staff} manager={manager} />

      {offered.length === 0 ? (
        <EmptyState title="Nothing to book online right now">
          {staff ? "Create a private or assessment service in Schedule settings." : "Private sessions are booked by the front desk. Please contact us."}
        </EmptyState>
      ) : athletes.length === 0 ? (
        <EmptyState title="No athletes you can book for">{staff ? "No active athletes are in your scope." : "Ask the front desk to link an athlete to your account."}</EmptyState>
      ) : (
        <>
          <Card className="mb-5">
            <CardHeader kicker={staff ? "Staff booking" : "Step 1"} title="Find open times" />
            <CardBody className="pt-4">
              <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Find open times">
                <Field label="Service" htmlFor="service">
                  <Select id="service" name="service" defaultValue={serviceId} className="h-11">
                    {offered.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.defaultDurationMinutes} min)
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Athlete" htmlFor="athlete">
                  <Select id="athlete" name="athlete" defaultValue={athleteId} className="h-11">
                    {athletes.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Coach" htmlFor="coach">
                  <Select id="coach" name="coach" defaultValue={coachId ?? ""} className="h-11">
                    <option value="">Any coach</option>
                    {coaches.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Week starting" htmlFor="from">
                  <Input id="from" name="from" type="date" min={today} defaultValue={from} className="h-11" />
                </Field>
                {staff ? (
                  <Field label="Room (optional)" htmlFor="resource" hint="Exclusive rooms can't be double-booked.">
                    <Select id="resource" name="resource" defaultValue={resourceId ?? ""} className="h-11">
                      <option value="">No room</option>
                      {rooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                          {r.exclusive ? " (exclusive)" : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                {staff ? (
                  <div className="space-y-1">
                    <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-ink-2">
                      <input type="checkbox" name="comp" defaultChecked={comp} className="size-5" /> Book as comp (no credit)
                    </label>
                    <Input name="compReason" aria-label="Comp reason" placeholder="Comp reason" defaultValue={p.compReason ?? ""} className="h-11" />
                  </div>
                ) : null}
                <div className="flex items-end">
                  <button type="submit" className="h-11 w-full rounded-md bg-brand px-5 text-sm font-semibold text-brand-ink hover:brightness-110 sm:w-auto">
                    Find open times
                  </button>
                </div>
              </form>
            </CardBody>
          </Card>

          {error ? <Callout tone="bad">{error}</Callout> : null}
          {searched && !error ? (
            slots.length === 0 ? (
              <EmptyState title="No open times that week">
                Try another week or coach. {staff ? "Coach availability and time off are managed in Schedule settings → Availability." : ""}
              </EmptyState>
            ) : (
              <div className="space-y-4">
                {svc && svc.creditCost > 0 && !comp ? (
                  <p className="text-sm text-ink-3">
                    Booking uses {svc.creditCost} credit{svc.creditCost === 1 ? "" : "s"} (or an unlimited membership that covers {svc.name}).
                  </p>
                ) : null}
                {[...grouped.entries()].map(([d, list]) => (
                  <section key={d} aria-labelledby={`slots-${d}`} className="overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
                    <div className="flex items-center justify-between gap-2 border-b border-edge bg-th px-4 py-2">
                      <h2 id={`slots-${d}`} className="text-xs font-bold uppercase tracking-wide text-ink-2">
                        {dayLabel(d, "EEEE, MMMM d")}
                      </h2>
                      <span className="text-xs text-ink-3 tabular">
                        {list.length} open time{list.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <ul className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
                      {list.map((s) => (
                        <li key={`${s.coachUserId}-${s.startsAt.toISOString()}`}>
                          <ActionForm action={bookSlotAction}>
                            <input type="hidden" name="serviceTypeId" value={serviceId} />
                            <input type="hidden" name="coachUserId" value={s.coachUserId} />
                            <input type="hidden" name="athleteId" value={athleteId} />
                            <input type="hidden" name="startsAt" value={s.startsAt.toISOString()} />
                            <input type="hidden" name="idem" value={randomUUID()} />
                            {resourceId ? <input type="hidden" name="resourceId" value={resourceId} /> : null}
                            {comp ? (
                              <>
                                <input type="hidden" name="comp" value="on" />
                                <input type="hidden" name="compReason" value={p.compReason ?? ""} />
                              </>
                            ) : null}
                            <SubmitButton variant="secondary" className="min-h-12 w-full justify-between gap-2 px-3" pendingText="Booking…">
                              <span className="min-w-0 text-left">
                                <span className="block font-bold tabular text-ink">{fmt(s.startsAt, "h:mm a", tz)}</span>
                                <span className="block truncate text-xs font-normal text-ink-3">{s.coachName}</span>
                              </span>
                              <span className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-brand-ink">Book</span>
                            </SubmitButton>
                          </ActionForm>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )
          ) : null}
        </>
      )}
    </>
  );
}
