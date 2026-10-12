import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { scheduleSessions, serviceTypes } from "@/db/schema";
import { ButtonLink, Callout, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { isStaff } from "@/lib/authz/policy";
import { MAX_SERIES_WEEKS } from "@/lib/scheduling/batch-booking";
import { familyAthletes } from "@/lib/scheduling/queries";
import { fmt, fmtTime } from "@/lib/time";
import { BatchBookForm } from "../_components/batch-book-form";

export const metadata = { title: "Book for the family" };

export default async function FamilyBookPage({ searchParams }: { searchParams: Promise<{ session?: string; athlete?: string }> }) {
  const v = await requireViewer();
  const { session: sessionId, athlete } = await searchParams;
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) notFound();
  if (isStaff(v)) redirect(`/schedule/sessions/${sessionId}`);
  const [row] = await db
    .select({ s: scheduleSessions, serviceName: serviceTypes.name, creditCost: serviceTypes.creditCost })
    .from(scheduleSessions)
    .innerJoin(serviceTypes, eq(serviceTypes.id, scheduleSessions.serviceTypeId))
    .where(and(eq(scheduleSessions.id, sessionId), eq(scheduleSessions.orgId, v.orgId)));
  // Families only see sessions open for online booking.
  if (!row || row.s.visibility === "private" || row.s.status !== "scheduled") notFound();
  const s = row.s;
  const tz = s.timezone;
  const athletes = (await familyAthletes(db, v)).filter((a) => a.canBook && a.active);
  const back = `/schedule?view=day&date=${fmt(s.startsAt, "yyyy-MM-dd", tz)}${athlete ? `&athlete=${athlete}` : ""}`;
  return (
    <>
      <PageHeader
        kicker={`${row.serviceName} · ${fmt(s.startsAt, "EEEE, MMM d", tz)}`}
        title={`Book ${s.title}`}
        description={`${fmtTime(s.startsAt, tz)} – ${fmtTime(s.endsAt, tz)}. Book several of your athletes at once${s.seriesId ? ", or the same class for several weeks" : ""}.`}
        actions={
          <ButtonLink href={back} variant="outline" className="min-h-11">
            ← Schedule
          </ButtonLink>
        }
      />
      <div className="max-w-xl">
        {athletes.length === 0 ? (
          <Callout tone="info">Booking isn&apos;t enabled for any athlete on your account. Please contact the front desk.</Callout>
        ) : (
          <Card>
            <CardHeader title="Choose athletes" kicker={row.creditCost > 0 ? `Each booking uses ${row.creditCost} credit${row.creditCost === 1 ? "" : "s"} unless covered by a membership` : undefined} />
            <CardBody>
              <BatchBookForm
                sessionId={s.id}
                athletes={athletes.map((a) => ({ id: a.id, name: `${a.first} ${a.last}`, credits: a.credits }))}
                preselected={athlete ?? null}
                inSeries={!!s.seriesId}
                maxWeeks={Math.min(MAX_SERIES_WEEKS, 8)}
                idem={randomUUID()}
              />
            </CardBody>
          </Card>
        )}
        <p className="mt-3 text-xs text-ink-3">Each athlete and date is checked on its own (booking window, eligibility, space, credits). You&apos;ll see the result for every one.</p>
      </div>
    </>
  );
}
