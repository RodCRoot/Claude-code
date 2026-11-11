import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { priceLabel, SpotsBadge } from "@/components/events/family";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { EVENT_KIND_LABEL } from "@/lib/events/events";
import { familyEventDetail } from "@/lib/events/queries";
import { releaseExpiredHolds } from "@/lib/events/registration";
import { onlinePaymentAvailable } from "@/lib/growth/shop";
import { formatMoney } from "@/lib/money";
import { fmt, fmtDate, fmtTime } from "@/lib/time";
import { RegisterForm } from "./register-form";

export const metadata = { title: "Camp or clinic" };

const holdLabel = (hours: number) => (hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? "" : "s"}` : `${hours} hour${hours === 1 ? "" : "s"}`);

export default async function CampDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ registered?: string }> }) {
  const v = await requireViewer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  if (v.role !== "guardian" && v.role !== "athlete") redirect(`/events/${id}`);
  await db.transaction((tx) => releaseExpiredHolds(tx, v.orgId));
  const d = await familyEventDetail(db, v, id);
  if (!d) notFound();
  const { event: e, athletes } = d;
  const justRegistered = (await searchParams).registered === "1";
  const online = onlinePaymentAvailable();
  const held = athletes.filter((a) => a.state === "held");
  const registered = athletes.filter((a) => a.state === "registered");
  const open = athletes.filter((a) => a.state === "open");
  const blocked = athletes.filter((a) => a.state === "blocked");
  const heldInvoices = [...new Set(held.map((a) => a.invoiceId).filter((x): x is string => !!x))];
  const holdUntil = held.find((a) => a.holdExpiresAt)?.holdExpiresAt ?? null;
  const full = e.spotsLeft === 0;
  const canRegisterNow = !e.closedReason && !full && open.length > 0;

  return (
    <>
      <PageHeader
        kicker={EVENT_KIND_LABEL[e.kind]}
        title={e.name}
        description={e.dates}
        actions={
          <ButtonLink href="/shop/camps" variant="secondary">
            All camps and clinics
          </ButtonLink>
        }
      />
      <div className="grid max-w-5xl gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          {held.length ? (
            <Callout tone={justRegistered ? "ok" : "warn"} title={justRegistered ? `Spot held for ${held.map((a) => a.first).join(" and ")}` : `Payment needed to confirm ${held.map((a) => a.first).join(" and ")}`}>
              <p>
                {holdUntil ? `We are holding ${held.length === 1 ? "this spot" : "these spots"} until ${fmt(holdUntil, "EEE, MMM d 'at' h:mm a", e.tz)}. ` : ""}
                {online
                  ? "Nothing has been charged yet. Pay the invoice to confirm."
                  : "Nothing has been charged. Online payment is not set up yet, so please pay this invoice at the front desk. The spot is confirmed as soon as staff record the payment."}
              </p>
              {heldInvoices.length ? (
                <p className="mt-2 flex flex-wrap gap-2">
                  {heldInvoices.map((inv) => (
                    <ButtonLink key={inv} href={`/billing/invoices/${inv}`}>
                      {online ? "Continue to payment" : "View invoice"}
                    </ButtonLink>
                  ))}
                </p>
              ) : (
                <p className="mt-1">The invoice is on the billing account of the adult who registered.</p>
              )}
            </Callout>
          ) : null}
          {registered.length ? (
            <Callout tone="ok" title={`${registered.map((a) => a.first).join(" and ")} ${registered.length === 1 ? "is" : "are"} registered`}>
              Payment is confirmed and every session is on the calendar.{" "}
              <Link href="/schedule" className="font-semibold underline">
                Open the calendar
              </Link>
            </Callout>
          ) : null}

          <Card>
            <CardHeader title="Details" action={<SpotsBadge e={e} />} />
            <CardBody className="space-y-4">
              {e.description ? <p className="text-sm whitespace-pre-line text-ink-2">{e.description}</p> : null}
              <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-3 text-sm">
                <dt className="text-ink-3">When</dt>
                <dd>
                  <ul className="space-y-1">
                    {e.sessions.map((s) => (
                      <li key={s.id}>
                        <span className="font-semibold">{fmt(s.startsAt, "EEE, MMM d", e.tz)}</span>{" "}
                        <span className="text-ink-2">
                          {fmtTime(s.startsAt, e.tz)} to {fmtTime(s.endsAt, e.tz)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </dd>
                {e.ages ? (
                  <>
                    <dt className="text-ink-3">Ages</dt>
                    <dd>{e.ages.replace(/^Ages /, "")} (age on the first day)</dd>
                  </>
                ) : null}
                <dt className="text-ink-3">Price</dt>
                <dd>
                  <span className="text-lg font-bold tabular">{priceLabel(e)}</span> {e.priceMinor > 0 ? <span className="text-ink-2">per athlete</span> : null}
                  {e.earlyBird ? (
                    <span className="block text-ink-2">
                      Early bird price through {fmtDate(e.earlyBirdUntil)}. After that it is {formatMoney(e.regularPriceMinor, e.currency)}.
                    </span>
                  ) : null}
                  {e.siblingDiscountPercent && e.priceMinor > 0 ? <span className="block text-ink-2">{e.siblingDiscountPercent}% off for each additional athlete from the same family.</span> : null}
                </dd>
                <dt className="text-ink-3">Spots</dt>
                <dd>{full ? "Full" : `${e.spotsLeft} of ${e.capacity} left`}</dd>
              </dl>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <Card id="register">
            <CardHeader title="Register" />
            <CardBody className="space-y-3">
              {e.closedReason ? (
                <Callout tone="info">{e.closedReason}</Callout>
              ) : full ? (
                <Callout tone="info" title="This is full">
                  Every spot is taken or being held. Spots that are not paid for are released, so it is worth checking back. The front desk can also help.
                </Callout>
              ) : athletes.length === 0 ? (
                <Callout tone="info" title="No athletes are linked to your login">
                  Ask the front desk to link your athlete to your account, and they can register for you today.
                </Callout>
              ) : null}

              {canRegisterNow ? (
                <RegisterForm
                  eventId={e.id}
                  formKey={randomUUID()}
                  athletes={open.map((a) => ({ athleteId: a.athleteId, name: a.name }))}
                  priceMinor={e.priceMinor}
                  currency={e.currency}
                  siblingDiscountPercent={e.siblingDiscountPercent}
                  alreadyRegistered={e.mine.length}
                  spotsLeft={e.spotsLeft}
                  online={online}
                />
              ) : null}

              {blocked.length || held.length || registered.length ? (
                <ul className="space-y-2">
                  {[...registered, ...held].map((a) => (
                    <li key={a.athleteId} className="flex items-center justify-between gap-2 rounded-md border border-edge px-3 py-2 text-sm">
                      <span className="font-medium">{a.name}</span>
                      <Badge variant={a.state === "registered" ? "green" : "yellow"}>{a.state === "registered" ? "Registered" : "Awaiting payment"}</Badge>
                    </li>
                  ))}
                  {blocked.map((a) => (
                    <li key={a.athleteId} className="rounded-md border border-edge bg-surface-2 px-3 py-2 text-sm">
                      <span className="font-medium">{a.name}</span> <span className="text-ink-2">cannot be registered here yet</span>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">
                        {a.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : null}

              {canRegisterNow ? (
                <p className="text-xs text-ink-3">
                  Registering holds the spot for {holdLabel(e.holdHours)} and creates an invoice. Nothing is charged on this page. {online ? "You pay securely on the next step." : "Online payment is not set up yet, so the invoice is paid at the front desk."} If the invoice is not paid in time, the spot is released.
                  To cancel or ask about a refund, contact the front desk.
                </p>
              ) : null}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
