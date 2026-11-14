import { fmt, localYmd } from "@/lib/time";
import type { EventRow } from "./confirm";

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
