/**
 * Calendar provider abstraction. Teamwork is the source of truth for sessions;
 * providers only ever receive copies (push/update/delete) and report busy time back.
 */
export type CalendarEventInput = {
  /** Stable id from Teamwork so a retried push can be recognized (stored in extended properties). */
  teamworkSessionId: string;
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  timezone: string;
};

export type PushedEvent = { externalEventId: string; etag: string | null };

export type BusyInterval = { start: Date; end: Date };

export class CalendarProviderError extends Error {
  constructor(
    message: string,
    public status: number | null,
    /** True for 429/5xx/network errors: the job queue should retry with backoff. */
    public retryable: boolean,
  ) {
    super(message);
    this.name = "CalendarProviderError";
  }
}

/** The external event changed since our last push (etag mismatch, HTTP 412). */
export class CalendarConflictError extends CalendarProviderError {
  constructor(message = "The calendar event was modified outside Teamwork.") {
    super(message, 412, false);
    this.name = "CalendarConflictError";
  }
}

export interface CalendarProvider {
  readonly name: string;
  pushEvent(calendarId: string, e: CalendarEventInput): Promise<PushedEvent>;
  /** ifMatchEtag: when given, the update fails with CalendarConflictError if the event changed externally. */
  updateEvent(calendarId: string, externalEventId: string, e: CalendarEventInput, ifMatchEtag?: string | null): Promise<PushedEvent>;
  /** Deleting an already-deleted event is treated as success. */
  deleteEvent(calendarId: string, externalEventId: string): Promise<void>;
  freeBusy(calendarId: string, from: Date, to: Date): Promise<BusyInterval[]>;
}
