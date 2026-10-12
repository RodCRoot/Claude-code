/**
 * Scheduling module public API. Other modules should import from "@/lib/scheduling".
 * All mutations take (tx, viewer, input) and must run inside db.transaction().
 */
export { bookSession, cancelBooking, markAttendance, promoteWaitlist, rescheduleBooking, restoreBookingCredit, upcomingBookingsFor } from "./booking";
export type { BookInput, BookResult, CancelInput, CancelResult, CancelMode, AttendanceOutcome } from "./booking";
export { checkEligibility, resolveEntitlement, requiresEntitlement, ageOn } from "./eligibility";
export type { Entitlement, EligibilityResult } from "./eligibility";
export { seriesOccurrences, generateSeriesSessions, createSession, substituteCoach, cancelSession, updateSession } from "./sessions";
export { findAvailableSlots, bookPrivateSlot, listCoaches } from "./availability";
export { attendanceHistory, MILESTONES, listSessions, sessionDetail } from "./queries";
export type { AttendanceHistory } from "./queries";
export { kioskRoster, kioskCheckIn, kioskName } from "./kiosk";
export type { KioskSession, KioskAthlete } from "./kiosk";
export { ScheduleConflictError, OCCUPYING } from "./common";
