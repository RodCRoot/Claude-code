import {
  CalendarConflictError,
  CalendarProviderError,
  type BusyInterval,
  type CalendarEventInput,
  type CalendarProvider,
  type PushedEvent,
} from "./types";
import { missingCalendarEnv } from "./oauth";

/**
 * Google Calendar API v3 adapter (official REST endpoints):
 *   POST   /calendars/{calendarId}/events
 *   PUT    /calendars/{calendarId}/events/{eventId}       (If-Match: etag for conflict detection)
 *   DELETE /calendars/{calendarId}/events/{eventId}
 *   POST   /freeBusy
 *   POST   /calendars                 (create the Teamwork-owned secondary calendar)
 *   GET    /calendars/{calendarId}
 * Auth is an OAuth 2.0 bearer token supplied by `getAccessToken` (src/lib/calendar/tokens.ts
 * decrypts / refreshes it). `fetchImpl` is injectable so tests never touch the network.
 */
export const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export type GoogleProviderOptions = {
  getAccessToken: () => Promise<string>;
  /** Called on HTTP 401 so the cached access token is discarded before the retry. */
  onUnauthorized?: () => Promise<void>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
};

/** Live sync needs the OAuth client AND a valid token-encryption key (see oauth.ts). */
export function googleConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return missingCalendarEnv(env).length === 0;
}

export function toGoogleEvent(e: CalendarEventInput) {
  return {
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: { dateTime: e.start.toISOString(), timeZone: e.timezone },
    end: { dateTime: e.end.toISOString(), timeZone: e.timezone },
    // Lets us find our own copy again and tells humans where to edit.
    extendedProperties: { private: { teamworkSessionId: e.teamworkSessionId, source: "teamwork-hub" } },
  };
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = "google";
  private fetchImpl: typeof fetch;
  private base: string;
  constructor(private opts: GoogleProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = opts.baseUrl ?? GOOGLE_CALENDAR_API;
  }

  private async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const token = await this.opts.getAccessToken();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new CalendarProviderError(`Network error calling Google Calendar: ${(e as Error).message}`, null, true);
    }
    if (res.status === 412) throw new CalendarConflictError();
    if (res.status === 401) {
      // Access token rejected (expired early or revoked): drop the cached one; the retry refreshes it,
      // and a revoked grant then surfaces as a clear "reconnect" error on the connection.
      await this.opts.onUnauthorized?.();
      throw new CalendarProviderError(`Google Calendar ${method} rejected the access token (401).`, 401, true);
    }
    if (!res.ok && !(method === "DELETE" && (res.status === 404 || res.status === 410))) {
      const text = await res.text().catch(() => "");
      throw new CalendarProviderError(`Google Calendar ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`, res.status, res.status === 429 || res.status >= 500);
    }
    if (res.status === 204 || method === "DELETE") return null;
    return (await res.json()) as Record<string, unknown>;
  }

  async pushEvent(calendarId: string, e: CalendarEventInput): Promise<PushedEvent> {
    const json = await this.request("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, toGoogleEvent(e));
    return { externalEventId: String(json?.id), etag: (json?.etag as string) ?? null };
  }

  async updateEvent(calendarId: string, eventId: string, e: CalendarEventInput, ifMatchEtag?: string | null): Promise<PushedEvent> {
    const json = await this.request(
      "PUT",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      toGoogleEvent(e),
      ifMatchEtag ? { "If-Match": ifMatchEtag } : {},
    );
    return { externalEventId: String(json?.id ?? eventId), etag: (json?.etag as string) ?? null };
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.request("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  }

  /** Create the dedicated calendar Teamwork writes to (scope calendar.app.created). Returns its id. */
  async createCalendar(summary: string, timeZone: string): Promise<string> {
    const json = await this.request("POST", `/calendars`, { summary, timeZone, description: "Sessions managed by Teamwork Hub. Edit them in Teamwork; changes made here are overwritten." });
    if (!json?.id) throw new CalendarProviderError("Google did not return an id for the new calendar.", 200, false);
    return String(json.id);
  }

  /** True if the calendar still exists and is accessible with this token. */
  async calendarExists(calendarId: string): Promise<boolean> {
    try {
      await this.request("GET", `/calendars/${encodeURIComponent(calendarId)}`);
      return true;
    } catch (e) {
      if (e instanceof CalendarProviderError && (e.status === 404 || e.status === 410)) return false;
      throw e;
    }
  }

  async freeBusy(calendarId: string, from: Date, to: Date): Promise<BusyInterval[]> {
    const json = await this.request("POST", `/freeBusy`, { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calendarId }] });
    const cal = (json?.calendars as Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> | undefined)?.[calendarId];
    if (cal?.errors?.length) throw new CalendarProviderError(`Google free/busy error for calendar: ${JSON.stringify(cal.errors).slice(0, 200)}`, 200, false);
    return (cal?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }
}
