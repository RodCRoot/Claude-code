import { and, desc, eq } from "drizzle-orm";
import { communityDisplayPrefs, communityDisplayTokens, exercises, maxes, organizations, users } from "../../src/db/schema";
import type { Viewer } from "../../src/lib/authz/policy";
import { createDisplayToken, hashDisplayToken } from "../../src/lib/community/board";
import { createChallenge, syncChallengeCompletions } from "../../src/lib/community/challenges";
import { setDisplayMode } from "../../src/lib/community/display-name";
import { DEFAULT_COMMUNITY_SETTINGS } from "../../src/lib/community/settings";
import { postShoutout } from "../../src/lib/community/shoutouts";
import { refreshEngagement } from "../../src/lib/engagement/sync";
import { addDaysYmd, fmt, localToUtc, startOfWeekYmd } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * A fixed display token for the demo organization so docs, screenshots and e2e tests can open the
 * TV board without reading the database. Demo data only: real tokens are random and only their
 * hash is stored. Other seeded organizations get a random token in `ctx.extra.community.displayToken`.
 */
export const DEMO_DISPLAY_TOKEN = "TeamworkDemoDisplayBoardTV00000000000000000";

/**
 * Synthetic community demo data: a sample gym message, one hidden athlete (Eli, set by his
 * guardian), one first-name-only athlete (Liam), a few measured PRs this week for the PR Bell,
 * coach shoutouts, two current challenges and one TV display. No real names.
 * Every step is skipped if the rows it needs were not seeded.
 */
export async function seedCommunity(ctx: SeedCtx) {
  const { tx, orgId, today, tz } = ctx;
  const viewerOf = async (userKey: string): Promise<Viewer | null> => {
    const id = ctx.users[userKey];
    if (!id) return null;
    const [u] = await tx.select().from(users).where(eq(users.id, id));
    return u ? { userId: u.id, orgId, role: u.role, personId: u.personId, displayName: u.displayName, mfaVerified: true } : null;
  };
  const rod = await viewerOf("rod");
  const marcus = await viewerOf("marcus");
  const tess = await viewerOf("tess");
  const alex = await viewerOf("alex");
  if (!rod) return;

  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
  await tx
    .update(organizations)
    .set({ settings: { ...org.settings, community: { ...DEFAULT_COMMUNITY_SETTINGS, orgMessage: "SAMPLE MESSAGE: Saturday open gym runs 9 to 11 this week. Bring a friend." } } })
    .where(eq(organizations.id, orgId));

  // Display consent: Eli is hidden by his guardian (the real path), Liam shows a first name only.
  if (alex && ctx.athletes.eli) await setDisplayMode(tx, alex, { athleteId: ctx.athletes.eli, mode: "hidden" }, today);
  if (ctx.athletes.liam) await tx.insert(communityDisplayPrefs).values({ orgId, athleteId: ctx.athletes.liam, mode: "first_name_only", setBy: rod.userId, isDemo: true }).onConflictDoNothing();

  // A few tested PRs this week so the PR Bell has something to ring.
  const weekStart = startOfWeekYmd(today);
  const prs: [string, string, number, number][] = [
    ["ethan", "Bench Press", 10, 0],
    ["zoe", "Trap Bar Deadlift", 15, 1],
    ["jackson", "Power Clean", 5, 2],
  ];
  for (const [key, lift, add, daysAgo] of prs) {
    const athleteId = ctx.athletes[key];
    if (!athleteId) continue;
    const [ex] = await tx.select().from(exercises).where(and(eq(exercises.orgId, orgId), eq(exercises.name, lift)));
    if (!ex) continue;
    const [best] = await tx.select().from(maxes).where(and(eq(maxes.athleteId, athleteId), eq(maxes.exerciseId, ex.id))).orderBy(desc(maxes.recordedOn));
    if (!best) continue;
    const day = addDaysYmd(today, -daysAgo) < weekStart ? weekStart : addDaysYmd(today, -daysAgo);
    await tx.insert(maxes).values({ orgId, athleteId, exerciseId: ex.id, value: String(Number(best.value) + add), unit: best.unit, kind: "tested", method: "tested", recordedOn: day, enteredBy: ctx.users.marcus ?? null });
    await refreshEngagement(tx, orgId, athleteId, { today });
  }

  // Coach shoutouts (posted through the real path: coach scope, daily limit, XP).
  const shout = async (coach: Viewer | null, key: string, template: string, note: string | null, hoursAgo: number) => {
    if (!coach || !ctx.athletes[key]) return;
    await postShoutout(tx, coach, { athleteId: ctx.athletes[key], template, note }, { today, now: new Date(Date.now() - hoursAgo * 3_600_000) });
  };
  await shout(marcus, "maya", "great_effort", "Stayed after to help the younger group with their warm-up. (sample)", 3);
  await shout(marcus, "ethan", "new_pr", "Bench press PR with clean reps. (sample)", 5);
  await shout(marcus, "liam", "leader_today", null, 26);
  await shout(tess, "harper", "consistency", "Four weeks without a missed session. (sample)", 28);
  await shout(tess, "eli", "great_effort", "Best sprint mechanics of the day. (sample)", 30);

  // Two current challenges: gym-wide individual, and a team total for the HS group.
  const monthStart = `${today.slice(0, 7)}-01`;
  const next = addDaysYmd(monthStart, 32);
  const monthEnd = addDaysYmd(`${next.slice(0, 7)}-01`, -1);
  const month = fmt(localToUtc(today, "12:00", tz), "MMMM", tz);
  await createChallenge(tx, rod, { title: `${month}: 6 sessions each (sample)`, mode: "individual", metric: "attendance", target: 6, startsOn: monthStart, endsOn: monthEnd, groupId: null }, { today });
  if (marcus && ctx.groups.hs) await createChallenge(tx, marcus, { title: "HS team total: 90 workouts logged (sample)", mode: "group_total", metric: "workouts", target: 90, startsOn: addDaysYmd(today, -21), endsOn: addDaysYmd(today, 14), groupId: ctx.groups.hs }, { today });
  await syncChallengeCompletions(tx, orgId, { today });

  // One TV display. The demo organization gets the fixed token above.
  const created = await createDisplayToken(tx, rod, { label: "Front lobby TV (demo)" });
  let token = created.token;
  if (org.slug === "teamwork-demo") {
    await tx.update(communityDisplayTokens).set({ tokenHash: hashDisplayToken(DEMO_DISPLAY_TOKEN), isDemo: true }).where(eq(communityDisplayTokens.id, created.id));
    token = DEMO_DISPLAY_TOKEN;
  }
  ctx.extra.community = { displayToken: token, displayTokenId: created.id };
}
