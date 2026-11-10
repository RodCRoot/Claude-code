import { and, eq, inArray, isNull } from "drizzle-orm";
import { athletes, metricValues, organizations, showcaseViewDays, showcases } from "../../src/db/schema";
import type { Viewer } from "../../src/lib/authz/policy";
import { DEFAULT_SHOWCASE_CONFIG } from "../../src/lib/showcase/allowlist";
import { buildCatalog } from "../../src/lib/showcase/catalog";
import { finalizeRecap, monthOf, saveCoachNote, shiftMonth } from "../../src/lib/showcase/recap";
import { publishShowcase, saveShowcaseDraft } from "../../src/lib/showcase/showcase";
import { hashShareToken } from "../../src/lib/showcase/token";
import { addDaysYmd } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * A fixed share token for the demo organization so docs, screenshots and e2e tests can open
 * `/s/<token>` without reading the database. Demo data only: real tokens are random and are
 * never stored. Only the organization with the demo slug gets it; every other seeded organization
 * keeps the random token from publishing. Either way it is in `ctx.extra.showcase.token`.
 */
export const DEMO_SHOWCASE_TOKEN = "TeamworkDemoShowcaseMayaP000000000000000000";

/**
 * Synthetic Showcase and recap demo data: one published Showcase (Maya, published by her guardian
 * Alex with consent), one draft (Leo, drafted by Sam), and last month's finalized recap for both
 * with a sample coach note. Every step is skipped if the rows it needs were not seeded.
 */
export async function seedShowcase(ctx: SeedCtx) {
  const { tx, orgId, today } = ctx;
  const viewer = (userKey: string, personKey: string, role: Viewer["role"], name: string): Viewer => ({ userId: ctx.users[userKey], orgId, role, personId: ctx.people[personKey] ?? null, displayName: name, mfaVerified: true });
  const alex = viewer("alex", "alex_parker", "guardian", "Alex Parker");
  const sam = viewer("sam", "sam_rivera", "guardian", "Sam Rivera");
  const marcus = viewer("marcus", "marcus", "coach", "Coach Marcus Hale");
  const picked = ["maya", "leo"].map((k) => ctx.athletes[k]).filter(Boolean);
  if (!picked.length) return;

  // Demo only: the science seed leaves hand-entered test values without an author. Attribute
  // them to the coach so "Verified by Teamwork" has something to show, and give Maya a body weight.
  await tx.update(metricValues).set({ enteredBy: ctx.users.marcus }).where(and(eq(metricValues.orgId, orgId), inArray(metricValues.athleteId, picked), eq(metricValues.source, "teamwork_manual"), isNull(metricValues.enteredBy)));
  await tx.update(athletes).set({ bodyMassKg: "61.2" }).where(and(eq(athletes.id, ctx.athletes.maya), eq(athletes.orgId, orgId)));

  ctx.extra.showcase = {};
  const maya = await buildCatalog(tx, orgId, ctx.athletes.maya, { includeTraining: true, today, tz: ctx.tz });
  if (maya) {
    const want = ["Jump Height (Imp-Mom)", "10 yd sprint", "40 yd sprint", "Broad Jump", "Peak Propulsive Power", "mRSI"];
    const metricIds = want.map((n) => maya.metrics?.find((m) => m.name === n)?.id).filter((x): x is string => !!x);
    const lifts = ["Back Squat", "Trap Bar Deadlift", "Power Clean", "Bench Press"].map((n) => maya.lifts?.find((l) => l.name === n)?.exerciseId).filter((x): x is string => !!x);
    const { row, token } = await publishShowcase(
      tx,
      alex,
      ctx.athletes.maya,
      {
        consent: true,
        expiryDays: 90,
        config: {
          ...DEFAULT_SHOWCASE_CONFIG,
          nameDisplay: "first_initial",
          show: { sport: true, position: true, gradYear: true, school: true, ageBand: false, weight: false, sessions: true, streak: true, memberSince: true, relativeStrength: lifts.length > 0 },
          metricIds,
          exerciseIds: lifts,
          bio: "Outside hitter who loves the back row as much as the front. I train three days a week and I am working on my approach jump and first-step quickness. (Sample bio for a demo athlete.)",
          videoUrl: "https://example.com/highlights/sample",
          contactEmail: "family.demo@example.test",
        },
      },
      // Real time, not the seed's "today": a link's lifetime runs on the wall clock.
      new Date(Date.now() - 6 * 86_400_000),
    );
    // Only the demo organization gets the fixed token. Test organizations (unique slugs, seeded in
    // parallel) keep the random one, so the unique hash can never collide.
    let demoToken = token ?? "";
    const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId));
    if (org?.slug === "teamwork-demo") {
      await tx.update(showcases).set({ tokenHash: hashShareToken(DEMO_SHOWCASE_TOKEN) }).where(eq(showcases.id, row.id));
      demoToken = DEMO_SHOWCASE_TOKEN;
    }
    ctx.extra.showcase.token = demoToken;
    ctx.extra.showcase.mayaShowcaseId = row.id;
    // A few coarse daily view counts (no visitor data exists to seed).
    await tx.insert(showcaseViewDays).values([5, 3, 1].map((daysAgo, i) => ({ showcaseId: row.id, orgId, day: addDaysYmd(today, -daysAgo), views: [2, 4, 1][i] })));
  }

  if (ctx.athletes.leo) {
    const leo = await buildCatalog(tx, orgId, ctx.athletes.leo, { includeTraining: true, today, tz: ctx.tz });
    if (leo) {
      await saveShowcaseDraft(tx, sam, ctx.athletes.leo, {
        ...DEFAULT_SHOWCASE_CONFIG,
        nameDisplay: "first",
        metricIds: (leo.metrics ?? []).slice(0, 2).map((m) => m.id),
        exerciseIds: (leo.lifts ?? []).slice(0, 2).map((l) => l.exerciseId),
        bio: "Wide receiver. Draft in progress. (Sample bio for a demo athlete.)",
      });
    }
  }

  // Last month's recap for two athletes, with a sample coach note, finalized the way the monthly job does it.
  const last = shiftMonth(monthOf(today), -1);
  const notes: Record<string, string> = {
    maya: "Great month, Maya. Your approach jump is getting quicker off the floor and you did not miss a week. Next month we add a little more single-leg work. (Sample coach note.)",
    leo: "Strong work on the power clean. Keep the same patience out of the bottom and the bar speed will keep climbing. (Sample coach note.)",
  };
  for (const key of ["maya", "leo"]) {
    const athleteId = ctx.athletes[key];
    if (!athleteId) continue;
    await saveCoachNote(tx, marcus, { athleteId, month: last, note: notes[key] }, { today });
    await finalizeRecap(tx, orgId, athleteId, last, "seed", { today, tz: ctx.tz });
  }
}
