import { and, asc, eq, gt, inArray, like, lte, or, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, bookings, eventRegistrations, invoices, paymentAttempts, payerAccounts, payerBeneficiaries, people, scheduleSessions } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit, type AuditActor } from "@/lib/audit";
import { assertCan, athleteCapabilities, AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { createInvoiceRecord, invoiceMoney, settleInvoiceIfCovered } from "@/lib/billing/invoices";
import { actorOf } from "@/lib/billing/util";
import { familyName, shopAthletes } from "@/lib/growth/shop";
import { checkEligibility } from "@/lib/scheduling/eligibility";
import { orgTimezone } from "@/lib/scheduling/common";
import { fmt, localYmd } from "@/lib/time";
import { eventSessionRows, lockEvent, type EventRow, type RegistrationRow } from "./confirm";
import { priceSeats } from "./pricing";

const KIND_WORD = { camp: "camp", clinic: "clinic", event: "event" } as const;

/** Why registration is not open right now, or null when it is. Family-safe wording. */
export function registrationClosedReason(e: Pick<EventRow, "status" | "registrationOpensOn" | "registrationClosesOn">, firstStart: Date | null, now: Date, tz: string): string | null {
  if (e.status === "draft") return "Registration has not opened yet.";
  if (e.status === "closed") return "Registration is closed.";
  if (!firstStart) return "Dates have not been announced yet.";
  const today = localYmd(now, tz);
  if (e.registrationOpensOn && today < e.registrationOpensOn) return `Registration opens ${fmt(new Date(`${e.registrationOpensOn}T12:00:00Z`), "EEE, MMM d", "UTC")}.`;
  if (e.registrationClosesOn && today > e.registrationClosesOn) return "Registration is closed.";
  if (now >= firstStart) return "Registration is closed because this has already started.";
  return null;
}

/** Athletes a family login may register AND pay for: `can_pay` on the billing account and `can_book` on the athlete. */
export async function registrableAthletes(tx: Tx, v: Viewer) {
  const payable = await shopAthletes(tx, v);
  const out: typeof payable = [];
  for (const a of payable) if ((await athleteCapabilities(tx, v, a.athleteId)).has("booking.create")) out.push(a);
  return out;
}

export function eventEligibilitySpec(e: Pick<EventRow, "name" | "minAge" | "maxAge" | "requiredFormTemplateIds">) {
  return {
    name: familyName(e.name),
    eligibility: { minAge: e.minAge ?? undefined, maxAge: e.maxAge ?? undefined, requiredFormTemplateIds: e.requiredFormTemplateIds ?? [] },
  };
}

// --- Releasing holds -------------------------------------------------------------------------

const SYSTEM = (orgId: string): AuditActor => ({ orgId, actorUserId: null, actorRole: "system" });

/** A hosted checkout the family may still be completing, or a bank payment that is processing. */
async function paymentInFlight(tx: Tx, invoiceId: string, now: Date): Promise<boolean> {
  const [a] = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.invoiceId, invoiceId),
        or(
          inArray(paymentAttempts.status, ["processing", "pending"]),
          and(inArray(paymentAttempts.status, ["created", "requires_action"]), gt(paymentAttempts.createdAt, new Date(now.getTime() - 60 * 60_000))),
        ),
      ),
    )
    .limit(1);
  return !!a;
}

/**
 * After registrations on an invoice were released (expired or cancelled) and no money was recorded:
 * void the invoice, and if other athletes on it still hold a spot, issue a new invoice for just them
 * (same amounts as originally priced). The caller holds the invoice row lock.
 */
async function voidOrReissue(tx: Tx, actor: AuditActor, event: EventRow, inv: typeof invoices.$inferSelect, why: string): Promise<"voided" | "reissued"> {
  await tx.update(invoices).set({ status: "void", updatedAt: new Date() }).where(eq(invoices.id, inv.id));
  await audit(tx, actor, "billing.invoice.void", "invoice", inv.id, { summary: `Voided ${inv.number}: ${why}`, before: { status: inv.status } });
  const remaining = await tx
    .select({ reg: eventRegistrations, first: people.firstName, last: people.lastName })
    .from(eventRegistrations)
    .innerJoin(athletes, eq(athletes.id, eventRegistrations.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(eventRegistrations.invoiceId, inv.id), eq(eventRegistrations.status, "held")))
    .orderBy(asc(eventRegistrations.createdAt));
  if (!remaining.length) return "voided";
  const { invoice } = await createInvoiceRecord(tx, actor, {
    orgId: inv.orgId,
    payerAccountId: inv.payerAccountId,
    status: "open",
    source: "teamwork",
    memo: inv.memo,
    isDemo: inv.isDemo,
    currency: inv.currency,
    dueDate: inv.dueDate,
    idempotencyKey: `event-reissue:${inv.id}`,
    lines: remaining.map((r) => ({
      description: lineDescription(event, `${r.first} ${r.last}`, r.reg),
      quantity: 1,
      unitAmountMinor: r.reg.amountMinor,
      athleteId: r.reg.athleteId,
      entitlement: { eventRegistrationId: r.reg.id },
    })),
  });
  await tx.update(eventRegistrations).set({ invoiceId: invoice.id, updatedAt: new Date() }).where(inArray(eventRegistrations.id, remaining.map((r) => r.reg.id)));
  return "reissued";
}

function lineDescription(event: Pick<EventRow, "name" | "siblingDiscountPercent">, athleteName: string, p: { earlyBird: boolean; siblingDiscountMinor: number }) {
  const notes = [p.earlyBird ? "early bird price" : null, p.siblingDiscountMinor > 0 ? `sibling discount${event.siblingDiscountPercent ? ` ${event.siblingDiscountPercent}%` : ""}` : null].filter(Boolean);
  return `${event.name}: ${athleteName}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

/**
 * Release unpaid holds for one event. The caller holds the event row lock.
 * A hold is released when its time ran out, or when staff voided its invoice. It is NOT released
 * while money is recorded or in flight on the invoice (a partial payment, a processing bank
 * payment, a checkout opened in the last hour) or while the invoice row is locked by a payment
 * being recorded right now. Releasing voids the unpaid invoice so it can no longer be paid.
 */
export async function releaseExpiredHoldsForEvent(tx: Tx, event: EventRow, now: Date): Promise<number> {
  const held = await tx
    .select()
    .from(eventRegistrations)
    .where(and(eq(eventRegistrations.eventId, event.id), eq(eventRegistrations.status, "held")))
    .for("update");
  const byInvoice = new Map<string, RegistrationRow[]>();
  for (const r of held) if (r.invoiceId) byInvoice.set(r.invoiceId, [...(byInvoice.get(r.invoiceId) ?? []), r]);
  let released = 0;
  for (const [invoiceId, regs] of byInvoice) {
    // SKIP LOCKED: the payment path locks invoice → event; never wait on it from here (event → invoice).
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update", { skipLocked: true });
    if (!inv) continue;
    const dead = inv.status === "void" || inv.status === "uncollectible";
    const due = regs.filter((r) => dead || (r.holdExpiresAt != null && r.holdExpiresAt <= now));
    if (!due.length || inv.status === "paid") continue;
    if (!dead) {
      const money = await invoiceMoney(tx, inv.id);
      if (money.settledMinor > 0 || money.pendingMinor > 0 || (await paymentInFlight(tx, inv.id, now))) continue;
    }
    await tx
      .update(eventRegistrations)
      .set({ status: "expired", releasedAt: now, updatedAt: now })
      .where(inArray(eventRegistrations.id, due.map((r) => r.id)));
    for (const r of due) {
      await audit(tx, SYSTEM(event.orgId), "events.registration.expire", "event_registration", r.id, {
        summary: dead ? `Spot released for ${event.name}: invoice ${inv.number} is ${inv.status}` : `Unpaid hold for ${event.name} expired; spot released`,
        before: { status: "held" },
        after: { status: "expired" },
      });
    }
    if (!dead) await voidOrReissue(tx, SYSTEM(event.orgId), event, inv, `registration hold for ${event.name} expired unpaid`);
    released += due.length;
  }
  return released;
}

/** Release expired holds across the organization (staff pages, the family list, the job queue). */
export async function releaseExpiredHolds(tx: Tx, orgId: string, now = new Date()): Promise<number> {
  const rows = await tx
    .selectDistinct({ eventId: eventRegistrations.eventId })
    .from(eventRegistrations)
    .leftJoin(invoices, eq(invoices.id, eventRegistrations.invoiceId))
    .where(and(eq(eventRegistrations.orgId, orgId), eq(eventRegistrations.status, "held"), or(lte(eventRegistrations.holdExpiresAt, now), inArray(invoices.status, ["void", "uncollectible"]))))
    .orderBy(asc(eventRegistrations.eventId));
  let n = 0;
  for (const r of rows) {
    const event = await lockEvent(tx, orgId, r.eventId);
    if (event) n += await releaseExpiredHoldsForEvent(tx, event, now);
  }
  return n;
}

// --- Registering -----------------------------------------------------------------------------

export type RegisterInput = {
  eventId: string;
  athleteIds: string[];
  /** Client-generated per form render; a retry returns the same registrations. */
  idempotencyKey: string;
  /** Staff only: register despite age or form requirements. A reason is required. */
  override?: { reason: string } | null;
  now?: Date;
};

export type RegisterResult = {
  created: boolean;
  registrationIds: string[];
  invoices: { id: string; number: string; totalMinor: number; status: string }[];
  holdExpiresAt: Date | null;
};

/**
 * Register one or more athletes for an event. Holds the seats and creates ONE open invoice per
 * billing account through the existing invoice flow. Nothing is charged and nobody is booked here:
 * the registration is confirmed (and the athlete booked into every session) only when the invoice
 * is settled, see `confirmEventRegistration`.
 * Capacity is decided under a row lock on the event, so concurrent registrations can never oversell.
 */
export async function registerForEvent(tx: Tx, v: Viewer, input: RegisterInput): Promise<RegisterResult> {
  const now = input.now ?? new Date();
  const family = v.role === "guardian" || v.role === "athlete";
  const staff = can(v, "billing.manage");
  if (!family && !staff) throw new AuthzError("You don't have permission to register athletes for events.");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.idempotencyKey)) throw new UserError("Please reload the page and try again.");
  if (input.override && !staff) throw new AuthzError("Only staff can override eligibility.");
  if (input.override && !input.override.reason.trim()) throw new UserError("A reason is required to override eligibility.", { overrideReason: "Required" });
  const athleteIds = [...new Set(input.athleteIds.filter(Boolean))];
  if (!athleteIds.length) throw new UserError("Choose at least one athlete.");
  if (athleteIds.length > 10) throw new UserError("Register up to 10 athletes at a time.");

  const submitKey = `event:${v.userId}:${input.idempotencyKey}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${submitKey}))`);
  const prior = await tx.select().from(eventRegistrations).where(and(eq(eventRegistrations.orgId, v.orgId), eq(eventRegistrations.submitKey, submitKey)));
  if (prior.length) return resultFor(tx, prior, false);

  const event = await lockEvent(tx, v.orgId, input.eventId);
  if (!event || (event.status === "draft" && !staff)) throw new UserError("That event was not found.");
  const tz = await orgTimezone(tx, v.orgId);
  const sessions = (await eventSessionRows(tx, event.id)).filter((s) => s.status === "scheduled");
  const firstStart = sessions[0]?.startsAt ?? null;
  const closed = registrationClosedReason(event, firstStart, now, tz);
  if (closed) throw new UserError(closed);
  await releaseExpiredHoldsForEvent(tx, event, now);

  // --- Who, and on which billing account ------------------------------------------------------
  type Seat = { athleteId: string; name: string; payerAccountId: string };
  const seats: Seat[] = [];
  if (family) {
    const allowed = await registrableAthletes(tx, v);
    for (const id of athleteIds) {
      const a = allowed.find((x) => x.athleteId === id);
      if (!a) throw new AuthzError("You can view this athlete but are not authorized to register and pay for them. Please ask the adult on the billing account, or the front desk.");
      seats.push(a);
    }
  } else {
    const rows = await tx
      .select({ athleteId: athletes.id, first: people.firstName, last: people.lastName, payerAccountId: payerAccounts.id })
      .from(athletes)
      .innerJoin(people, eq(people.id, athletes.personId))
      .leftJoin(payerBeneficiaries, eq(payerBeneficiaries.athleteId, athletes.id))
      .leftJoin(payerAccounts, and(eq(payerAccounts.id, payerBeneficiaries.payerAccountId), eq(payerAccounts.orgId, v.orgId)))
      .where(and(inArray(athletes.id, athleteIds), eq(athletes.orgId, v.orgId)))
      .orderBy(asc(payerAccounts.createdAt));
    for (const id of athleteIds) {
      const mine = rows.filter((r) => r.athleteId === id);
      if (!mine.length) throw new UserError("Athlete not found.");
      const withPayer = mine.find((r) => r.payerAccountId);
      if (!withPayer?.payerAccountId) throw new UserError(`${mine[0].first} ${mine[0].last} has no billing account yet. Add one on their profile first.`);
      seats.push({ athleteId: id, name: `${withPayer.first} ${withPayer.last}`, payerAccountId: withPayer.payerAccountId });
    }
  }

  // --- Already registered, eligibility ---------------------------------------------------------
  const live = await tx
    .select({ athleteId: eventRegistrations.athleteId, payerAccountId: eventRegistrations.payerAccountId, status: eventRegistrations.status })
    .from(eventRegistrations)
    .where(and(eq(eventRegistrations.eventId, event.id), inArray(eventRegistrations.status, ["held", "confirmed"])));
  for (const s of seats) {
    const dup = live.find((l) => l.athleteId === s.athleteId);
    if (dup) throw new UserError(dup.status === "confirmed" ? `${s.name} is already registered.` : `${s.name} already has a spot held. Pay the open invoice to confirm it.`);
    if (!input.override) {
      const el = await checkEligibility(tx, { orgId: v.orgId, athleteId: s.athleteId, serviceType: eventEligibilitySpec(event), at: firstStart!, tz });
      if (!el.ok) throw new UserError(`${s.name} can't be registered yet: ${el.reasons.join(" ")}`);
    }
  }

  // --- Capacity (under the event lock) ----------------------------------------------------------
  const left = event.capacity - live.length;
  if (left <= 0) throw new UserError(`This ${KIND_WORD[event.kind]} is full.`);
  if (seats.length > left) throw new UserError(`Only ${left} spot${left === 1 ? " is" : "s are"} left, and you chose ${seats.length} athletes.`);

  // --- Hold + invoice per billing account --------------------------------------------------------
  const holdExpiresAt = new Date(Math.min(now.getTime() + event.holdHours * 3_600_000, firstStart!.getTime()));
  const today = localYmd(now, tz);
  const actor = actorOf(v);
  const created: RegistrationRow[] = [];
  for (const payerAccountId of [...new Set(seats.map((s) => s.payerAccountId))]) {
    const group = seats.filter((s) => s.payerAccountId === payerAccountId);
    const priced = priceSeats(event, today, group.length, live.filter((l) => l.payerAccountId === payerAccountId).length);
    const regs = await tx
      .insert(eventRegistrations)
      .values(
        group.map((s, i) => ({
          orgId: v.orgId,
          eventId: event.id,
          athleteId: s.athleteId,
          payerAccountId,
          status: "held" as const,
          basePriceMinor: priced[i].baseMinor,
          earlyBird: priced[i].earlyBird,
          siblingDiscountMinor: priced[i].siblingDiscountMinor,
          amountMinor: priced[i].amountMinor,
          currency: event.currency,
          holdExpiresAt,
          registeredByUserId: v.userId,
          submitKey,
          isDemo: event.isDemo,
        })),
      )
      .returning();
    const { invoice } = await createInvoiceRecord(tx, actor, {
      orgId: v.orgId,
      payerAccountId,
      status: "open",
      source: "teamwork",
      memo: `Registration: ${event.name}`,
      isDemo: event.isDemo,
      currency: event.currency,
      dueDate: localYmd(holdExpiresAt, tz),
      idempotencyKey: `${submitKey}:${payerAccountId}`,
      lines: regs.map((r, i) => ({
        description: lineDescription(event, group[i].name, priced[i]),
        quantity: 1,
        unitAmountMinor: priced[i].amountMinor,
        athleteId: r.athleteId,
        entitlement: { eventRegistrationId: r.id },
      })),
    });
    await tx.update(eventRegistrations).set({ invoiceId: invoice.id }).where(inArray(eventRegistrations.id, regs.map((r) => r.id)));
    // A free event is a $0 invoice, which the invoice flow marked paid before the registrations
    // pointed at it. Run settlement again so they are confirmed through the same path.
    if (invoice.totalMinor === 0) await settleInvoiceIfCovered(tx, invoice.id, actor);
    for (const [i, r] of regs.entries()) {
      await audit(tx, actor, "events.registration.create", "event_registration", r.id, {
        summary: `${group[i].name} registered for ${event.name}: spot held until ${fmt(holdExpiresAt, "MMM d h:mm a", tz)}, invoice ${invoice.number} (${priced[i].amountMinor} ${event.currency})${input.override ? `, eligibility override: ${input.override.reason}` : ""}`,
        after: { eventId: event.id, athleteId: r.athleteId, payerAccountId, invoiceId: invoice.id, ...priced[i] },
      });
    }
    created.push(...regs);
    live.push(...regs.map((r) => ({ athleteId: r.athleteId, payerAccountId, status: "held" as const })));
  }
  const fresh = await tx.select().from(eventRegistrations).where(inArray(eventRegistrations.id, created.map((r) => r.id)));
  return resultFor(tx, fresh, true);
}

async function resultFor(tx: Tx, regs: RegistrationRow[], created: boolean): Promise<RegisterResult> {
  const ids = [...new Set(regs.map((r) => r.invoiceId).filter((x): x is string => !!x))];
  const invs = ids.length ? await tx.select({ id: invoices.id, number: invoices.number, totalMinor: invoices.totalMinor, status: invoices.status }).from(invoices).where(inArray(invoices.id, ids)) : [];
  return { created, registrationIds: regs.map((r) => r.id), invoices: invs, holdExpiresAt: regs.find((r) => r.status === "held")?.holdExpiresAt ?? null };
}

// --- Staff cancellation ------------------------------------------------------------------------

export type CancelOutcome = "voided" | "reissued" | "open_with_payments" | "paid_refund_separately" | "none";

/**
 * Staff cancel a registration: the spot is released at once and the athlete is taken out of the
 * event's upcoming sessions. Money is NOT decided here. An unpaid invoice with no payments is
 * voided (or reissued for siblings who keep their spots). A paid or part-paid invoice is left
 * exactly as it is: any refund goes through the existing refund flow on the invoice page.
 */
export async function cancelEventRegistration(tx: Tx, v: Viewer, input: { registrationId: string; reason: string; now?: Date }): Promise<{ outcome: CancelOutcome; invoiceId: string | null }> {
  assertCan(v, "schedule.manage");
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (!reason) throw new UserError("A reason is required to cancel a registration.", { reason: "Required" });
  const [peek] = await tx.select().from(eventRegistrations).where(and(eq(eventRegistrations.id, input.registrationId), eq(eventRegistrations.orgId, v.orgId)));
  if (!peek) throw new UserError("Registration not found.");
  const event = await lockEvent(tx, v.orgId, peek.eventId);
  if (!event) throw new UserError("Registration not found.");
  const [reg] = await tx.select().from(eventRegistrations).where(eq(eventRegistrations.id, peek.id)).for("update");
  if (reg.status !== "held" && reg.status !== "confirmed") throw new UserError(`This registration is already ${reg.status}.`);

  let inv: typeof invoices.$inferSelect | undefined;
  if (reg.invoiceId) {
    [inv] = await tx.select().from(invoices).where(eq(invoices.id, reg.invoiceId)).for("update", { skipLocked: true });
    if (!inv) throw new UserError("A payment is being recorded on this registration's invoice right now. Please try again in a moment.");
  }

  await tx
    .update(eventRegistrations)
    .set({ status: "cancelled", releasedAt: now, cancelledBy: v.userId, cancelReason: reason, holdExpiresAt: null, updatedAt: now })
    .where(eq(eventRegistrations.id, reg.id));

  // Take the athlete out of sessions that have not started. Past attendance stays as recorded.
  const upcoming = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(and(eq(bookings.orgId, v.orgId), like(bookings.idempotencyKey, `event-reg:${reg.id}:%`), eq(bookings.status, "booked"), gt(scheduleSessions.startsAt, now)));
  if (upcoming.length) {
    await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: now, cancelledBy: v.userId, updatedAt: now })
      .where(inArray(bookings.id, upcoming.map((b) => b.id)));
  }

  let outcome: CancelOutcome = "none";
  if (inv) {
    if (inv.status === "paid") outcome = "paid_refund_separately";
    else if (inv.status === "open") {
      const money = await invoiceMoney(tx, inv.id);
      if (money.settledMinor > 0 || money.pendingMinor > 0) outcome = "open_with_payments";
      else outcome = await voidOrReissue(tx, actorOf(v), event, inv, `registration for ${event.name} cancelled: ${reason}`);
    }
  }
  await audit(tx, actorOf(v), "events.registration.cancel", "event_registration", reg.id, {
    summary: `Registration for ${event.name} cancelled (${reason}); spot released, ${upcoming.length} upcoming booking(s) removed, invoice: ${outcome.replaceAll("_", " ")}`,
    before: { status: reg.status },
    after: { status: "cancelled", outcome, invoiceId: inv?.id ?? null },
  });
  return { outcome, invoiceId: inv?.id ?? null };
}
