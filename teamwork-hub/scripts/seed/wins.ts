import { eq } from "drizzle-orm";
import { users } from "../../src/db/schema";
import type { Viewer } from "../../src/lib/authz/policy";
import { addTeamEvents, createTeam, setTeamAthletes } from "../../src/lib/wins/calendar";
import { answerMarketingConsent, requestMarketingConsent } from "../../src/lib/wins/consent";
import { addLead, convertLead } from "../../src/lib/wins/leads";
import { markPosted } from "../../src/lib/wins/marketing";
import { approveWin, submitWin } from "../../src/lib/wins/wins";
import { addDaysYmd } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * Synthetic Wins and Competitions demo data, written through the real paths (scope checks,
 * approval, consent ledger, XP). School, club and college names are invented and say so.
 * Every step is skipped when the rows it needs were not seeded.
 */
export async function seedWins(ctx: SeedCtx) {
  const { tx, orgId, today } = ctx;
  const viewerOf = async (userKey: string): Promise<Viewer | null> => {
    const id = ctx.users[userKey];
    if (!id) return null;
    const [u] = await tx.select().from(users).where(eq(users.id, id));
    return u ? { userId: u.id, orgId, role: u.role, personId: u.personId, displayName: u.displayName, mfaVerified: true } : null;
  };
  const [rod, erin, marcus, tess, alex, sam, dana, maya] = [await viewerOf("rod"), await viewerOf("erin"), await viewerOf("marcus"), await viewerOf("tess"), await viewerOf("alex"), await viewerOf("sam"), await viewerOf("dana"), await viewerOf("maya")];
  if (!rod || !erin || !marcus || !tess) return;
  const A = ctx.athletes;
  const day = (n: number) => addDaysYmd(today, n);
  const ids = (...keys: string[]) => keys.map((k) => A[k]).filter(Boolean);

  // --- Team schedules: entered once by staff, attached to several athletes -------------------
  const team = async (v: Viewer, name: string, sport: string, kind: "school" | "club", kindOf: string, lines: string[], athletes: string[]) => {
    const t = await createTeam(tx, v, { name, sport, kind, seasonLabel: "Sample season" });
    await addTeamEvents(tx, v, { teamId: t.id, kind: kindOf, lines: lines.join("\n") });
    await setTeamAthletes(tx, v, t.id, athletes);
    return t.id;
  };
  const volleyball = await team(marcus, "Fictional Falls High School Volleyball (sample)", "Volleyball", "school", "game", [`${day(1)}, 18:30, Makebelieve Central (sample), Home`, `${day(4)}, 19:00, Notreal North (sample), Away`, `${day(9)}, 18:30, Pretend Prep (sample), Home`, `${day(16)}, 19:00, Invented East (sample), Away`], ids("maya", "sofia", "zoe"));
  await team(marcus, "Imaginary Ironmen Football (sample)", "Football", "school", "game", [`${day(2)}, 19:00, Fabled Valley (sample), Home`, `${day(8)}, 19:00, Storybook South (sample), Away`], ids("leo", "ethan", "mason"));
  await team(tess, "Sampleton Storm Soccer Club (sample)", "Soccer", "club", "tournament", [`${day(1)}, 09:00, Fall Classic (sample), Sampleton Fields`, `${day(5)}, 10:00, Fictional Cup (sample), Away`, `${day(12)}, 09:00, Pretend Invitational (sample), Away`], ids("eli", "ava", "owen"));
  await team(rod, "Nowhere Track Club (sample)", "Track & Field", "club", "meet", [`${day(3)}, 10:00, Open Meet (sample), Nowhere Stadium`, `${day(10)}, 10:00, Indoor Opener (sample), Away`], ids("dana", "jackson"));

  // --- Wins --------------------------------------------------------------------------------
  const win = async (by: Viewer | null, key: string, n: number, type: string, sport: string, headline: string, detail: string | null = null, extra: Record<string, unknown> = {}) => {
    if (!by || !A[key]) return null;
    return submitWin(tx, by, { athleteId: A[key], occurredOn: day(n), sport, type, headline, detail, ...extra }, { today });
  };
  const approve = async (by: Viewer, w: { id: string } | null, daysAgo = 0) => (w ? approveWin(tx, by, { winId: w.id }, { today, now: new Date(Date.now() - daysAgo * 86_400_000 - 3_600_000) }) : null);

  // Maya: submitted by her parent, approved, marketing consent given by the parent. Ready to post.
  const w1 = await approve(marcus, await win(alex, "maya", -3, "selection", "Volleyball", "Named to the all-conference second team (sample)", "Voted by the conference coaches after the regular season. (sample)"), 1);
  if (w1 && alex) await answerMarketingConsent(tx, alex, w1.id, "grant", { today });

  // Leo: college commitment, approved. Staff asked the family about marketing; no answer yet.
  const w2 = await approve(marcus, await win(sam, "leo", -6, "commitment", "Football", "Committed to play football at Fictional State University (sample)"), 2);
  if (w2) await requestMarketingConsent(tx, erin, w2.id, { today });

  // Dana: an adult consents for herself; staff noted it was posted.
  const w3 = await approve(marcus, await win(dana, "dana", -10, "personal_best", "Track & Field", "New 200 m personal best at the Nowhere Open (sample)"), 6);
  if (w3 && dana) {
    await answerMarketingConsent(tx, dana, w3.id, "grant", { today });
    await markPosted(tx, erin, { winId: w3.id, channel: "instagram", postedOn: day(-4) }, { today });
  }

  // Staff-entered wins for athletes whose families have no demo login.
  await approve(marcus, await win(marcus, "ethan", -2, "placing", "Football", "Two touchdowns in the Imaginary Ironmen home win (sample)"), 1);
  await approve(marcus, await win(marcus, "zoe", -8, "team_championship", "Softball", "Fall league champions with the Pretend Pines (sample)"), 5);
  await approve(marcus, await win(marcus, "liam", -5, "character", "Basketball", "Voted team captain by his teammates (sample)"), 3);
  await approve(tess, await win(tess, "harper", -12, "placing", "Volleyball", "Third place at the Fictional Fall Classic (sample)"), 9);

  // Eli is hidden from other families: approved, and still never on the feed, the TV or in marketing.
  await approve(tess, await win(alex, "eli", -4, "placing", "Soccer", "Scored the winner in the Sampleton Storm semifinal (sample)"), 2);

  // Waiting for staff review: one from the athlete's own login, one from a coach.
  await win(maya, "maya", -1, "personal_best", "Volleyball", "Career high 14 kills against Makebelieve Central (sample)");
  await win(tess, "aria", -2, "placing", "Tennis", "Won her flight at the Storybook Open (sample)");

  // --- Leads to check ------------------------------------------------------------------------
  if (A.sofia) await addLead(tx, marcus, { note: "Heard Sofia made the all-conference team. Check with the family. (sample)", athleteId: A.sofia });
  await addLead(tx, erin, { note: "A parent mentioned a team from our gym won a weekend tournament. Find out who. (sample)", sourceUrl: "https://news.example.test/sample-article" });
  if (A.maya) {
    const lead = await addLead(tx, marcus, { note: "Maya's team won its sectional opener, per the school announcement. (sample)", athleteId: A.maya });
    await convertLead(tx, marcus, lead.id, { athleteId: A.maya, occurredOn: day(-2), sport: "Volleyball", type: "placing", headline: "Sectional opener win with Fictional Falls (sample)" }, { today });
  }
  ctx.extra.wins = { volleyballTeamId: volleyball, ...(w1 ? { mayaWinId: w1.id } : {}), ...(w2 ? { leoWinId: w2.id } : {}), ...(w3 ? { danaWinId: w3.id } : {}) };
}
