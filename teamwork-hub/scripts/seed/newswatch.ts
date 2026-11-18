import { eq } from "drizzle-orm";
import { people, users } from "../../src/db/schema";
import type { Viewer } from "../../src/lib/authz/policy";
import { approveClip, ingestItems, listClips, triageClip } from "../../src/lib/newswatch/clips";
import type { ParsedItem } from "../../src/lib/newswatch/feed";
import { ensureDefaultSources } from "../../src/lib/newswatch/settings";
import { createAlumnus, loadWatched, requestNewsOptIn, setAlumniWatch, setNewsOptIn, setWatchTerms } from "../../src/lib/newswatch/watch";
import type { SeedCtx } from "./context";

/**
 * Synthetic News watch demo data, written through the real paths (opt-in by the family, the
 * matcher, triage, approval by the owner). Every paper, school, college and headline is invented
 * and says so; links point at the reserved example.com domain. News watch itself is left switched
 * OFF, so the demo never requests anything from a real site.
 */
export async function seedNewsWatch(ctx: SeedCtx) {
  const { tx, orgId, today } = ctx;
  const viewerOf = async (userKey: string): Promise<Viewer | null> => {
    const id = ctx.users[userKey];
    if (!id) return null;
    const [u] = await tx.select().from(users).where(eq(users.id, id));
    return u ? { userId: u.id, orgId, role: u.role, personId: u.personId, displayName: u.displayName, mfaVerified: true } : null;
  };
  const [rod, erin, marcus, alex, dana] = [await viewerOf("rod"), await viewerOf("erin"), await viewerOf("marcus"), await viewerOf("alex"), await viewerOf("dana")];
  if (!rod || !erin || !marcus) return;
  await ensureDefaultSources(tx, orgId, { isDemo: true });
  const A = ctx.athletes;
  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const fullName = async (personKey: string) => {
    const id = ctx.people[personKey];
    if (!id) return null;
    const [p] = await tx.select({ first: people.firstName, last: people.lastName }).from(people).where(eq(people.id, id));
    return p ? `${p.first} ${p.last}` : null;
  };

  // --- Who is watched ------------------------------------------------------------------------
  // Maya (a minor): her parent, who can sign forms, switched it on. Dana (an adult) decided herself.
  if (alex && A.maya) {
    await setNewsOptIn(tx, alex, A.maya, true, { today });
    await setWatchTerms(tx, marcus, A.maya, { school: "Fictional Falls High School (sample)", sport: "Volleyball", town: "Sampleton" });
  }
  if (dana && A.dana) {
    await setNewsOptIn(tx, dana, A.dana, true, { today });
    await setWatchTerms(tx, erin, A.dana, { school: "Nowhere Track Club (sample)", sport: "Track", town: null });
  }
  // Leo: staff asked the family in the app. No answer yet, so he is not watched.
  if (A.leo) await requestNewsOptIn(tx, erin, A.leo);

  // Two invented alumni, added by staff with a recorded basis.
  const quinn = await createAlumnus(tx, erin, { firstName: "Quinn", lastName: "Madeupson", sport: "Track", college: "Fictional State University (sample)", gradYear: 2025, notes: "Invented demo alumnus.", fullNameOk: false }, { isDemo: true });
  await setAlumniWatch(tx, erin, quinn.id, { watch: true, basis: "Gave permission at alumni day (sample)" }, { today });
  const river = await createAlumnus(tx, erin, { firstName: "River", lastName: "Notarealname", sport: "Soccer", college: "Imaginary College (sample)", gradYear: 2024, notes: "Invented demo alumna. Said the full name is fine.", fullNameOk: true }, { isDemo: true });
  await setAlumniWatch(tx, erin, river.id, { watch: true, basis: "Public college roster (sample)" }, { today });

  // --- Headlines, as a feed would carry them (all invented) ----------------------------------
  const maya = await fullName("maya_parker");
  const danaName = await fullName("dana_brooks");
  const gazette = { id: null, name: "Sampleton Gazette (sample)", isDemo: true };
  const item = (slug: string, headline: string, days: number, snippet: string | null = null, sourceName: string | null = "Sampleton Gazette (sample)"): ParsedItem => ({ headline, link: `https://example.com/sample-news/${slug}`, publishedAt: daysAgo(days), sourceName, sourceUrl: null, snippet });
  const items: ParsedItem[] = [];
  if (maya) {
    items.push(item("volleyball-sweep", `${maya} serves seven aces as Fictional Falls sweeps Makebelieve Central (sample)`, 20, "Invented summary: the Fictional Falls volleyball team won in straight sets on Tuesday."));
    items.push(item("all-area-team", `${maya} named to the Sampleton all-area volleyball team (sample)`, 2));
    items.push(item("county-fair", `${maya} wins the county fair pie contest (sample)`, 3, "Invented summary: a baker from Otherville took the blue ribbon."));
    items.push(item("injury-report", `${maya} out with an ankle injury, coach says (sample)`, 1));
  }
  if (danaName) {
    items.push(item("open-meet", `Nowhere Track Club opens its season (sample)`, 4, `Invented summary: ${danaName} won the 200 meters at the open meet.`));
    items.push(item("council", `${danaName} charged with keeping the city council minutes (sample)`, 5));
  }
  items.push(item("quinn-relay", "Quinn Madeupson anchors Fictional State relay to a conference title (sample)", 40, null, "Fictional State Athletics (sample)"));
  items.push(item("quinn-honor", "Quinn Madeupson earns weekly track honor at Fictional State University (sample)", 2, null, "Fictional State Athletics (sample)"));
  items.push(item("river-goal", "River Notarealname scores twice as Imaginary College wins its opener (sample)", 3, null, "Imaginary College Sports News (sample)"));
  await ingestItems(tx, orgId, gazette, items, await loadWatched(tx, orgId), { now, maxAgeDays: 60 });

  // --- Decisions: one clip in each state -----------------------------------------------------
  const pending = await listClips(tx, rod, { today });
  const clip = (part: string) => pending.find((c) => c.link.endsWith(`/sample-news/${part}`));
  const sweep = clip("volleyball-sweep");
  // Approved by the owner 20 days ago: an "In the news" win on the feed.
  if (sweep) {
    await triageClip(tx, marcus, sweep.id, "ours", { now: daysAgo(20) });
    await approveClip(tx, rod, sweep.id, { today, now: daysAgo(19) });
  }
  // A coach checked this one. It still waits for the owner's approval.
  const allArea = clip("all-area-team");
  if (allArea) await triageClip(tx, marcus, allArea.id, "ours");
  // Someone else with the same name: taught to the matcher.
  const fair = clip("county-fair");
  if (fair) await triageClip(tx, erin, fair.id, "not_ours", { term: "Otherville" });
  // An approved alumni clip (40 days old, so it is in the alumni section but off the TV).
  const relay = clip("quinn-relay");
  if (relay) await approveClip(tx, rod, relay.id, { today, now: daysAgo(39) });
  // Left as suggested: the injury headline (cannot be shared), the "charged" warning, Dana's
  // summary-only match, and two alumni clips.
  ctx.extra.newswatch = { quinnId: quinn.id, riverId: river.id };
}
