// All calendar-day math lives here. A "day" is the CLIENT's calendar day:
// the web app sends its UTC offset (minutes behind UTC, i.e. the value of
// Date#getTimezoneOffset — Chicago in summer = 300) in the `x-tz-offset`
// header, and every day boundary/label the server computes uses that offset.
// The server's own timezone (UTC on Render) must never leak into day math.
//
// Storage conventions:
//  - Instants (completedAt, createdAt, …) are stored as real timestamps.
//  - Pure dates (a wellness check-in's day, an assignment's session day) are
//    stored as UTC midnight of the day string, so they are offset-independent
//    and their day label is always isoDate(value) regardless of viewer.

import type { Request } from "express";

const DAY_MS = 864e5;

// Parse the client's offset header; clamp to real-world offsets (UTC-14..UTC+12
// expressed in getTimezoneOffset terms is -840..720). Missing/garbage → 0 (UTC).
export function tzOffsetFromReq(req: Request): number {
  const raw = Number(req.header("x-tz-offset"));
  if (!Number.isFinite(raw)) return 0;
  return Math.max(-840, Math.min(840, Math.round(raw)));
}

const DAY_STR = /^\d{4}-\d{2}-\d{2}$/;
export function isDayString(s: unknown): s is string {
  return typeof s === "string" && DAY_STR.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

// The yyyy-mm-dd day an instant falls on, in the client's local time.
export function dayOf(instant: Date, offsetMin: number): string {
  return new Date(instant.getTime() - offsetMin * 60000).toISOString().slice(0, 10);
}

// "Today" as the client sees it.
export function today(offsetMin: number, nowMs = Date.now()): string {
  return dayOf(new Date(nowMs), offsetMin);
}

// UTC instant of the client-local midnight that starts this day.
export function dayStartUtc(dayStr: string, offsetMin: number): Date {
  return new Date(Date.parse(dayStr + "T00:00:00Z") + offsetMin * 60000);
}

// [start, end) instants bounding a client-local day.
export function dayRangeUtc(dayStr: string, offsetMin: number): [Date, Date] {
  const start = dayStartUtc(dayStr, offsetMin);
  return [start, new Date(start.getTime() + DAY_MS)];
}

// Canonical stored value for a pure-date field: UTC midnight of the day string.
export function pureDate(dayStr: string): Date {
  return new Date(dayStr + "T00:00:00Z");
}

// Day-string arithmetic (pure calendar math — no timezone involved).
export function addDays(dayStr: string, n: number): string {
  return new Date(Date.parse(dayStr + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
}

// Monday of the week containing the given day (ISO week start).
export function mondayOf(dayStr: string): string {
  const dow = new Date(dayStr + "T00:00:00Z").getUTCDay(); // 0=Sun..6=Sat
  return addDays(dayStr, -((dow + 6) % 7));
}

// Short human label ("Jun 22") for a day string — no Date/timezone round-trip.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayLabel(dayStr: string): string {
  return `${MONTHS[Number(dayStr.slice(5, 7)) - 1]} ${Number(dayStr.slice(8, 10))}`;
}
