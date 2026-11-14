/**
 * Gym TV board: display devices and the one payload they can read.
 *
 * Access model (docs/modules/community.md): a display is NOT a user. Settings → Community issues
 * a random token (only its SHA-256 hash is stored); the TV opens a one-time link that stores the
 * token in an httpOnly cookie. That cookie is accepted by exactly two handlers, the /display
 * page and GET /api/display/board, and by nothing else in the app: it is not a session, so every
 * other route treats the TV as signed out. Revoking the token kills it immediately.
 *
 * The payload is built from display names only (`communityRoster`): no athlete ids, no last
 * names, no ages or birthdays, no health or billing data, no class rosters.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { communityDisplayTokens, users } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { badgeDef } from "@/lib/engagement/badges";
import { levelFor } from "@/lib/engagement/levels";
import { milestonesFor } from "@/lib/retention/milestones";
import { fmt, fmtTime, localDayBounds, localToUtc, startOfWeekYmd, todayLocal } from "@/lib/time";
import { challengeView, currentChallenges } from "./challenges";
import { communityRoster } from "./display-name";
import { buildBoards, loadCommunityStats } from "./leaderboards";
import { actorOf, communityOrg } from "./settings";
import { AGE_BANDS, SHOUTOUT_LABEL, type BoardPanel, type BoardPayload, type ChallengeView } from "./shared";
import { recentShoutoutRows } from "./shoutouts";
import { fmtLoad, measuredPrs } from "./stats";
import { tvAlumniItems } from "@/lib/newswatch/clips";
import { tvWinItems } from "@/lib/wins/wins";

export const DISPLAY_COOKIE = "tw_display";
export const DISPLAY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const MAX_ACTIVE_DISPLAYS = 10;

export const newDisplayToken = () => randomBytes(32).toString("base64url");
export const hashDisplayToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
export const displayLinkPath = (token: string) => `/display/link/${token}`;

/** Create a display device. The plain token is returned once and never stored. Owner/admin only. */
export async function createDisplayToken(tx: Tx, v: Viewer, input: { label: string }): Promise<{ id: string; token: string }> {
  assertCan(v, "settings.manage");
  const label = input.label?.trim();
  if (!label || label.length < 2) throw new UserError("Name the screen, for example Front lobby TV.", { label: "Required" });
  if (label.length > 60) throw new UserError("Keep the name under 60 characters.", { label: "Too long" });
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(communityDisplayTokens).where(and(eq(communityDisplayTokens.orgId, v.orgId), isNull(communityDisplayTokens.revokedAt)));
  if (n >= MAX_ACTIVE_DISPLAYS) throw new UserError(`Up to ${MAX_ACTIVE_DISPLAYS} screens can be connected. Revoke one first.`);
  const token = newDisplayToken();
  const [row] = await tx.insert(communityDisplayTokens).values({ orgId: v.orgId, label, tokenHash: hashDisplayToken(token), createdBy: v.userId }).returning({ id: communityDisplayTokens.id });
  await audit(tx, actorOf(v), "community.display.create", "community_display_token", row.id, { summary: `Display screen added: ${label}`, after: { label } });
  return { id: row.id, token };
}

/** Revoke a display device. The token stops working at once. Owner/admin only. */
export async function revokeDisplayToken(tx: Tx, v: Viewer, id: string): Promise<void> {
  assertCan(v, "settings.manage");
  const [row] = await tx.select().from(communityDisplayTokens).where(and(eq(communityDisplayTokens.id, id), eq(communityDisplayTokens.orgId, v.orgId))).for("update");
  if (!row) throw new UserError("Screen not found.");
  if (row.revokedAt) return;
  await tx.update(communityDisplayTokens).set({ revokedAt: new Date(), revokedBy: v.userId }).where(eq(communityDisplayTokens.id, row.id));
  await audit(tx, actorOf(v), "community.display.revoke", "community_display_token", row.id, { summary: `Display screen revoked: ${row.label}`, before: { label: row.label } });
}

export async function listDisplayTokens(tx: Tx, v: Viewer) {
  assertCan(v, "settings.manage");
  return tx
    .select({ id: communityDisplayTokens.id, label: communityDisplayTokens.label, createdAt: communityDisplayTokens.createdAt, lastSeenAt: communityDisplayTokens.lastSeenAt, revokedAt: communityDisplayTokens.revokedAt, createdBy: users.displayName })
    .from(communityDisplayTokens)
    .leftJoin(users, eq(users.id, communityDisplayTokens.createdBy))
    .where(eq(communityDisplayTokens.orgId, v.orgId))
    .orderBy(desc(communityDisplayTokens.createdAt));
}

/**
 * Resolve a display token to its organization. Null for a malformed, unknown or revoked token.
 * `touch` records that the screen was seen (at most once every five minutes).
 */
export async function resolveDisplayToken(tx: Tx, token: unknown, opts: { touch?: boolean } = {}): Promise<{ orgId: string; tokenId: string } | null> {
  if (typeof token !== "string" || !DISPLAY_TOKEN_PATTERN.test(token)) return null;
  const [row] = await tx.select().from(communityDisplayTokens).where(eq(communityDisplayTokens.tokenHash, hashDisplayToken(token)));
  if (!row || row.revokedAt) return null;
  if (opts.touch && (!row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > 5 * 60_000)) {
    await tx.update(communityDisplayTokens).set({ lastSeenAt: new Date() }).where(eq(communityDisplayTokens.id, row.id));
  }
  return { orgId: row.orgId, tokenId: row.id };
}

const rowsOf = async <T>(tx: Tx, q: ReturnType<typeof sql>) => (await tx.execute(q)).rows as T[];
const ymdOf = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));

const MAX_ITEMS = 6;
/** A board needs at least this many visible athletes to go on the TV. */
const TV_BOARD_MIN = 3;
const TV_BOARDS_MAX = 8;

/**
 * Everything the TV shows, for one organization. Read-only: this never writes XP, badges or
 * completions. Panels turned off in settings, and panels with nothing to show, are left out.
 */
export async function boardPayload(tx: Tx, orgId: string, opts: { now?: Date } = {}): Promise<BoardPayload> {
  const org = await communityOrg(tx, orgId);
  const now = opts.now ?? new Date();
  const tz = org.tz;
  const today = todayLocal(tz, now);
  const base: BoardPayload = { generatedAt: now.toISOString(), orgName: org.name, enabled: org.settings.enabled, rotationSeconds: org.settings.rotationSeconds, timeZone: tz, dateLabel: fmt(now, "EEEE, MMMM d", tz), panels: [] };
  if (!org.settings.enabled) return base;
  const on = org.settings.panels;
  const roster = await communityRoster(tx, orgId, { today, defaultMode: org.settings.defaultDisplayMode });
  const nameOf = (athleteId: string) => roster.get(athleteId)?.displayName ?? null;
  const stats = await loadCommunityStats(tx, orgId, { today, tz });
  const weekStart = startOfWeekYmd(today);
  const weekStartAt = localDayBounds(weekStart, tz).start;
  const panels: BoardPanel[] = [];

  if (on.message && org.settings.orgMessage) panels.push({ key: "message", title: `From ${org.name}`, text: org.settings.orgMessage });

  if (on.classes) {
    const { start, end } = localDayBounds(today, tz);
    const sessions = await rowsOf<{ title: string; starts_at: string | Date; ends_at: string | Date; capacity: number; coach: string | null; taken: number }>(
      tx,
      sql`select s.title, s.starts_at, s.ends_at, s.capacity, u.display_name as coach,
            (select count(*)::int from bookings b where b.session_id = s.id and b.status in ('booked','attended')) as taken
          from schedule_sessions s left join users u on u.id = s.coach_user_id
          where s.org_id = ${orgId} and s.status <> 'cancelled' and s.visibility <> 'private'
            and s.starts_at >= ${start.toISOString()} and s.starts_at < ${end.toISOString()}
          order by s.starts_at`,
    );
    const live = sessions.filter((s) => new Date(s.ends_at) > now);
    const items = (live.length ? live : sessions.slice(-MAX_ITEMS)).slice(0, MAX_ITEMS).map((s) => {
      const startsAt = new Date(s.starts_at);
      const endsAt = new Date(s.ends_at);
      return { time: fmtTime(startsAt, tz), title: s.title, coach: s.coach, spotsLeft: Math.max(0, s.capacity - s.taken), state: endsAt <= now ? ("done" as const) : startsAt <= now ? ("now" as const) : ("next" as const) };
    });
    if (items.length) panels.push({ key: "classes", title: "Today's classes", items });
  }

  if (on.pr_bell) {
    const items: { name: string; lift: string; value: string; delta: string | null; when: string; on: string }[] = [];
    for (const [athleteId, rows] of stats.maxesByAthlete) {
      const name = nameOf(athleteId);
      if (!name) continue;
      for (const p of measuredPrs(rows)) {
        if (p.recordedOn < weekStart || p.recordedOn > today) continue;
        items.push({
          name,
          lift: stats.exerciseNames.get(p.exerciseId) ?? "Lift",
          value: fmtLoad(p.value, p.unit),
          delta: p.unit === p.previousUnit ? `+${fmtLoad(p.value - p.previous, p.unit)}` : null,
          when: p.recordedOn === today ? "Today" : fmt(localToUtc(p.recordedOn, "12:00", tz), "EEEE", tz),
          on: p.recordedOn,
        });
      }
    }
    items.sort((a, b) => b.on.localeCompare(a.on) || a.name.localeCompare(b.name));
    if (items.length) panels.push({ key: "pr_bell", title: "PR Bell", items: items.slice(0, MAX_ITEMS).map((i) => ({ name: i.name, lift: i.lift, value: i.value, delta: i.delta, when: i.when })) });
  }

  if (on.shoutouts) {
    const rows = await recentShoutoutRows(tx, orgId, new Date(now.getTime() - 7 * 86_400_000));
    const items = rows.flatMap((r) => {
      const name = nameOf(r.athleteId);
      return name ? [{ name, headline: SHOUTOUT_LABEL[r.template], note: r.note, coach: r.coach }] : [];
    });
    if (items.length) panels.push({ key: "shoutouts", title: "Coach shoutouts", items: items.slice(0, 4) });
  }

  if (on.wins) {
    // Approved wins with the TV level on, under display names. No ids, no photos, no links.
    // Approved alumni news clips share the panel: name form the alumnus agreed to, headline, publication.
    const alumniItems = await tvAlumniItems(tx, orgId, { tz, now, limit: 2 });
    const items = [...(await tvWinItems(tx, orgId, roster, { today, tz, limit: 4 - alumniItems.length })), ...alumniItems];
    if (items.length) panels.push({ key: "wins", title: "Wins outside the gym", items });
  }

  if (on.streaks) {
    const items = [...stats.streaks]
      .flatMap(([id, weeks]) => {
        const name = nameOf(id);
        return name && weeks >= 2 ? [{ name, weeks }] : [];
      })
      .sort((a, b) => b.weeks - a.weeks || a.name.localeCompare(b.name));
    if (items.length) panels.push({ key: "streaks", title: "On a streak", items: items.slice(0, 8) });
  }

  if (on.level_ups) {
    const xp = await rowsOf<{ athlete_id: string; total: number; before: number }>(
      tx,
      sql`select athlete_id, sum(points)::int as total, coalesce(sum(points) filter (where occurred_at < ${weekStartAt.toISOString()}), 0)::int as before
          from xp_events where org_id = ${orgId} group by athlete_id having sum(points) filter (where occurred_at >= ${weekStartAt.toISOString()}) > 0`,
    );
    const items: Extract<BoardPanel, { key: "level_ups" }>["items"] = [];
    for (const r of xp) {
      const name = nameOf(r.athlete_id);
      const lv = levelFor(r.total);
      if (name && lv.level > levelFor(r.before).level) items.push({ name, kind: "level", label: `Level ${lv.level} · ${lv.title}`, badgeKey: null, level: lv.level });
    }
    const badges = await rowsOf<{ athlete_id: string; badge_key: string }>(tx, sql`select athlete_id, badge_key from athlete_badges where org_id = ${orgId} and earned_at >= ${weekStartAt.toISOString()} and earned_at <= ${now.toISOString()} order by earned_at desc`);
    for (const b of badges) {
      const name = nameOf(b.athlete_id);
      const def = badgeDef(b.badge_key);
      if (name && def) items.push({ name, kind: "badge", label: def.name, badgeKey: def.key, level: null });
    }
    if (items.length) panels.push({ key: "level_ups", title: "Level ups and new badges", items: items.slice(0, 8) });
  }

  if (on.milestones) {
    const starts = await rowsOf<{ athlete_id: string; first_start: unknown }>(
      tx,
      sql`select m.athlete_id, min(m.start_date) as first_start from memberships m
          where m.org_id = ${orgId} and m.status <> 'pending' group by m.athlete_id
          having bool_or(m.status in ('trialing','active','on_hold','past_due'))`,
    );
    const firstStart = new Map(starts.map((s) => [s.athlete_id, ymdOf(s.first_start)]));
    const items: { name: string; label: string }[] = [];
    for (const r of roster.values()) {
      if (!r.displayName) continue;
      // dateOfBirth is deliberately not passed: birthdays never go on the board.
      const ms = milestonesFor({ athleteId: r.athleteId, personId: "", name: r.displayName, dateOfBirth: null, firstStart: firstStart.get(r.athleteId) ?? null, attendedDays: (stats.activity.get(r.athleteId)?.attended ?? []).filter((d) => d <= today) }, today);
      for (const m of ms) if (m.when !== "upcoming" && m.kind !== "birthday") items.push({ name: r.displayName, label: m.label });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    if (items.length) panels.push({ key: "milestones", title: "Milestones this week", items: items.slice(0, MAX_ITEMS) });
  }

  if (on.challenges) {
    const challenges = await currentChallenges(tx, orgId, today);
    const gids = [...new Set(challenges.flatMap((c) => (c.groupId ? [c.groupId] : [])))];
    const names = gids.length ? await rowsOf<{ id: string; name: string }>(tx, sql`select id, name from groups where org_id = ${orgId} and id in (${sql.join(gids.map((g) => sql`${g}`), sql`, `)})`) : [];
    for (const c of challenges.slice(0, 3)) {
      const view: Partial<ChallengeView> = challengeView(c, roster, stats.activity, today, new Set(), names.find((g) => g.id === c.groupId)?.name ?? null, { leaders: 5 });
      // The TV gets no ids and no per-viewer lines.
      delete view.id;
      delete view.you;
      panels.push({ key: "challenges", title: "Team challenge", challenge: view as Omit<ChallengeView, "id" | "you"> });
    }
  }

  if (on.leaderboards) {
    const boards = AGE_BANDS.flatMap((band) => buildBoards(roster, stats, { band, groupId: null, groupName: null }, new Set(), { limit: 5 }))
      // Relative strength stays off the TV; small boards too.
      .filter((b) => b.kind !== "relative" && b.rows.length >= TV_BOARD_MIN);
    // Rotate which boards are shown so every band and lift gets screen time across the day.
    const offset = boards.length > TV_BOARDS_MAX ? Math.floor(now.getTime() / (10 * 60_000)) % boards.length : 0;
    const pick = boards.length > TV_BOARDS_MAX ? Array.from({ length: TV_BOARDS_MAX }, (_, i) => boards[(offset + i) % boards.length]) : boards;
    for (const b of pick) panels.push({ key: "leaderboards", title: "Leaderboard", board: { title: b.title, label: b.label, cohort: b.band === "Adult" ? "Adults" : b.band, rows: b.rows.map(({ rank, name, value, detail }) => ({ rank, name, value, detail })) } });
  }

  return { ...base, panels: orderPanels(panels) };
}

/** Interleave so the same kind of panel is not shown many times in a row. Pure. */
export function orderPanels(panels: BoardPanel[]): BoardPanel[] {
  const singles = panels.filter((p) => p.key !== "leaderboards");
  const boards = panels.filter((p) => p.key === "leaderboards");
  if (!boards.length || !singles.length) return panels;
  const out: BoardPanel[] = [];
  const per = Math.max(1, Math.ceil(boards.length / singles.length));
  let b = 0;
  for (const s of singles) {
    out.push(s);
    for (let i = 0; i < per && b < boards.length; i++) out.push(boards[b++]);
  }
  while (b < boards.length) out.push(boards[b++]);
  return out;
}
