"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { formToObject, safeAction, UserError, type ActionState } from "@/lib/actions";
import { requireViewer } from "@/lib/auth/viewer";
import {
  addAvailability,
  addTimeOff,
  availabilitySchema,
  policySchema,
  removeAvailability,
  removeBusyBlock,
  resourceSchema,
  saveSeries,
  saveServiceType,
  savePolicy,
  saveResource,
  seriesSchema,
  serviceTypeSchema,
  timeOffSchema,
} from "@/lib/scheduling/admin";
import { bookPrivateSlot } from "@/lib/scheduling/availability";
import { bookSession, cancelBooking, markAttendance, promoteWaitlist, rescheduleBooking, restoreBookingCredit } from "@/lib/scheduling/booking";
import { cancelSession, createSession, generateSeriesSessions, substituteCoach, updateSession } from "@/lib/scheduling/sessions";
import { fmt, localToUtc } from "@/lib/time";
import { canRunSession, getSession, orgTimezone } from "@/lib/scheduling/common";
import { cancelSeriesFrom, editSeriesSessions } from "@/lib/scheduling/series-edit";
import { bookBatch, nextSeriesSessions } from "@/lib/scheduling/batch-booking";
import { setCheckInPin } from "@/lib/scheduling/kiosk-pin";

const run = (fn: () => Promise<ActionState | void>) => safeAction(fn)();
const refresh = () => revalidatePath("/schedule", "layout");
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const uuid = z.string().uuid();
const reqId = (fd: FormData, k: string) => {
  const r = uuid.safeParse(str(fd, k));
  if (!r.success) throw new UserError("Missing or invalid reference. Reload the page and try again.");
  return r.data;
};
const checked = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";

// --- Booking ----------------------------------------------------------------------------

export async function bookAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const comp = checked(fd, "comp") ? { reason: str(fd, "compReason") } : null;
    const override = checked(fd, "override") ? { reason: str(fd, "overrideReason") } : null;
    const r = await db.transaction((tx) =>
      bookSession(tx, v, { sessionId: reqId(fd, "sessionId"), athleteId: reqId(fd, "athleteId"), idempotencyKey: str(fd, "idem") || null, comp, override }),
    );
    refresh();
    return { ok: true, message: r.status === "booked" ? "Booked." : `Added to the waitlist (#${r.booking.waitlistPosition}).` };
  });
}

export async function cancelBookingAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const mode = (["auto", "late", "waive"].includes(str(fd, "mode")) ? str(fd, "mode") : "auto") as "auto" | "late" | "waive";
    const r = await db.transaction((tx) => cancelBooking(tx, v, { bookingId: reqId(fd, "bookingId"), mode, reason: str(fd, "reason") || undefined }));
    refresh();
    const credit = r.creditOutcome === "release" ? " The credit was returned." : r.creditOutcome === "forfeit" ? " Per the cancellation policy the credit was used." : "";
    const fee = r.penalty === "fee" ? " A cancellation fee was flagged for billing." : "";
    const promo = r.promoted.length ? ` ${r.promoted.length} athlete(s) promoted from the waitlist.` : "";
    return { ok: true, message: `${r.late ? "Late cancellation recorded." : "Cancelled."}${credit}${fee}${promo}` };
  });
}

export async function attendanceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const outcome = str(fd, "outcome") === "no_show" ? "no_show" : "attended";
    const r = await db.transaction((tx) => markAttendance(tx, v, { bookingId: reqId(fd, "bookingId"), outcome, method: "staff" }));
    refresh();
    const delta = "creditDelta" in r ? r.creditDelta : null;
    const credit = delta == null ? "" : delta < 0 ? " Corrected: the session credit was charged." : delta > 0 ? " Corrected: the session credit was returned." : " Corrected (credits unchanged).";
    return { ok: true, message: `${outcome === "attended" ? "Checked in." : "Marked no-show."}${credit}` };
  });
}

export async function restoreCreditAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) => restoreBookingCredit(tx, v, { bookingId: reqId(fd, "bookingId"), reason: str(fd, "reason") }));
    refresh();
    return { ok: true, message: "Credit restored." };
  });
}

export async function promoteWaitlistAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const sessionId = reqId(fd, "sessionId");
    const r = await db.transaction(async (tx) => {
      const s = await getSession(tx, v.orgId, sessionId);
      if (!canRunSession(v, s)) throw new UserError("Only schedule managers or this session's coach can promote the waitlist.");
      return promoteWaitlist(tx, v, sessionId);
    });
    refresh();
    if (!r.promoted.length && !r.skipped.length) return { ok: true, message: "No open spots to fill." };
    return {
      ok: true,
      message: `${r.promoted.length} promoted.${r.skipped.length ? ` ${r.skipped.length} skipped: ${r.skipped.map((s) => s.reason).join("; ")}` : ""}`,
    };
  });
}

export async function rescheduleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) =>
      rescheduleBooking(tx, v, { bookingId: reqId(fd, "bookingId"), toSessionId: reqId(fd, "toSessionId"), idempotencyKey: str(fd, "idem") || null }),
    );
    refresh();
    return { ok: true, message: "Rescheduled." };
  });
}

export async function bookSlotAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const startsAt = new Date(str(fd, "startsAt"));
    if (Number.isNaN(startsAt.getTime())) throw new UserError("Invalid time. Reload and pick a slot again.");
    const comp = checked(fd, "comp") ? { reason: str(fd, "compReason") } : null;
    await db.transaction((tx) =>
      bookPrivateSlot(tx, v, {
        serviceTypeId: reqId(fd, "serviceTypeId"),
        coachUserId: reqId(fd, "coachUserId"),
        athleteId: reqId(fd, "athleteId"),
        resourceId: str(fd, "resourceId") ? reqId(fd, "resourceId") : null,
        startsAt,
        idempotencyKey: str(fd, "idem") || null,
        comp,
      }),
    );
    refresh();
    return { ok: true, message: "Booked. You'll find it under upcoming bookings." };
  });
}

// --- Session management -------------------------------------------------------------------

export async function substituteCoachAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) => substituteCoach(tx, v, { sessionId: reqId(fd, "sessionId"), coachUserId: reqId(fd, "coachUserId"), reason: str(fd, "reason") || undefined }));
    refresh();
    return { ok: true, message: "Coach substituted." };
  });
}

export async function cancelSessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const r = await db.transaction((tx) => cancelSession(tx, v, { sessionId: reqId(fd, "sessionId"), reason: str(fd, "reason") }));
    refresh();
    return { ok: true, message: `Session cancelled. ${r.released} booking(s) released; families will be notified when messaging is enabled.` };
  });
}

export async function updateSessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const p = z
      .object({
        capacity: z.coerce.number().int().min(0).max(500),
        waitlistCapacity: z.coerce.number().int().min(0).max(200),
        version: z.coerce.number().int(),
        notes: z.string().max(2000).optional(),
        visibility: z.enum(["public", "members", "private"]),
      })
      .parse(formToObject(fd));
    await db.transaction((tx) => updateSession(tx, v, { sessionId: reqId(fd, "sessionId"), ...p, notes: p.notes?.trim() || null }));
    refresh();
    return { ok: true, message: "Session updated." };
  });
}

export async function createSessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const p = z
      .object({
        serviceTypeId: z.string().uuid("Choose a service"),
        title: z.string().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
        time: z.string().regex(/^\d{2}:\d{2}$/, "Pick a time"),
        durationMinutes: z.coerce.number().int().min(5).max(24 * 60),
        coachUserId: z.preprocess((x) => (x === "" ? null : x), z.string().uuid().nullable()),
        resourceId: z.preprocess((x) => (x === "" ? null : x), z.string().uuid().nullable()),
        capacity: z.coerce.number().int().min(0).max(500),
        waitlistCapacity: z.coerce.number().int().min(0).max(200),
        visibility: z.enum(["public", "members", "private"]),
      })
      .parse(formToObject(fd));
    const s = await db.transaction(async (tx) => {
      const tz = await orgTimezone(tx, v.orgId);
      return createSession(tx, v, { ...p, startsAt: localToUtc(p.date, p.time, tz) });
    });
    refresh();
    return { ok: true, message: "Session created.", data: { id: s.id } };
  });
}

// --- Series edits ----------------------------------------------------------------------------

export async function seriesEditAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const scope = z.enum(["this", "following", "all"]).parse(str(fd, "scope") || "this");
    const mode = z.enum(["refuse", "skip_conflicting", "keep_bookings_over_capacity"]).parse(str(fd, "onCapacityConflict") || "refuse");
    const optInt = (k: string, min: number, max: number) => {
      const raw = str(fd, k);
      if (!raw) return undefined;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`Check the ${k === "durationMinutes" ? "duration" : k === "waitlistCapacity" ? "waitlist size" : k}.`, { [k]: `${min}–${max}` });
      return n;
    };
    const optRef = (k: string) => {
      const raw = str(fd, k);
      if (raw === "" || raw === "keep") return undefined;
      if (raw === "none") return null;
      return reqId(fd, k);
    };
    const changes = {
      startTimeLocal: str(fd, "startTimeLocal") || undefined,
      durationMinutes: optInt("durationMinutes", 5, 24 * 60),
      coachUserId: optRef("coachUserId"),
      resourceId: optRef("resourceId"),
      capacity: optInt("capacity", 0, 500),
      waitlistCapacity: optInt("waitlistCapacity", 0, 200),
    };
    const r = await db.transaction((tx) =>
      editSeriesSessions(tx, v, { sessionId: reqId(fd, "sessionId"), version: Number(str(fd, "version")), scope, changes, onCapacityConflict: mode }),
    );
    if (!r.applied) {
      const tz = await orgTimezone(db, v.orgId);
      return {
        ok: false,
        error: `${r.conflicts.length} session(s) already hold more athletes than the new size. Nothing was changed — choose how to handle them below.`,
        data: {
          conflicts: r.conflicts.map((c) => ({
            id: c.sessionId,
            when: fmt(c.startsAt, "EEE MMM d h:mm a", tz),
            title: c.title,
            occupying: c.occupying,
            waitlisted: c.waitlisted,
            newCapacity: c.newCapacity,
            newWaitlistCapacity: c.newWaitlistCapacity,
          })),
        },
      };
    }
    refresh();
    const kept = r.keptCapacity.length ? ` ${r.keptCapacity.length} over-full session(s) kept their current size.` : "";
    return {
      ok: true,
      message: `${r.updated} session(s) updated${r.notified ? `; ${r.notified} change notice(s) queued for families` : ""}.${kept} Bookings were kept.`,
      data: { sessionId: str(fd, "sessionId") },
    };
  });
}

export async function cancelSeriesFromAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const r = await db.transaction((tx) => cancelSeriesFrom(tx, v, { seriesId: reqId(fd, "seriesId"), fromYmd: str(fd, "fromYmd"), reason: str(fd, "reason") }));
    refresh();
    return { ok: true, message: `${r.cancelled} session(s) cancelled and ${r.released} booking(s) released (credits returned). Families are notified per session; the series now ends before that date.` };
  });
}

// --- Family multi-booking -------------------------------------------------------------------

export async function batchBookAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const athleteIds = fd.getAll("athleteId").map((x) => uuid.safeParse(x));
    if (!athleteIds.length) throw new UserError("Choose at least one athlete.", { athleteId: "Required" });
    if (athleteIds.some((x) => !x.success)) throw new UserError("Missing or invalid reference. Reload the page and try again.");
    const weeks = Number(str(fd, "weeks") || "1");
    const mode = str(fd, "mode") === "partial" ? "partial" : "all_or_nothing";
    const sessionId = reqId(fd, "sessionId");
    const r = await db.transaction(async (tx) => {
      const sessions = await nextSeriesSessions(tx, v, { sessionId, weeks });
      const items = sessions.flatMap((s) => athleteIds.map((a) => ({ sessionId: s.id, athleteId: a.data! })));
      return bookBatch(tx, v, { items, mode, idempotencyKey: str(fd, "idem"), allowWaitlist: checked(fd, "waitlist") });
    });
    if (r.committed) refresh();
    const tz = await orgTimezone(db, v.orgId);
    const results = r.results.map((x) => ({
      athlete: x.athleteLabel,
      session: x.sessionTitle,
      when: x.startsAt ? fmt(x.startsAt, "EEE MMM d h:mm a", tz) : "",
      outcome: x.outcome,
      waitlistPosition: x.waitlistPosition,
      error: x.error,
    }));
    const summary = !r.committed
      ? `Nothing was booked: ${r.failed} of ${r.results.length} couldn't be booked, and you chose all-or-nothing.`
      : `${r.booked} booked${r.waitlisted ? `, ${r.waitlisted} waitlisted` : ""}${r.failed ? `, ${r.failed} not booked` : ""}.`;
    return r.committed && r.failed === 0 ? { ok: true, message: summary, data: { results } } : { ok: false, error: summary, data: { results, committed: r.committed } };
  });
}

// --- Kiosk check-in PIN ---------------------------------------------------------------------

export async function setCheckInPinAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const clear = str(fd, "intent") === "clear";
    const r = await db.transaction((tx) => setCheckInPin(tx, v, { athleteId: reqId(fd, "athleteId"), pin: clear ? null : str(fd, "pin") }));
    refresh();
    return { ok: true, message: r.set ? "PIN saved. Use it at the front-desk kiosk to check in." : "PIN removed." };
  });
}

// --- Settings ----------------------------------------------------------------------------

export async function saveResourceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const input = resourceSchema.parse(formToObject(fd));
    await db.transaction((tx) => saveResource(tx, v, input));
    refresh();
    return { ok: true, message: "Resource saved." };
  });
}

export async function savePolicyAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const raw = formToObject(fd);
    const fee = String(raw.feeDollars ?? "").trim();
    const feeMinor = fee === "" ? 0 : Math.round(Number(fee) * 100);
    if (!Number.isFinite(feeMinor) || feeMinor < 0) throw new UserError("Enter a fee like 15.00", { feeDollars: "Invalid amount" });
    const hours = Number(String(raw.lateCancelWindowHours ?? ""));
    if (!Number.isFinite(hours) || hours < 0) throw new UserError("Enter the late-cancel window in hours.", { lateCancelWindowHours: "Invalid" });
    const input = policySchema.parse({ ...raw, feeMinor, lateCancelWindowMinutes: Math.round(hours * 60) });
    await db.transaction((tx) => savePolicy(tx, v, input));
    refresh();
    return { ok: true, message: "Policy saved." };
  });
}

export async function saveServiceTypeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const input = serviceTypeSchema.parse(formToObject(fd));
    await db.transaction((tx) => saveServiceType(tx, v, input));
    refresh();
    return { ok: true, message: "Service saved. Changes apply to sessions created from now on." };
  });
}

export async function saveSeriesAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const input = seriesSchema.parse(formToObject(fd));
    await db.transaction((tx) => saveSeries(tx, v, input));
    refresh();
    return { ok: true, message: "Series saved. Use “Generate sessions” to add dates to the calendar." };
  });
}

export async function generateSeriesAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const weeks = Number(str(fd, "weeks"));
    const r = await db.transaction((tx) => generateSeriesSessions(tx, v, { seriesId: reqId(fd, "seriesId"), weeks }));
    refresh();
    return { ok: true, message: `${r.created} session(s) created${r.skipped ? `, ${r.skipped} already existed` : ""}.` };
  });
}

export async function addAvailabilityAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const input = availabilitySchema.parse(formToObject(fd));
    await db.transaction((tx) => addAvailability(tx, v, input));
    refresh();
    return { ok: true, message: "Availability added." };
  });
}

export async function removeAvailabilityAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) => removeAvailability(tx, v, reqId(fd, "id")));
    refresh();
    return { ok: true, message: "Removed." };
  });
}

export async function addTimeOffAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const input = timeOffSchema.parse(formToObject(fd));
    await db.transaction((tx) => addTimeOff(tx, v, input));
    refresh();
    return { ok: true, message: "Time off added." };
  });
}

export async function removeBusyBlockAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) => removeBusyBlock(tx, v, reqId(fd, "id")));
    refresh();
    return { ok: true, message: "Removed." };
  });
}
