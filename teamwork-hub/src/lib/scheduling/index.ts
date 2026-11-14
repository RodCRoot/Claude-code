/**
 * Scheduling module public API. Other modules should import from "@/lib/scheduling".
 * All mutations take (tx, viewer, input) and must run inside db.transaction().
 */
export { bookSession, cancelBooking, markAttendance, promoteWaitlist, rescheduleBooking, restoreBookingCredit, upcomingBookingsFor } from "./booking";
export type { BookInput, BookResult, CancelInput, CancelResult, CancelMode, AttendanceOutcome } from "./booking";
export { checkEligibility, resolveEntitlement, requiresEntitlement, ageOn, locationBlockMessage } from "./eligibility";
export type { Entitlement, EligibilityResult, LocationBlock } from "./eligibility";
export { seriesOccurrences, generateSeriesSessions, createSession, substituteCoach, cancelSession, updateSession } from "./sessions";
export { findAvailableSlots, bookPrivateSlot, listCoaches } from "./availability";
export { attendanceHistory, MILESTONES, listSessions, sessionDetail } from "./queries";
export type { AttendanceHistory } from "./queries";
export { kioskRoster, kioskCheckIn, kioskName } from "./kiosk";
export type { KioskSession, KioskAthlete } from "./kiosk";
export { ScheduleConflictError, OCCUPYING, kioskPinOnly } from "./common";
export { editSeriesSessions, cancelSeriesFrom } from "./series-edit";
export type { SeriesEditScope, SeriesEditChanges, SeriesEditResult, CapacityConflict, CapacityConflictMode } from "./series-edit";
export { bookBatch, nextSeriesSessions, MAX_BATCH_ITEMS, MAX_SERIES_WEEKS } from "./batch-booking";
export type { BatchItem, BatchItemResult, BatchMode, BatchResult } from "./batch-booking";
export { setCheckInPin, hasCheckInPin, kioskPinCheckIn, isTrivialPin, KIOSK_PIN_MAX_FAILED, KIOSK_PIN_LOCK_MINUTES } from "./kiosk-pin";
export type { KioskPinResult, KioskPinSession } from "./kiosk-pin";
