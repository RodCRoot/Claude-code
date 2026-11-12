/**
 * "Leads to check": something a staff member heard, or a link they pasted by hand. A lead is a
 * staff-only note. It becomes a draft win attached to an athlete, and that draft is shown to
 * nobody but the athlete's own family until they confirm it and staff then approve it.
 *
 * Nothing here fetches the link, searches the web or reads a social feed. See the "Not built"
 * section of docs/modules/wins.md for why, and for what a consented, reviewed search would need.
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, people, users, winLeads, type WinLeadStatus } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { accessibleAthleteIds, assertCan, AuthzError, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { actorOf } from "./access";
import { bannedTopic, cleanSourceUrl, LEAD_NOTE_MAX, oneLine } from "./shared";
import { submitWin, type Win } from "./wins";

export type Lead = typeof winLeads.$inferSelect;
export type LeadView = { id: string; note: string; sourceUrl: string | null; athleteId: string | null; athleteName: string | null; status: WinLeadStatus; winId: string | null; createdBy: string | null; createdAt: Date };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Add a lead. Any staff member; an attached athlete must be in their scope. */
export async function addLead(tx: Tx, v: Viewer, input: { note: unknown; sourceUrl?: unknown; athleteId?: string | null }): Promise<Lead> {
  assertCan(v, "wins.review");
  const note = oneLine(input.note);
  if (note.length < 3) throw new UserError("Add a short note about what you heard.", { note: "Required" });
  if (note.length > LEAD_NOTE_MAX) throw new UserError(`Keep the note to ${LEAD_NOTE_MAX} characters or fewer.`, { note: "Too long" });
  const topic = bannedTopic(note);
  if (topic) throw new UserError(`Leads cannot mention ${topic}. Keep the note to the achievement itself.`, { note: `Remove the mention of ${topic}` });
  const src = cleanSourceUrl(input.sourceUrl);
  if (src.error) throw new UserError(src.error, { sourceUrl: src.error });
  const athleteId = input.athleteId && uuid.test(input.athleteId) ? input.athleteId : null;
  let isDemo = false;
  if (athleteId) {
    await requireOnAthlete(tx, v, athleteId, "profile.read");
    const [a] = await tx.select({ isDemo: athletes.isDemo }).from(athletes).where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
    isDemo = a?.isDemo ?? false;
  }
  const [row] = await tx.insert(winLeads).values({ orgId: v.orgId, note, sourceUrl: src.url, athleteId, createdBy: v.userId, isDemo }).returning();
  await audit(tx, actorOf(v), "wins.lead.add", "win_lead", row.id, { summary: "Win lead added by staff", after: { athleteId, hasLink: !!src.url } });
  return row;
}

async function leadForUpdate(tx: Tx, v: Viewer, leadId: string): Promise<Lead> {
  assertCan(v, "wins.review");
  if (!uuid.test(leadId)) throw new AuthzError("Lead not found.");
  const [lead] = await tx.select().from(winLeads).where(and(eq(winLeads.id, leadId), eq(winLeads.orgId, v.orgId))).for("update");
  if (!lead) throw new AuthzError("Lead not found.");
  // Coaches work their own leads and leads about athletes they coach.
  if (v.role === "coach" && lead.createdBy !== v.userId) {
    if (!lead.athleteId) throw new AuthzError();
    await requireOnAthlete(tx, v, lead.athleteId, "profile.read");
  }
  return lead;
}

/**
 * Turn a lead into a draft win for one athlete. The draft is "awaiting_family": the athlete or a
 * guardian who can act for them confirms or declines it in the app. No message is sent.
 */
export async function convertLead(tx: Tx, v: Viewer, leadId: string, raw: Record<string, unknown>, opts: { today?: string } = {}): Promise<Win> {
  const lead = await leadForUpdate(tx, v, leadId);
  if (lead.status !== "open") throw new UserError("This lead was already handled.");
  const win = await submitWin(tx, v, { ...raw, athleteId: raw.athleteId || lead.athleteId, sourceUrl: lead.sourceUrl ?? undefined }, { today: opts.today, draftFromLead: true });
  await tx.update(winLeads).set({ status: "converted", winId: win.id, athleteId: win.athleteId, closedAt: new Date(), closedBy: v.userId }).where(eq(winLeads.id, lead.id));
  await audit(tx, actorOf(v), "wins.lead.convert", "win_lead", lead.id, { summary: "Lead turned into a draft win awaiting family confirmation", after: { winId: win.id, athleteId: win.athleteId } });
  return win;
}

export async function dismissLead(tx: Tx, v: Viewer, leadId: string): Promise<void> {
  const lead = await leadForUpdate(tx, v, leadId);
  if (lead.status !== "open") return;
  await tx.update(winLeads).set({ status: "dismissed", closedAt: new Date(), closedBy: v.userId }).where(eq(winLeads.id, lead.id));
  await audit(tx, actorOf(v), "wins.lead.dismiss", "win_lead", lead.id, { summary: "Win lead dismissed" });
}

/** Leads the viewer may see: owner, admin and operations all of them; a coach their own and their athletes'. */
export async function listLeads(tx: Tx, v: Viewer, opts: { status?: WinLeadStatus; limit?: number } = {}): Promise<LeadView[]> {
  assertCan(v, "wins.review");
  const scope = await accessibleAthleteIds(tx, v, "profile.read");
  const mine = scope === "all" ? undefined : or(eq(winLeads.createdBy, v.userId), scope.length ? inArray(winLeads.athleteId, scope) : undefined);
  const rows = await tx
    .select({ l: winLeads, first: people.firstName, preferred: people.preferredName, last: people.lastName, by: users.displayName })
    .from(winLeads)
    .leftJoin(athletes, eq(athletes.id, winLeads.athleteId))
    .leftJoin(people, eq(people.id, athletes.personId))
    .leftJoin(users, eq(users.id, winLeads.createdBy))
    .where(and(eq(winLeads.orgId, v.orgId), opts.status ? eq(winLeads.status, opts.status) : undefined, mine))
    .orderBy(desc(winLeads.createdAt))
    .limit(opts.limit ?? 100);
  const inScope = (id: string | null) => !id || scope === "all" || scope.includes(id);
  return rows.map((r) => ({
    id: r.l.id,
    note: r.l.note,
    sourceUrl: r.l.sourceUrl,
    athleteId: r.l.athleteId,
    // A coach's own lead may name an athlete they no longer coach: the name is withheld then.
    athleteName: r.l.athleteId && r.first && inScope(r.l.athleteId) ? `${r.preferred ?? r.first} ${r.last}` : null,
    status: r.l.status,
    winId: r.l.winId,
    createdBy: r.by,
    createdAt: r.l.createdAt,
  }));
}
