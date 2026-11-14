"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import type { EventKind, EventStatus } from "@/db/schema";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { requireViewer } from "@/lib/auth/viewer";
import { UserError as BillingUserError } from "@/lib/billing/errors";
import { addEventSession, createEvent, setEventStatus, updateEvent, type EventInput, type EventSessionInput } from "@/lib/events/events";
import { cancelEventRegistration, registerForEvent } from "@/lib/events/registration";
import { parseMoneyToMinor } from "@/lib/money";

async function run(paths: string[], fn: () => Promise<ActionState | void>): Promise<ActionState> {
  const res = await safeAction(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BillingUserError) throw new UserError(e.message, e.fieldErrors);
      throw e;
    }
  })();
  if (res.ok) for (const p of paths) revalidatePath(p, "layout");
  return res;
}

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const all = (fd: FormData, k: string) => fd.getAll(k).map((x) => String(x).trim());

function intOrNull(fd: FormData, k: string, label: string): number | null {
  const raw = s(fd, k);
  if (!raw) return null;
  if (!/^\d{1,6}$/.test(raw)) throw new UserError(`${label} must be a whole number.`, { [k]: "Whole number" });
  return Number(raw);
}

function moneyOrNull(fd: FormData, k: string, label: string): number | null {
  const raw = s(fd, k);
  if (!raw) return null;
  const minor = parseMoneyToMinor(raw);
  if (minor == null || minor < 0) throw new UserError(`${label} must be a dollar amount like 185 or 185.00.`, { [k]: "Invalid amount" });
  return minor;
}

function eventInput(fd: FormData): EventInput {
  const price = moneyOrNull(fd, "price", "Price");
  if (price == null) throw new UserError("Enter the price (0 for a free event).", { price: "Required" });
  const capacity = intOrNull(fd, "capacity", "Capacity");
  if (capacity == null) throw new UserError("Enter the capacity.", { capacity: "Required" });
  return {
    name: s(fd, "name"),
    description: s(fd, "description") || null,
    kind: s(fd, "kind") as EventKind,
    capacity,
    priceMinor: price,
    earlyBirdPriceMinor: moneyOrNull(fd, "earlyBirdPrice", "Early bird price"),
    earlyBirdUntil: s(fd, "earlyBirdUntil") || null,
    siblingDiscountPercent: intOrNull(fd, "siblingDiscountPercent", "Sibling discount"),
    registrationOpensOn: s(fd, "registrationOpensOn") || null,
    registrationClosesOn: s(fd, "registrationClosesOn") || null,
    minAge: intOrNull(fd, "minAge", "Minimum age"),
    maxAge: intOrNull(fd, "maxAge", "Maximum age"),
    requiredFormTemplateIds: all(fd, "requiredFormTemplateIds").filter(Boolean),
    holdHours: intOrNull(fd, "holdHours", "Unpaid hold"),
  };
}

function sessionRows(fd: FormData): EventSessionInput[] {
  const dates = all(fd, "sessionDate");
  const starts = all(fd, "sessionStart");
  const ends = all(fd, "sessionEnd");
  return dates.map((date, i) => ({ date, startTime: starts[i] ?? "", endTime: ends[i] ?? "" })).filter((r) => r.date || r.startTime || r.endTime);
}

// --- Staff ---------------------------------------------------------------------------------------

export async function createEventAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  let id: string | null = null;
  const res = await run(["/events", "/schedule"], async () => {
    const v = await requireViewer();
    const r = await db.transaction((tx) => createEvent(tx, v, { ...eventInput(fd), sessions: sessionRows(fd), coachUserId: s(fd, "coachUserId") || null, resourceId: s(fd, "resourceId") || null }));
    id = r.event.id;
  });
  if (res.ok && id) redirect(`/events/${id}?created=1`);
  return res;
}

export async function updateEventAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/events", "/shop", "/schedule"], async () => {
    const v = await requireViewer();
    await db.transaction((tx) => updateEvent(tx, v, s(fd, "eventId"), eventInput(fd)));
    return { ok: true, message: "Saved." };
  });
}

export async function addEventSessionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/events", "/shop", "/schedule"], async () => {
    const v = await requireViewer();
    const [session] = sessionRows(fd);
    if (!session) throw new UserError("Enter the date and times for the session.", { sessionDate: "Required" });
    await db.transaction((tx) => addEventSession(tx, v, { eventId: s(fd, "eventId"), session, coachUserId: s(fd, "coachUserId") || null, resourceId: s(fd, "resourceId") || null }));
    return { ok: true, message: "Session added. Confirmed athletes were booked into it." };
  });
}

export async function setEventStatusAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/events", "/shop", "/today"], async () => {
    const v = await requireViewer();
    const status = s(fd, "status") as EventStatus;
    await db.transaction((tx) => setEventStatus(tx, v, { eventId: s(fd, "eventId"), status }));
    return { ok: true, message: status === "published" ? "Published. Families can now see it and register." : status === "closed" ? "Registration closed. Existing registrations stand." : "Moved back to draft." };
  });
}

export async function cancelRegistrationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/events", "/shop", "/billing", "/schedule"], async () => {
    const v = await requireViewer();
    const r = await db.transaction((tx) => cancelEventRegistration(tx, v, { registrationId: s(fd, "registrationId"), reason: s(fd, "reason") }));
    const money =
      r.outcome === "voided"
        ? "The unpaid invoice was voided."
        : r.outcome === "reissued"
          ? "The unpaid invoice was voided and a new one was issued for the athletes still registered."
          : r.outcome === "paid_refund_separately"
            ? "The invoice is paid and was not changed. If a refund is due, issue it from the invoice page."
            : r.outcome === "open_with_payments"
              ? "The invoice has payments on it and was not changed. Refund or adjust it from the invoice page."
              : "";
    return { ok: true, message: `Registration cancelled and the spot released. ${money}`.trim() };
  });
}

export async function staffRegisterAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/events", "/shop", "/billing"], async () => {
    const v = await requireViewer();
    const athleteId = s(fd, "athleteId");
    if (!athleteId) throw new UserError("Choose an athlete.", { athleteId: "Required" });
    const reason = s(fd, "overrideReason");
    const r = await db.transaction((tx) => registerForEvent(tx, v, { eventId: s(fd, "eventId"), athleteIds: [athleteId], idempotencyKey: s(fd, "key"), override: reason ? { reason } : null }));
    const inv = r.invoices[0];
    return { ok: true, message: inv?.status === "paid" ? "Registered and confirmed (nothing to pay)." : `Spot held. Invoice ${inv?.number ?? ""} is open: record the payment on the invoice to confirm.` };
  });
}

// --- Families ------------------------------------------------------------------------------------

export async function registerForEventAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const eventId = s(fd, "eventId");
  let done = false;
  const res = await run(["/shop", "/billing", "/today", "/events"], async () => {
    const v = await requireViewer();
    const athleteIds = all(fd, "athleteIds").filter(Boolean);
    if (!athleteIds.length) throw new UserError("Choose who is coming.", { athleteIds: "Choose at least one athlete" });
    await db.transaction((tx) => registerForEvent(tx, v, { eventId, athleteIds, idempotencyKey: s(fd, "key") }));
    done = true;
  });
  if (res.ok && done) redirect(`/shop/camps/${eventId}?registered=1`);
  return res;
}
