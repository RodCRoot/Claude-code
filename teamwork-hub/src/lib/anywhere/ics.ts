import { and, desc, eq } from "drizzle-orm";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { Tx } from "@/db";
import { anywhereIcsImports, anywhereSeasonEvents, anywhereSeasons, type IcsStagedEvent, type SeasonEventKind } from "@/db/schema";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { addDaysYmd, DEFAULT_TZ, isoWeekday } from "@/lib/time";
import { actorOf, anywhereAccess, orgAnywhere } from "./common";

/**
 * Bounded .ics (iCalendar) reader for My Season uploads.
 *
 * It is a plain text scan: nothing in the file is fetched, followed, included or executed.
 * URL, ATTACH, ALARM, ORGANIZER, ATTENDEE, DESCRIPTION and every other property are ignored. Only
 * UID, SUMMARY, LOCATION, DTSTART, DTEND, DURATION, RRULE (weekly only), STATUS and RECURRENCE-ID
 * of VEVENT blocks are read, each cut to a fixed length. Hard limits below; anything over them is
 * rejected with a message the family can act on.
 */
export const ICS_MAX_BYTES = 256 * 1024;
export const ICS_MAX_LINES = 20_000;
export const ICS_MAX_EVENTS = 200;
const MAX_LINE = 2_000;
const MAX_TEXT = 120;

export class IcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IcsError";
  }
}

export type IcsParseResult = { events: IcsStagedEvent[]; warnings: string[]; skipped: number };

const DAY: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

/** Unescape iCalendar TEXT, drop control characters, collapse whitespace, cut to a safe length. */
export function cleanText(raw: string | undefined, max = MAX_TEXT): string | null {
  if (!raw) return null;
  const s = raw
    .replace(/\\n/gi, " ")
    .replace(/\\([,;\\])/g, "$1")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, max) : null;
}

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type When = { date: string; time: string | null; instant: Date | null };

/** DTSTART / DTEND / UNTIL value into a facility-local date and time. Null when unreadable. */
function parseWhen(value: string, params: Record<string, string>, tz: string, warn: (m: string) => void): When | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, , z] = m;
  const date = `${y}-${mo}-${d}`;
  const check = new Date(Date.UTC(+y, +mo - 1, +d));
  if (check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || +y < 2000 || +y > 2100) return null;
  if (hh === undefined) return { date, time: null, instant: null };
  if (+hh > 23 || +mi > 59) return null;
  const local = `${hh}:${mi}`;
  let instant: Date;
  if (z) instant = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi));
  else {
    let zone = tz;
    const tzid = params.TZID?.replace(/^"|"$/g, "");
    if (tzid) {
      if (validTz(tzid)) zone = tzid;
      else warn(`Time zone "${cleanText(tzid, 40)}" was not recognized, so those times were read as local gym time.`);
    }
    instant = fromZonedTime(`${date}T${local}:00`, zone);
  }
  if (Number.isNaN(instant.getTime())) return null;
  return { date: formatInTimeZone(instant, tz, "yyyy-MM-dd"), time: formatInTimeZone(instant, tz, "HH:mm"), instant };
}

function parseDuration(v: string): number | null {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const min = (+(m[1] ?? 0) * 7 + +(m[2] ?? 0)) * 1440 + +(m[3] ?? 0) * 60 + +(m[4] ?? 0);
  return min > 0 ? min : null;
}

/** A guess the family can change after import. Never uses anything but the event's own title. */
export function guessKind(summary: string | null): SeasonEventKind {
  const s = (summary ?? "").toLowerCase();
  if (/\btournament|tourney|invitational|showcase\b/.test(s)) return "tournament";
  if (/\bpractice|training|workout|walk-?through|film\b/.test(s)) return "practice";
  if (/\btravel|bus|flight|depart/.test(s)) return "travel";
  if (/\brest|off day|day off\b/.test(s)) return "rest";
  return "game";
}

function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Parse calendar text into events clipped to a season. Pure: no I/O of any kind.
 * Throws IcsError for input that is not a calendar or is over a limit.
 */
export function parseIcs(text: string, opts: { tz?: string; seasonStart: string; seasonEnd: string }): IcsParseResult {
  const tz = opts.tz ?? DEFAULT_TZ;
  if (text.length > ICS_MAX_BYTES) throw new IcsError("That file is too large. Calendar files can be up to 256 KB.");
  const body = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trimStart();
  if (!/^\s*BEGIN:VCALENDAR\s*$/im.test(body.slice(0, 200).split(/\r?\n/)[0] ?? "")) throw new IcsError("That does not look like a calendar file. Export an .ics file from your team's calendar and try again.");
  const rawLines = body.split(/\r\n|\n|\r/);
  if (rawLines.length > ICS_MAX_LINES) throw new IcsError("That calendar is too long to import. Export a shorter date range and try again.");
  const lines: string[] = [];
  for (const l of rawLines) {
    if ((l.startsWith(" ") || l.startsWith("\t")) && lines.length) {
      if (lines[lines.length - 1].length < MAX_LINE) lines[lines.length - 1] += l.slice(1);
    } else lines.push(l);
  }
  const warnings = new Set<string>();
  const warn = (m: string) => void warnings.add(m);
  const stack: string[] = [];
  let cur: Record<string, { value: string; params: Record<string, string> }> | null = null;
  const blocks: Record<string, { value: string; params: Record<string, string> }>[] = [];
  let sawEnd = false;
  for (const full of lines) {
    const line = full.length > MAX_LINE ? full.slice(0, MAX_LINE) : full;
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const head = line.slice(0, colon).split(";");
    const name = head[0].trim().toUpperCase();
    const value = line.slice(colon + 1);
    if (name === "BEGIN") {
      const what = value.trim().toUpperCase();
      stack.push(what);
      if (stack.length > 8) throw new IcsError("That calendar file is not laid out the way calendar files should be.");
      if (what === "VEVENT" && stack.length === 2) {
        if (blocks.length >= ICS_MAX_EVENTS) throw new IcsError(`That calendar has more than ${ICS_MAX_EVENTS} events. Export just this season and try again.`);
        cur = {};
      }
      continue;
    }
    if (name === "END") {
      const what = value.trim().toUpperCase();
      if (stack.pop() !== what) throw new IcsError("That calendar file is damaged (a section does not close properly).");
      if (what === "VEVENT" && cur && stack.length === 1) {
        blocks.push(cur);
        cur = null;
      }
      if (what === "VCALENDAR") sawEnd = true;
      continue;
    }
    // Only properties directly inside a VEVENT are read (alarms and time zone blocks are skipped).
    if (!cur || stack.length !== 2) continue;
    if (!["UID", "SUMMARY", "LOCATION", "DTSTART", "DTEND", "DURATION", "RRULE", "STATUS", "RECURRENCE-ID"].includes(name) || cur[name]) continue;
    const params: Record<string, string> = {};
    for (const p of head.slice(1, 6)) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().slice(0, 80);
    }
    cur[name] = { value: value.slice(0, MAX_LINE), params };
  }
  if (stack.length || !sawEnd) throw new IcsError("That calendar file looks cut off. Download it again and try once more.");

  const events: IcsStagedEvent[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const b of blocks) {
    if (b.STATUS?.value.trim().toUpperCase() === "CANCELLED" || b["RECURRENCE-ID"]) {
      skipped++;
      if (b["RECURRENCE-ID"]) warn("Changes to single days of a repeating event were skipped. Check those days after importing.");
      continue;
    }
    const start = b.DTSTART ? parseWhen(b.DTSTART.value, b.DTSTART.params, tz, warn) : null;
    if (!start) {
      skipped++;
      warn("Events with no readable start date were skipped.");
      continue;
    }
    const title = cleanText(b.SUMMARY?.value);
    let duration: number | null = null;
    if (start.instant) {
      const end = b.DTEND ? parseWhen(b.DTEND.value, b.DTEND.params, tz, warn) : null;
      if (end?.instant) duration = Math.round((end.instant.getTime() - start.instant.getTime()) / 60_000);
      else if (b.DURATION) duration = parseDuration(b.DURATION.value);
      if (duration !== null && (duration < 5 || duration > 720)) duration = null;
    }
    let weekdays: number[] | null = null;
    let endsOn = start.date;
    if (b.RRULE) {
      const parts = Object.fromEntries(b.RRULE.value.split(";").slice(0, 12).map((kv) => kv.split("=").map((x) => x.trim().toUpperCase())).filter((kv) => kv.length === 2)) as Record<string, string>;
      if (parts.FREQ === "WEEKLY" && (!parts.INTERVAL || parts.INTERVAL === "1")) {
        const days = (parts.BYDAY ?? "").split(",").map((d) => DAY[d.replace(/^[+-]?\d+/, "")]).filter(Boolean);
        weekdays = [...new Set(days.length ? days : [isoWeekday(start.date)])].sort();
        endsOn = opts.seasonEnd;
        if (parts.UNTIL) {
          const until = parseWhen(parts.UNTIL, {}, tz, warn);
          if (until && until.date < endsOn) endsOn = until.date;
        } else if (parts.COUNT && /^\d{1,4}$/.test(parts.COUNT)) {
          let left = Number(parts.COUNT);
          let d = start.date;
          let last = start.date;
          for (let i = 0; i < 800 && left > 0; i++, d = addDaysYmd(d, 1)) {
            if (weekdays.includes(isoWeekday(d))) {
              left--;
              last = d;
            }
          }
          if (last < endsOn) endsOn = last;
        }
      } else warn("Some events repeat in a way that is not supported (only weekly). Their first day was imported.");
    }
    // Clip to the season.
    let startsOn = start.date;
    if (weekdays) {
      if (startsOn < opts.seasonStart) startsOn = opts.seasonStart;
      if (endsOn > opts.seasonEnd) endsOn = opts.seasonEnd;
    }
    if (startsOn > endsOn || startsOn < opts.seasonStart || endsOn > opts.seasonEnd) {
      skipped++;
      warn("Events outside the season dates were skipped.");
      continue;
    }
    const rawUid = cleanText(b.UID?.value, 200);
    const uid = rawUid ?? `no-uid-${hashKey(`${start.date}|${start.time ?? ""}|${title ?? ""}`)}`;
    if (seen.has(uid)) {
      skipped++;
      continue;
    }
    seen.add(uid);
    events.push({ uid, kind: guessKind(title), title, location: cleanText(b.LOCATION?.value), weekdays, startsOn, endsOn, startTimeLocal: start.time, durationMinutes: duration });
  }
  events.sort((a, b) => a.startsOn.localeCompare(b.startsOn) || (a.startTimeLocal ?? "").localeCompare(b.startTimeLocal ?? ""));
  return { events, warnings: [...warnings], skipped };
}

// ---------------------------------------------------------------------------
// Stage → preview → import
// ---------------------------------------------------------------------------

async function editableSeason(tx: Tx, v: Viewer, seasonId: string) {
  const [s] = await tx.select().from(anywhereSeasons).where(and(eq(anywhereSeasons.id, seasonId), eq(anywhereSeasons.orgId, v.orgId)));
  if (!s) throw new AuthzError("Season not found.");
  const access = await anywhereAccess(tx, v, s.athleteId);
  if (!access?.canEditSeason) throw new AuthzError();
  return s;
}

/** Parse an uploaded file and hold it for preview. Nothing is added to the season yet. */
export async function stageIcs(tx: Tx, v: Viewer, seasonId: string, fileName: string, bytes: Uint8Array) {
  const season = await editableSeason(tx, v, seasonId);
  if (bytes.byteLength === 0) throw new UserError("Choose a calendar file (.ics) to upload.");
  if (bytes.byteLength > ICS_MAX_BYTES) throw new UserError("That file is too large. Calendar files can be up to 256 KB.");
  if (!/\.ics$/i.test(fileName)) throw new UserError("Upload a calendar file that ends in .ics.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UserError("That file could not be read as text. Export the calendar again as .ics.");
  }
  const { tz } = await orgAnywhere(tx, v.orgId);
  let parsed: IcsParseResult;
  try {
    parsed = parseIcs(text, { tz, seasonStart: season.startsOn, seasonEnd: season.endsOn });
  } catch (e) {
    if (e instanceof IcsError) throw new UserError(e.message);
    throw e;
  }
  if (!parsed.events.length) throw new UserError(`No events inside the season dates (${season.startsOn} to ${season.endsOn}) were found in that file.`);
  await tx.update(anywhereIcsImports).set({ status: "discarded" }).where(and(eq(anywhereIcsImports.seasonId, season.id), eq(anywhereIcsImports.status, "staged")));
  const [row] = await tx
    .insert(anywhereIcsImports)
    .values({ orgId: v.orgId, seasonId: season.id, uploadedBy: v.userId, fileName: (cleanText(fileName, 80) ?? "calendar.ics").replace(/[^\w .-]/g, "_"), events: parsed.events, warnings: parsed.warnings.slice(0, 10) })
    .returning();
  await audit(tx, actorOf(v), "anywhere.season.ics_stage", "anywhere_ics_import", row.id, { summary: `Staged ${parsed.events.length} calendar events for ${season.teamName} (${parsed.skipped} skipped)` });
  return row;
}

export async function stagedImport(tx: Tx, v: Viewer, seasonId: string) {
  await editableSeason(tx, v, seasonId);
  const [row] = await tx.select().from(anywhereIcsImports).where(and(eq(anywhereIcsImports.seasonId, seasonId), eq(anywhereIcsImports.orgId, v.orgId), eq(anywhereIcsImports.status, "staged"))).orderBy(desc(anywhereIcsImports.createdAt)).limit(1);
  return row ?? null;
}

async function stagedById(tx: Tx, v: Viewer, importId: string) {
  const [row] = await tx.select().from(anywhereIcsImports).where(and(eq(anywhereIcsImports.id, importId), eq(anywhereIcsImports.orgId, v.orgId))).for("update");
  if (!row) throw new AuthzError("Import not found.");
  const season = await editableSeason(tx, v, row.seasonId);
  return { row, season };
}

/** Add the previewed events. Idempotent by UID: importing the same file again updates, never duplicates. */
export async function importStaged(tx: Tx, v: Viewer, importId: string): Promise<{ added: number; updated: number; athleteId: string }> {
  const { row, season } = await stagedById(tx, v, importId);
  if (row.status !== "staged") throw new UserError("That upload was already handled. Upload the file again to re-import.");
  const { tz } = await orgAnywhere(tx, v.orgId);
  const existing = new Map((await tx.select({ id: anywhereSeasonEvents.id, uid: anywhereSeasonEvents.icsUid }).from(anywhereSeasonEvents).where(eq(anywhereSeasonEvents.seasonId, season.id))).filter((e) => e.uid).map((e) => [e.uid!, e.id]));
  let added = 0;
  let updated = 0;
  for (const e of row.events.slice(0, ICS_MAX_EVENTS)) {
    const values = { kind: e.kind, title: e.title, location: e.location, weekdays: e.weekdays, startsOn: e.startsOn, endsOn: e.endsOn, startTimeLocal: e.startTimeLocal, durationMinutes: e.durationMinutes, timezone: tz };
    const id = existing.get(e.uid);
    if (id) {
      await tx.update(anywhereSeasonEvents).set(values).where(eq(anywhereSeasonEvents.id, id));
      updated++;
    } else {
      await tx.insert(anywhereSeasonEvents).values({ orgId: v.orgId, seasonId: season.id, athleteId: season.athleteId, ...values, icsUid: e.uid, createdBy: v.userId, isDemo: season.isDemo });
      added++;
    }
  }
  await tx.update(anywhereIcsImports).set({ status: "imported" }).where(eq(anywhereIcsImports.id, row.id));
  await audit(tx, actorOf(v), "anywhere.season.ics_import", "anywhere_ics_import", row.id, { summary: `Imported calendar for ${season.teamName}: ${added} added, ${updated} updated` });
  return { added, updated, athleteId: season.athleteId };
}

export async function discardStaged(tx: Tx, v: Viewer, importId: string) {
  const { row, season } = await stagedById(tx, v, importId);
  if (row.status === "staged") await tx.update(anywhereIcsImports).set({ status: "discarded" }).where(eq(anywhereIcsImports.id, row.id));
  return season;
}
