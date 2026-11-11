import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, buttonClass, ButtonLink, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Stat, StatusBadge, Table, Td, Th } from "@/components/ui";
import { athletes, formTemplates, people } from "@/db/schema";
import { requireCap } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { EVENT_KIND_LABEL } from "@/lib/events/events";
import { ageLabel, paymentLabel, staffEventDetail } from "@/lib/events/queries";
import { releaseExpiredHolds } from "@/lib/events/registration";
import { formatMoney } from "@/lib/money";
import { fmt, fmtDate, fmtTime } from "@/lib/time";
import { addEventSessionAction, cancelRegistrationAction, setEventStatusAction, staffRegisterAction } from "../../_events/actions";
import { EventForm } from "../_form";

export const metadata = { title: "Event" };

export default async function EventDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const v = await requireCap("schedule.manage");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  await db.transaction((tx) => releaseExpiredHolds(tx, v.orgId));
  const d = await staffEventDetail(db, v, id);
  if (!d) notFound();
  const { event: e, tz, counts } = d;
  const created = (await searchParams).created === "1";
  const canRegister = can(v, "billing.manage");
  const live = d.registrations.filter((r) => r.status === "held" || r.status === "confirmed");
  const gone = d.registrations.filter((r) => r.status === "cancelled" || r.status === "expired");
  const liveIds = new Set(live.map((r) => r.athleteId));
  const [forms, roster] = await Promise.all([
    db.select({ id: formTemplates.id, name: formTemplates.name }).from(formTemplates).where(and(eq(formTemplates.orgId, v.orgId), eq(formTemplates.active, true))).orderBy(asc(formTemplates.name)),
    canRegister
      ? db
          .select({ id: athletes.id, first: people.firstName, last: people.lastName })
          .from(athletes)
          .innerJoin(people, eq(people.id, athletes.personId))
          .where(and(eq(athletes.orgId, v.orgId), eq(athletes.active, true)))
          .orderBy(asc(people.lastName), asc(people.firstName))
      : Promise.resolve([]),
  ]);
  const ages = ageLabel(e);

  return (
    <>
      <PageHeader
        kicker={`${EVENT_KIND_LABEL[e.kind]}${e.isDemo ? " · sample data" : ""}`}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {e.name} <StatusBadge status={e.status} />
          </span>
        }
        description={`${d.dates}${ages ? ` · ${ages}` : ""} · ${e.priceMinor === 0 ? "Free" : formatMoney(e.priceMinor, e.currency)} per athlete`}
        actions={
          <>
            <ButtonLink href="/events" variant="secondary">
              All events
            </ButtonLink>
            <a href={`/events/${e.id}/roster`} className={buttonClass("secondary")} download>
              Export roster (CSV)
            </a>
          </>
        }
      />

      {created ? (
        <Callout tone="ok" className="mb-4" title="Draft created">
          Check the details below, then publish it so families can register.
        </Callout>
      ) : null}

      <Card className="mb-5">
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-sm text-ink-2">
            {e.status === "draft"
              ? "Draft: only staff can see this. Publish it to list it for families under Shop, Camps and clinics."
              : e.status === "published"
                ? "Published: families can see it and register while spots are left and registration is open."
                : "Closed: hidden from the family list. Existing registrations and bookings stand."}
          </p>
          <ActionForm action={setEventStatusAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="eventId" value={e.id} />
            {e.status !== "published" ? (
              <SubmitButton name="status" value="published" pendingText="Publishing…">
                {e.status === "closed" ? "Reopen registration" : "Publish"}
              </SubmitButton>
            ) : null}
            {e.status === "published" ? (
              <SubmitButton name="status" value="closed" variant="secondary" pendingText="Closing…" confirm="Close registration? Families will no longer see this event. Existing registrations stay as they are.">
                Close registration
              </SubmitButton>
            ) : null}
            {e.status === "published" && counts.confirmed + counts.held === 0 ? (
              <SubmitButton name="status" value="draft" variant="ghost">
                Back to draft
              </SubmitButton>
            ) : null}
          </ActionForm>
        </CardBody>
      </Card>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Confirmed (paid)" value={counts.confirmed} tone="ok" />
        <Stat label="Holding a spot, unpaid" value={counts.held} hint={d.canSeeMoney && counts.held ? `${formatMoney(counts.heldMinor, e.currency)} awaiting payment` : `Held for ${e.holdHours} hours`} tone={counts.held ? "warn" : undefined} />
        <Stat label="Spots left" value={`${d.spotsLeft} of ${e.capacity}`} />
        {d.canSeeMoney ? (
          <Stat label="Revenue" value={formatMoney(d.netRevenueMinor, e.currency)} hint={d.refundedMinor ? `${formatMoney(counts.paidMinor, e.currency)} paid, ${formatMoney(d.refundedMinor, e.currency)} refunded` : "Paid registrations less refunds"} />
        ) : null}
      </div>

      <Card className="mb-5" id="registrations">
        <CardHeader title="Registrations" kicker={`${live.length} of ${e.capacity} spots`} />
        {live.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-3">Nobody has registered yet.</p>
          </CardBody>
        ) : (
          <Table caption="Registrations">
            <thead>
              <tr>
                <Th>Athlete</Th>
                <Th>Registration</Th>
                <Th>Payment</Th>
                <Th align="right">Amount</Th>
                <Th>Billing account</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {live.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Link href={`/people/${r.personId}`} className="font-semibold hover:underline">
                      {r.athleteName}
                    </Link>
                    <div className="text-xs text-ink-3">Registered {fmt(r.createdAt, "MMM d", tz)}{r.registeredBy ? ` by ${r.registeredBy}` : ""}</div>
                  </Td>
                  <Td>
                    {r.status === "confirmed" ? <Badge variant="green">Confirmed</Badge> : <Badge variant="yellow">Spot held</Badge>}
                    {r.status === "held" && r.holdExpiresAt ? <div className="mt-0.5 text-xs text-ink-3">until {fmt(r.holdExpiresAt, "MMM d h:mm a", tz)}</div> : null}
                  </Td>
                  <Td>
                    <Badge variant={r.invoiceStatus === "paid" ? "green" : "yellow"}>{paymentLabel(r)}</Badge>
                    {r.invoiceId && d.canSeeMoney ? (
                      <div className="mt-0.5 text-xs">
                        <Link href={`/billing/invoices/${r.invoiceId}`} className="text-brand underline">
                          {r.invoiceNumber}
                        </Link>
                      </div>
                    ) : null}
                  </Td>
                  <Td align="right">
                    {formatMoney(r.amountMinor, e.currency)}
                    {r.earlyBird || r.siblingDiscountMinor ? <div className="text-xs text-ink-3">{[r.earlyBird ? "early bird" : null, r.siblingDiscountMinor ? "sibling discount" : null].filter(Boolean).join(", ")}</div> : null}
                  </Td>
                  <Td>{r.payerName}</Td>
                  <Td>
                    <details className="text-sm">
                      <summary className="cursor-pointer font-semibold text-bad">Cancel</summary>
                      <ActionForm action={cancelRegistrationAction} className="mt-2 w-64 space-y-2">
                        <input type="hidden" name="registrationId" value={r.id} />
                        <label className="block text-xs font-medium text-ink-2" htmlFor={`why-${r.id}`}>
                          Reason
                        </label>
                        <Input id={`why-${r.id}`} name="reason" required maxLength={200} className="h-10" />
                        <p className="text-xs text-ink-3">{r.invoiceStatus === "paid" ? "Releases the spot. The payment is not touched: refund it from the invoice if one is due." : "Releases the spot and voids the unpaid invoice."}</p>
                        <SubmitButton variant="danger" size="sm" pendingText="Cancelling…">
                          Cancel registration
                        </SubmitButton>
                      </ActionForm>
                    </details>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {gone.length ? (
          <CardBody className="border-t border-edge">
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-ink-2">Released spots ({gone.length})</summary>
              <ul className="mt-2 space-y-1 text-sm text-ink-2">
                {gone.map((r) => (
                  <li key={r.id}>
                    {r.athleteName}: {r.status === "expired" ? "hold expired unpaid" : `cancelled${r.cancelReason ? ` (${r.cancelReason})` : ""}`}
                    {r.invoiceNumber ? `, invoice ${r.invoiceNumber} ${r.invoiceStatus}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          </CardBody>
        ) : null}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {canRegister ? (
          <Card>
            <CardHeader title="Register an athlete" kicker="Front desk" />
            <CardBody>
              <ActionForm action={staffRegisterAction} className="space-y-3" resetOnSuccess>
                <input type="hidden" name="eventId" value={e.id} />
                <input type="hidden" name="key" value={randomUUID()} />
                <Field label="Athlete" htmlFor="reg-athlete" required>
                  <Select id="reg-athlete" name="athleteId" required defaultValue="" className="h-11">
                    <option value="" disabled>
                      Choose an athlete
                    </option>
                    {roster
                      .filter((a) => !liveIds.has(a.id))
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.last}, {a.first}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Override age or form requirements (reason)" htmlFor="reg-override" hint="Leave empty to apply the normal checks.">
                  <Input id="reg-override" name="overrideReason" maxLength={200} className="h-11" />
                </Field>
                <p className="text-xs text-ink-3">Holds a spot and opens an invoice on the athlete&apos;s billing account. Record the payment on the invoice to confirm the registration.</p>
                <SubmitButton pendingText="Registering…">Hold spot and create invoice</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Sessions" kicker={`${d.sessions.filter((s) => s.status === "scheduled").length} scheduled`} />
          <CardBody className="space-y-3">
            <ul className="divide-y divide-edge text-sm">
              {d.sessions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0">
                  <Link href={`/schedule/sessions/${s.id}`} className="font-medium text-brand underline">
                    {fmt(s.startsAt, "EEE, MMM d", tz)}, {fmtTime(s.startsAt, tz)} to {fmtTime(s.endsAt, tz)}
                  </Link>
                  {s.status !== "scheduled" ? <StatusBadge status={s.status} /> : null}
                </li>
              ))}
            </ul>
            <p className="text-xs text-ink-3">Open a session to see its roster, take attendance, change the coach or time, or cancel that day.</p>
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-brand">Add a session</summary>
              <ActionForm action={addEventSessionAction} className="mt-2 grid grid-cols-2 items-end gap-2 sm:grid-cols-4" resetOnSuccess>
                <input type="hidden" name="eventId" value={e.id} />
                <label className="col-span-2 block text-xs font-medium text-ink-2">
                  Date
                  <Input type="date" name="sessionDate" required className="mt-1 h-11" />
                </label>
                <label className="block text-xs font-medium text-ink-2">
                  Starts
                  <Input type="time" name="sessionStart" required defaultValue="09:00" className="mt-1 h-11" />
                </label>
                <label className="block text-xs font-medium text-ink-2">
                  Ends
                  <Input type="time" name="sessionEnd" required defaultValue="12:00" className="mt-1 h-11" />
                </label>
                <div className="col-span-2 sm:col-span-4">
                  <SubmitButton variant="secondary">Add session</SubmitButton>
                </div>
              </ActionForm>
            </details>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-5" id="edit">
        <CardHeader title="Details and pricing" kicker={e.registrationOpensOn || e.registrationClosesOn ? `Registration ${e.registrationOpensOn ? `from ${fmtDate(e.registrationOpensOn)}` : ""} ${e.registrationClosesOn ? `through ${fmtDate(e.registrationClosesOn)}` : ""}`.trim() : undefined} />
        <CardBody>
          <EventForm event={e} forms={forms} />
          <p className="mt-3 text-xs text-ink-3">Price changes apply to new registrations only. Invoices already issued keep the amount they were issued for.</p>
        </CardBody>
      </Card>
    </>
  );
}
