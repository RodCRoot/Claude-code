/**
 * News watch: reading feeds. Only feeds are requested (RSS, Atom, or a news search feed); article
 * pages are never opened. From each entry only the title, the link, the date, the publication
 * name and a short plain-text summary are kept. Images and enclosures are ignored.
 *
 * `NewsSourceAdapter` is the seam for another provider: a licensed news API would be a third
 * adapter with its own `requests` and `parse`. None is integrated.
 */
import { createHash } from "node:crypto";
import type { NewsSourceKind } from "@/db/schema";
import { clipSnippet, NEWS_HEADLINE_MAX, NEWS_USER_AGENT, normText } from "./shared";

export type ParsedItem = {
  headline: string;
  link: string;
  publishedAt: Date | null;
  /** Publication named by the entry itself (a search feed's <source>), when there is one. */
  sourceName: string | null;
  /** The publication's site, when the entry names it. */
  sourceUrl: string | null;
  snippet: string | null;
};

export class FeedError extends Error {}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "..." };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Element text as plain text: CDATA unwrapped, entities decoded, any markup inside removed. */
function plain(raw: string | null): string {
  if (raw == null) return "";
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = decodeEntities(s);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function tag(block: string, name: string): { attrs: string; inner: string } | null {
  const m = new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? { attrs: m[1] ?? "", inner: m[2] } : null;
}

const attr = (attrs: string, name: string) => {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
};

function httpsLink(raw: string | null | undefined): string | null {
  const s = decodeEntities((raw ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
  try {
    const u = new URL(s);
    if (u.protocol === "http:") u.protocol = "https:";
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return null;
    return u.toString().slice(0, 1000);
  } catch {
    return null;
  }
}

function parseDate(raw: string): Date | null {
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * Parse an RSS 2.0 or Atom document. Throws `FeedError` when the text is not a feed at all; an
 * entry that lacks a title or a usable https link is skipped. An empty feed gives an empty list.
 */
export function parseFeed(xml: string, opts: { maxItems?: number } = {}): ParsedItem[] {
  const text = xml.replace(/^﻿/, "");
  const isRss = /<rss[\s>]/i.test(text) || /<rdf:RDF[\s>]/i.test(text);
  const isAtom = /<feed[\s>]/i.test(text);
  if (!isRss && !isAtom) throw new FeedError("The address did not return an RSS or Atom feed.");
  if (isRss ? !/<\/(rss|rdf:RDF)>/i.test(text) : !/<\/feed>/i.test(text)) throw new FeedError("The feed is cut off or not valid XML.");
  const blocks = text.match(isRss ? /<item[\s>][\s\S]*?<\/item>/gi : /<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: ParsedItem[] = [];
  for (const b of blocks.slice(0, opts.maxItems ?? 200)) {
    let headline = plain(tag(b, "title")?.inner ?? null);
    let link: string | null;
    if (isRss) {
      link = httpsLink(tag(b, "link")?.inner);
    } else {
      const links = [...b.matchAll(/<link\s([^>]*?)\/?>/gi)].map((m) => m[1]);
      const alt = links.find((a) => (attr(a, "rel") ?? "alternate") === "alternate") ?? links[0];
      link = httpsLink(alt ? attr(alt, "href") : null);
    }
    if (!headline || !link) continue;
    const src = tag(b, "source");
    const sourceName = src ? plain(isRss ? src.inner : tag(src.inner, "title")?.inner ?? null) || null : null;
    const sourceUrl = src && isRss ? httpsLink(attr(src.attrs, "url")) : null;
    // A search feed appends " - Publication" to every title. Take it back off.
    if (sourceName && headline.toLowerCase().endsWith(` - ${sourceName.toLowerCase()}`)) headline = headline.slice(0, headline.length - sourceName.length - 3).trim();
    const dateRaw = tag(b, "pubDate")?.inner ?? tag(b, "published")?.inner ?? tag(b, "updated")?.inner ?? tag(b, "dc:date")?.inner ?? "";
    let snippet = clipSnippet(plain(tag(b, "description")?.inner ?? tag(b, "summary")?.inner ?? null));
    // Some feeds repeat the title (plus the publication) as the description. That is not a summary.
    if (snippet && normText(snippet).startsWith(normText(headline)) && normText(snippet).length <= normText(headline).length + normText(sourceName).length + 2) snippet = null;
    if (!headline) continue;
    out.push({ headline: headline.slice(0, NEWS_HEADLINE_MAX), link, publishedAt: parseDate(plain(dateRaw)), sourceName: sourceName?.slice(0, 120) ?? null, sourceUrl, snippet });
  }
  return out;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The link without its fragment and tracking parameters, lowercased host, no trailing slash. */
export function linkKey(link: string): string {
  try {
    const u = new URL(link);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|oc$|ref$|cmp$)/i.test(k)) u.searchParams.delete(k);
    return sha(`${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}?${u.searchParams.toString()}`);
  } catch {
    return sha(link);
  }
}

/** Same headline from the same publication = the same article, however it arrived. */
export function titleKey(headline: string, publication: string): string {
  // Search results often carry a trailing " | Section" that the publisher's own feed does not.
  return sha(`${normText(headline.replace(/\s+\|\s+[^|]{1,40}$/, ""))}|${normText(publication)}`);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export type FeedFetcher = (url: string) => Promise<{ status: number; body: string }>;

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_FEED_BYTES = 2 * 1024 * 1024;

/**
 * A feed address the Hub is willing to request: https, a public host name (no IP addresses, no
 * localhost or internal names), no sign-in part. Returns the error text or null.
 */
export function feedUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "That does not look like a web address. Paste the full address starting with https://";
  }
  if (u.protocol !== "https:") return "Feed addresses must start with https://";
  if (u.username || u.password) return "Remove the sign-in part of the address. Feeds behind a sign-in are not read.";
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[") || /(^|\.)(localhost|local|internal|lan|home|corp|test|invalid)$/.test(host)) return "Use a public web address.";
  if (u.port && u.port !== "443") return "Use a public web address without a port number.";
  return null;
}

/**
 * The real fetcher: one GET with an honest user agent, a timeout and a size limit. Redirects are
 * followed by hand (three at most) so every hop passes `feedUrlProblem`. Nothing is retried here;
 * the job backs a failing source off. A 401, 402 or 403 is reported as it is: the Hub does not
 * try to get around a paywall or a block.
 */
export const httpFeedFetcher: FeedFetcher = async (url) => {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const bad = feedUrlProblem(current);
    if (bad) throw new FeedError(bad);
    const res = await fetch(current, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": NEWS_USER_AGENT, accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8" } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new FeedError(`The address answered ${res.status} without saying where it moved.`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (res.status !== 200) return { status: res.status, body: "" };
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_FEED_BYTES) throw new FeedError("The feed is too large to read.");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_FEED_BYTES) throw new FeedError("The feed is too large to read.");
    return { status: 200, body: new TextDecoder("utf-8").decode(buf) };
  }
  throw new FeedError("The address redirected too many times.");
};

export function statusProblem(status: number): string {
  if (status === 401 || status === 402 || status === 403) return `The site refused the request (HTTP ${status}). It is behind a paywall or does not allow feed readers. The Hub does not work around that: switch this source off or use a different feed.`;
  if (status === 404 || status === 410) return `No feed at that address (HTTP ${status}).`;
  if (status === 429) return "The site asked the Hub to slow down (HTTP 429). It will wait longer before trying again.";
  return `The site answered HTTP ${status}.`;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export type SourceRequest = { url: string; /** Watched person this request searched for, if any. */ personKey: string | null };
export type AdapterSource = { url: string; sites: string[] };
export type AdapterPerson = { key: string; fullName: string };

export interface NewsSourceAdapter {
  kind: NewsSourceKind;
  /** The feed requests to make for these sources and these watched people. */
  requests(sources: AdapterSource[], people: AdapterPerson[]): SourceRequest[];
  parse(body: string): ParsedItem[];
}

/** `"First Last" (site:a.com OR site:b.com)`: the exact full name, only on the named publications. */
export function searchQuery(fullName: string, sites: string[]): string {
  const name = `"${fullName.replace(/["()]/g, " ").replace(/\s+/g, " ").trim()}"`;
  const s = sites.map((d) => `site:${d}`);
  return s.length === 0 ? name : s.length === 1 ? `${name} ${s[0]}` : `${name} (${s.join(" OR ")})`;
}

export const rssAdapter: NewsSourceAdapter = {
  kind: "rss",
  requests: (sources) => sources.map((s) => ({ url: s.url, personKey: null })),
  parse: (body) => parseFeed(body),
};

/** One request per watched person, covering every site of the sources that share the search address. */
export const searchAdapter: NewsSourceAdapter = {
  kind: "search",
  requests: (sources, people) => {
    if (!sources.length) return [];
    const sites = [...new Set(sources.flatMap((s) => s.sites))];
    return people.map((p) => ({ url: sources[0].url.replace("{query}", encodeURIComponent(searchQuery(p.fullName, sites))), personKey: p.key }));
  },
  parse: (body) => parseFeed(body, { maxItems: 100 }),
};

export const NEWS_ADAPTERS: Record<NewsSourceKind, NewsSourceAdapter> = { rss: rssAdapter, search: searchAdapter };

/** "www.Example.com" and "https://example.com/x" both become "example.com". Null when it is not a domain. */
export function cleanDomain(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) && s.length <= 100 ? s : null;
}

export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
