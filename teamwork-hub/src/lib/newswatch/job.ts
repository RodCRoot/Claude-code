/**
 * News watch nightly job: read the enabled feeds, match headlines to watched names, and put the
 * matches in the leads list as suggested clips. It approves nothing and shows nothing.
 *
 * Polite by construction:
 *  - nothing is read while News watch is off or nobody is on the watch list;
 *  - a source is never read more often than its minimum interval;
 *  - one daily cap on requests for the whole organization (all sources together);
 *  - a failing source is backed off (30 minutes, doubling, at most 24 hours) and never stops the
 *    others: the job result names it and the rest carry on;
 *  - only feeds are requested, with a timeout and a size limit, identified as a feed reader.
 *
 * Publisher feeds: one request per source. News search sources: one request per watched person,
 * shared by every search source that uses the same search address (their sites are OR'd into the
 * one query), so adding a paper does not multiply the requests. When the daily cap stops a search
 * part-way, a different person goes first the next day.
 *
 * Idempotent: running it twice makes no second clip (see `ingestItems`).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { newsFetchDays, newsSources } from "@/db/schema";
import { log } from "@/lib/observability";
import { todayLocal } from "@/lib/time";
import { ingestItems } from "./clips";
import { domainOf, FeedError, httpFeedFetcher, NEWS_ADAPTERS, statusProblem, type FeedFetcher, type ParsedItem } from "./feed";
import { newsOrg, type NewsSource } from "./settings";
import { loadWatched, personKey } from "./watch";
import type { WatchedPerson } from "./shared";

export type NewsJobResult =
  | { skipped: string }
  | {
      date: string;
      watched: number;
      sourcesFetched: number;
      sourcesSkipped: number;
      requests: number;
      itemsSeen: number;
      newClips: number;
      capReached: boolean;
      /** Sources that failed this run (the queue's "partial" marker). */
      failed: number;
      errors: { id: string; error: string }[];
    };

type RunOpts = { now?: Date; fetcher?: FeedFetcher };

const errText = (e: unknown) => {
  if (e instanceof FeedError) return e.message;
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "The site did not answer in time.";
  return `Could not read the feed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
};

const backoffMinutes = (failures: number) => Math.min(24 * 60, 30 * 2 ** Math.max(0, failures - 1));

const audienceOf = (s: NewsSource, people: WatchedPerson[]) => people.filter((p) => s.audience === "all" || (s.audience === "athletes" ? p.kind === "athlete" : p.kind === "alumni"));

export async function runNewsWatch(db: DB, orgId: string, opts: RunOpts = {}): Promise<NewsJobResult> {
  const org = await newsOrg(db, orgId);
  if (!org) return { skipped: "organization not found" };
  if (!org.settings.enabled) return { skipped: "News watch is switched off in Settings" };
  const now = opts.now ?? new Date();
  const fetcher = opts.fetcher ?? httpFeedFetcher;
  const date = todayLocal(org.tz, now);
  const watched = await loadWatched(db, orgId);
  if (!watched.length) return { skipped: "nobody is on the watch list yet" };
  const sources = await db.select().from(newsSources).where(and(eq(newsSources.orgId, orgId), eq(newsSources.enabled, true))).orderBy(newsSources.createdAt, newsSources.id);
  const due = sources.filter((s) => (!s.backoffUntil || s.backoffUntil <= now) && (!s.lastFetchedAt || now.getTime() - s.lastFetchedAt.getTime() >= s.minIntervalMinutes * 60_000));
  const out = { date, watched: watched.length, sourcesFetched: 0, sourcesSkipped: sources.length - due.length, requests: 0, itemsSeen: 0, newClips: 0, capReached: false, failed: 0, errors: [] as { id: string; error: string }[] };

  /** Take one request from today's allowance. False when the cap is used up. */
  const allow = async (): Promise<boolean> => {
    const rows = await db
      .insert(newsFetchDays)
      .values({ orgId, day: date, requests: 1 })
      .onConflictDoUpdate({ target: [newsFetchDays.orgId, newsFetchDays.day], set: { requests: sql`${newsFetchDays.requests} + 1` }, setWhere: sql`${newsFetchDays.requests} < ${org.settings.dailyRequestCap}` })
      .returning({ requests: newsFetchDays.requests });
    if (!rows.length) out.capReached = true;
    return rows.length > 0;
  };
  const get = async (url: string): Promise<string> => {
    out.requests++;
    const res = await fetcher(url);
    if (res.status !== 200) throw new FeedError(statusProblem(res.status));
    return res.body;
  };
  const ok = (ids: string[], line: string) => db.update(newsSources).set({ lastFetchedAt: now, lastStatus: "ok", lastResult: line.slice(0, 300), consecutiveFailures: 0, backoffUntil: null, updatedAt: now }).where(and(eq(newsSources.orgId, orgId), inArray(newsSources.id, ids)));
  const fail = async (group: NewsSource[], e: unknown) => {
    const error = errText(e);
    for (const s of group) {
      const failures = s.consecutiveFailures + 1;
      await db.update(newsSources).set({ lastFetchedAt: now, lastStatus: "error", lastResult: error.slice(0, 300), consecutiveFailures: failures, backoffUntil: new Date(now.getTime() + backoffMinutes(failures) * 60_000), updatedAt: now }).where(and(eq(newsSources.orgId, orgId), eq(newsSources.id, s.id)));
      out.failed++;
      if (out.errors.length < 5) out.errors.push({ id: s.name, error });
      log("warn", "newswatch_source_failed", { orgId, sourceId: s.id, error });
    }
  };

  // --- Publisher feeds: one request each --------------------------------------------------
  for (const s of due.filter((x) => x.kind === "rss")) {
    const people = audienceOf(s, watched);
    if (!people.length) continue;
    if (!(await allow())) break;
    try {
      const items = NEWS_ADAPTERS.rss.parse(await get(NEWS_ADAPTERS.rss.requests([s], [])[0].url));
      const r = await db.transaction((tx) => ingestItems(tx, orgId, { id: s.id, name: s.name, isDemo: s.isDemo }, items, people, { now, maxAgeDays: org.settings.maxAgeDays }));
      await ok([s.id], `${items.length} headline${items.length === 1 ? "" : "s"} read, ${r.newClips} new clip${r.newClips === 1 ? "" : "s"} to review`);
      out.sourcesFetched++;
      out.itemsSeen += r.seen;
      out.newClips += r.newClips;
    } catch (e) {
      await fail([s], e);
    }
  }

  // --- News search: one request per watched person per search address ---------------------
  const groups = new Map<string, NewsSource[]>();
  for (const s of due.filter((x) => x.kind === "search")) groups.set(`${s.url}|${s.audience}`, [...(groups.get(`${s.url}|${s.audience}`) ?? []), s]);
  for (const group of groups.values()) {
    const people = audienceOf(group[0], watched);
    if (!people.length || out.capReached) continue;
    // A different person goes first each day, so a cap that cuts the list short is fair over a week.
    const start = Math.floor(now.getTime() / 86_400_000) % people.length;
    const order = [...people.slice(start), ...people.slice(0, start)];
    const reqs = NEWS_ADAPTERS.search.requests(group, order.map((p) => ({ key: personKey(p), fullName: `${p.firstName} ${p.lastName}` })));
    let searched = 0;
    let seen = 0;
    let clips = 0;
    let failed = false;
    for (const [i, req] of reqs.entries()) {
      if (!(await allow())) break;
      try {
        const person = order[i];
        const items = NEWS_ADAPTERS.search.parse(await get(req.url));
        // Keep only what came from the publications this search was restricted to.
        const sites = group.flatMap((s) => s.sites);
        const mine = items.filter((it) => {
          const d = domainOf(it.sourceUrl);
          return !d || sites.some((site) => d === site || d.endsWith(`.${site}`));
        });
        const bySource = (it: ParsedItem) => group.find((s) => s.sites.some((site) => domainOf(it.sourceUrl) === site || (domainOf(it.sourceUrl) ?? "").endsWith(`.${site}`))) ?? group[0];
        for (const s of group) {
          const part = mine.filter((it) => bySource(it).id === s.id);
          if (!part.length) continue;
          const r = await db.transaction((tx) => ingestItems(tx, orgId, { id: s.id, name: s.name, isDemo: s.isDemo }, part, people, { now, maxAgeDays: org.settings.maxAgeDays, searchedFor: { kind: person.kind, id: person.id } }));
          seen += r.seen;
          clips += r.newClips;
        }
        searched++;
      } catch (e) {
        await fail(group, e);
        failed = true;
        break;
      }
    }
    out.itemsSeen += seen;
    out.newClips += clips;
    if (!failed && searched > 0) {
      await ok(group.map((s) => s.id), `${searched} of ${order.length} name${order.length === 1 ? "" : "s"} searched${searched < order.length ? " (daily request limit reached)" : ""}, ${clips} new clip${clips === 1 ? "" : "s"} to review`);
      out.sourcesFetched += group.length;
    }
  }
  return out;
}
