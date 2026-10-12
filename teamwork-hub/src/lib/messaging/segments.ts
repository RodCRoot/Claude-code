import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { campaigns, formTemplates, groups, leadStages, products, segments, tags, type SegmentFilters } from "@/db/schema";
import { audit } from "@/lib/audit";
import { AuthzError, assertCan, staffHasHealthAccess, type Viewer } from "@/lib/authz/policy";
import { DomainError } from "./errors";
import { messagingSettings, recipientForPerson, routeForAthlete, type Recipient } from "./routing";

export type { SegmentFilters };
export type Segment = typeof segments.$inferSelect;

export const MEMBERSHIP_STATUSES = ["active", "trialing", "on_hold", "past_due", "pending", "cancelled", "expired", "none"] as const;

const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess((x) => (x === "" || x == null ? undefined : x), s.optional());

export const filtersSchema = z
  .object({
    audience: z.enum(["athletes", "leads"]).default("athletes"),
    recipientRole: opt(z.enum(["guardian", "athlete"])),
    groupId: opt(z.string().uuid()),
    sport: opt(z.string().trim().max(80)),
    membershipStatus: opt(z.enum(MEMBERSHIP_STATUSES)),
    productId: opt(z.string().uuid()),
    athleteActive: opt(z.enum(["active", "inactive"])),
    attendance: z
      .object({ mode: z.enum(["attended", "not_attended"]), days: z.coerce.number().int().min(1).max(365) })
      .optional(),
    missingForm: opt(z.union([z.literal("any"), z.string().uuid()])),
    leadStage: opt(z.string().trim().max(60)),
    tagId: opt(z.string().uuid()),
  })
  .transform((f): SegmentFilters => {
    // Keep only the filters that apply to the audience, so a saved segment means exactly what it shows.
    const out: SegmentFilters = { audience: f.audience };
    if (f.sport) out.sport = f.sport;
    if (f.tagId) out.tagId = f.tagId;
    if (f.audience === "leads") {
      if (f.leadStage) out.leadStage = f.leadStage;
      return out;
    }
    for (const k of ["recipientRole", "groupId", "membershipStatus", "productId", "athleteActive", "attendance", "missingForm"] as const) {
      if (f[k] !== undefined) (out as Record<string, unknown>)[k] = f[k];
    }
    return out;
  });

/** Reads filters from flat form/query fields (`attendanceMode` + `attendanceDays`). */
export function filtersFromFields(get: (k: string) => string | undefined): z.input<typeof filtersSchema> {
  const mode = get("attendanceMode");
  const days = get("attendanceDays");
  return {
    audience: get("audience") === "leads" ? "leads" : "athletes",
    recipientRole: get("recipientRole"),
    groupId: get("groupId"),
    sport: get("sport"),
    membershipStatus: get("membershipStatus"),
    productId: get("productId"),
    athleteActive: get("athleteActive"),
    attendance: (mode === "attended" || mode === "not_attended") && days ? { mode, days: Number(days) } : undefined,
    missingForm: get("missingForm"),
    leadStage: get("leadStage"),
    tagId: get("tagId"),
  } as z.input<typeof filtersSchema>;
}

export function parseFilters(input: unknown): SegmentFilters {
  const r = filtersSchema.safeParse(input);
  if (!r.success) throw new DomainError("Check the segment filters.", Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message])));
  return r.data;
}

/** Options for the filter builder (all org-scoped). */
export async function filterOptions(tx: Tx, v: Viewer) {
  assertCan(v, "crm.manage");
  const health = staffHasHealthAccess(v);
  const [g, p, t, f, st, sports] = await Promise.all([
    tx.select({ id: groups.id, name: groups.name }).from(groups).where(and(eq(groups.orgId, v.orgId), eq(groups.active, true))).orderBy(asc(groups.name)),
    tx.select({ id: products.id, name: products.name }).from(products).where(eq(products.orgId, v.orgId)).orderBy(asc(products.name)),
    tx.select({ id: tags.id, name: tags.name }).from(tags).where(eq(tags.orgId, v.orgId)).orderBy(asc(tags.name)),
    tx
      .select({ id: formTemplates.id, name: formTemplates.name, kind: formTemplates.kind })
      .from(formTemplates)
      .where(and(eq(formTemplates.orgId, v.orgId), eq(formTemplates.active, true)))
      .orderBy(asc(formTemplates.name)),
    tx.select({ key: leadStages.key, label: leadStages.label }).from(leadStages).where(eq(leadStages.orgId, v.orgId)).orderBy(asc(leadStages.sortOrder)),
    tx.execute(sql`select distinct sport from athletes where org_id = ${v.orgId} and sport is not null order by sport`),
  ]);
  return {
    groups: g,
    products: p,
    tags: t,
    // Medical forms are health data: only offered to staff with health access.
    forms: f.filter((x) => health || x.kind !== "medical"),
    stages: st,
    sports: (sports.rows as { sport: string }[]).map((r) => r.sport),
    healthAccess: health,
  };
}

/** Why a filter set touches health data (a medical form), or null. */
export async function healthReason(tx: Tx, orgId: string, f: SegmentFilters): Promise<string | null> {
  if (!f.missingForm || f.missingForm === "any") return null;
  const [t] = await tx.select({ kind: formTemplates.kind, name: formTemplates.name }).from(formTemplates).where(and(eq(formTemplates.id, f.missingForm), eq(formTemplates.orgId, orgId)));
  return t?.kind === "medical" ? `filters on the medical form "${t.name}"` : null;
}

/** Throws unless the viewer may use these filters (health-data filters need health access). */
export async function assertFiltersAllowed(tx: Tx, v: Viewer, f: SegmentFilters) {
  const why = await healthReason(tx, v.orgId, f);
  if (why && !staffHasHealthAccess(v)) throw new AuthzError(`This segment ${why}, which is health data. Ask an owner or admin.`);
}

/** Every id in the filters must belong to the viewer's org. */
async function validateRefs(tx: Tx, orgId: string, f: SegmentFilters) {
  const check = async (ok: boolean, field: string) => {
    if (!ok) throw new DomainError("Choose a valid option.", { [field]: "Not found" });
  };
  if (f.groupId) await check(!!(await tx.select({ id: groups.id }).from(groups).where(and(eq(groups.id, f.groupId), eq(groups.orgId, orgId))))[0], "groupId");
  if (f.productId) await check(!!(await tx.select({ id: products.id }).from(products).where(and(eq(products.id, f.productId), eq(products.orgId, orgId))))[0], "productId");
  if (f.tagId) await check(!!(await tx.select({ id: tags.id }).from(tags).where(and(eq(tags.id, f.tagId), eq(tags.orgId, orgId))))[0], "tagId");
  if (f.missingForm && f.missingForm !== "any") {
    await check(!!(await tx.select({ id: formTemplates.id }).from(formTemplates).where(and(eq(formTemplates.id, f.missingForm), eq(formTemplates.orgId, orgId))))[0], "missingForm");
  }
  if (f.leadStage) await check(!!(await tx.select({ id: leadStages.id }).from(leadStages).where(and(eq(leadStages.key, f.leadStage), eq(leadStages.orgId, orgId))))[0], "leadStage");
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type SegmentRecipient = {
  recipient: Recipient;
  athleteIds: string[];
  athleteNames: string[];
  athleteFirstNames: string[];
  leadId: string | null;
  leadFirstName: string | null;
};

export type SegmentResult = {
  audience: SegmentFilters["audience"];
  /** Athletes (or leads) that match the filters, before routing. */
  matched: number;
  recipients: SegmentRecipient[];
  /** People not messaged even though their athlete matched, and why. */
  excluded: { name: string; reason: string; about: string }[];
};

async function matchingAthletes(tx: Tx, orgId: string, f: SegmentFilters, now: Date): Promise<string[]> {
  const c = [sql`a.org_id = ${orgId}`, sql`p.archived_at is null`];
  if (f.athleteActive === "active") c.push(sql`a.active = true`);
  if (f.athleteActive === "inactive") c.push(sql`a.active = false`);
  if (f.sport) c.push(sql`lower(a.sport) = lower(${f.sport})`);
  if (f.groupId) c.push(sql`exists (select 1 from group_members gm where gm.athlete_id = a.id and gm.group_id = ${f.groupId})`);
  if (f.membershipStatus === "none") {
    c.push(sql`not exists (select 1 from memberships m where m.athlete_id = a.id and m.status in ('active','trialing','on_hold','past_due','pending'))`);
  } else if (f.membershipStatus || f.productId) {
    c.push(sql`exists (select 1 from memberships m join product_versions pv on pv.id = m.product_version_id where m.athlete_id = a.id and m.org_id = ${orgId}
      ${f.membershipStatus ? sql`and m.status = ${f.membershipStatus}` : sql``}
      ${f.productId ? sql`and pv.product_id = ${f.productId}` : sql``})`);
  }
  if (f.attendance) {
    const since = new Date(now.getTime() - f.attendance.days * 86_400_000);
    const attended = sql`exists (select 1 from bookings b join schedule_sessions s on s.id = b.session_id where b.athlete_id = a.id and b.status = 'attended' and s.starts_at >= ${since} and s.starts_at <= ${now})`;
    c.push(f.attendance.mode === "attended" ? attended : sql`not ${attended}`);
  }
  if (f.missingForm) {
    c.push(sql`exists (select 1 from form_requests fr
      join form_template_versions fv on fv.id = fr.template_version_id
      join form_templates ft on ft.id = fv.template_id
      where fr.org_id = ${orgId} and fr.status in ('pending','partially_signed')
        and (fr.athlete_id = a.id or fr.subject_person_id = a.person_id)
        and ${f.missingForm === "any" ? sql`ft.kind <> 'medical'` : sql`ft.id = ${f.missingForm}`})`);
  }
  if (f.tagId) {
    c.push(sql`exists (select 1 from person_tags pt where pt.tag_id = ${f.tagId} and (pt.person_id = a.person_id
      or pt.person_id in (select g.guardian_person_id from guardianships g where g.athlete_id = a.id and g.status = 'active')))`);
  }
  const res = await tx.execute(sql`select a.id from athletes a join people p on p.id = a.person_id where ${sql.join(c, sql` and `)} order by p.last_name, p.first_name limit 5000`);
  return (res.rows as { id: string }[]).map((r) => r.id);
}

async function matchingLeads(tx: Tx, orgId: string, f: SegmentFilters) {
  const c = [sql`l.org_id = ${orgId}`];
  if (f.leadStage) c.push(sql`l.stage = ${f.leadStage}`);
  else c.push(sql`l.converted_at is null and not exists (select 1 from lead_stages s where s.org_id = l.org_id and s.key = l.stage and (s.is_won or s.is_lost))`);
  if (f.sport) c.push(sql`lower(l.interest) = lower(${f.sport})`);
  if (f.tagId) c.push(sql`exists (select 1 from person_tags pt where pt.tag_id = ${f.tagId} and (pt.person_id = l.person_id or pt.person_id = l.contact_person_id))`);
  const res = await tx.execute(sql`select l.id, l.person_id, l.contact_person_id, p.first_name from leads l join people p on p.id = l.person_id where ${sql.join(c, sql` and `)} order by l.created_at limit 5000`);
  return res.rows as { id: string; person_id: string; contact_person_id: string | null; first_name: string }[];
}

/**
 * Who a segment reaches right now: athletes matched by the filters → guardian routing (minors →
 * each active guardian allowed to message; adults → themselves) → optional recipient-role filter,
 * deduplicated per person. Leads → the lead contact. Consent / quiet hours are applied later, per
 * channel (see campaign preview and delivery).
 */
export async function resolveSegment(tx: Tx, orgId: string, f: SegmentFilters, now = new Date()): Promise<SegmentResult> {
  const byPerson = new Map<string, SegmentRecipient>();
  const excluded: SegmentResult["excluded"] = [];
  if (f.audience === "leads") {
    const ls = await matchingLeads(tx, orgId, f);
    for (const l of ls) {
      const r = await recipientForPerson(tx, orgId, l.contact_person_id ?? l.person_id, "lead_contact");
      if (!r) continue;
      if (!byPerson.has(r.personId)) byPerson.set(r.personId, { recipient: r, athleteIds: [], athleteNames: [], athleteFirstNames: [], leadId: l.id, leadFirstName: l.first_name });
    }
    return { audience: "leads", matched: ls.length, recipients: [...byPerson.values()], excluded };
  }
  const ids = await matchingAthletes(tx, orgId, f, now);
  const s = await messagingSettings(tx, orgId);
  for (const id of ids) {
    const route = await routeForAthlete(tx, orgId, id, s);
    if (!route) continue;
    const about = `${route.athleteFirstName} ${route.athleteLastName}`;
    const rs = route.recipients.filter((r) => !f.recipientRole || r.role === f.recipientRole);
    for (const e of route.excluded) excluded.push({ name: e.name, reason: e.reason, about });
    if (!route.recipients.length) excluded.push({ name: about, reason: "No one can receive messages about this athlete", about });
    for (const r of rs) {
      const cur = byPerson.get(r.personId);
      if (cur) {
        cur.athleteIds.push(id);
        cur.athleteNames.push(about);
        cur.athleteFirstNames.push(route.athleteFirstName);
      } else {
        byPerson.set(r.personId, { recipient: r, athleteIds: [id], athleteNames: [about], athleteFirstNames: [route.athleteFirstName], leadId: null, leadFirstName: null });
      }
    }
  }
  // De-duplicate identical exclusion lines (e.g. the same athlete matched through two filters).
  const finalExcluded = excluded.filter((e, i, arr) => arr.findIndex((x) => x.name === e.name && x.about === e.about && x.reason === e.reason) === i);
  return { audience: "athletes", matched: ids.length, recipients: [...byPerson.values()], excluded: finalExcluded };
}

/** "Maya", "Maya and Eli", "Maya, Eli and Ava". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

const segmentSchema = z.object({
  name: z.string().trim().min(1, "Name the segment").max(120),
  description: z.preprocess((x) => (x === "" ? undefined : x), z.string().trim().max(500).optional()),
  filters: z.unknown(),
});

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

export async function getSegment(tx: Tx, v: Viewer, id: string): Promise<Segment> {
  assertCan(v, "crm.manage");
  if (!z.string().uuid().safeParse(id).success) throw new DomainError("Segment not found.");
  const [s] = await tx.select().from(segments).where(and(eq(segments.id, id), eq(segments.orgId, v.orgId)));
  if (!s) throw new DomainError("Segment not found.");
  return s;
}

/** Segments with live counts. Counts of health-data segments are hidden from staff without health access. */
export async function listSegments(tx: Tx, v: Viewer, now = new Date()) {
  assertCan(v, "crm.manage");
  const rows = await tx
    .select()
    .from(segments)
    .where(and(eq(segments.orgId, v.orgId), isNull(segments.archivedAt)))
    .orderBy(asc(segments.name));
  const out = [];
  for (const s of rows) {
    const health = await healthReason(tx, v.orgId, s.filters);
    const restricted = !!health && !staffHasHealthAccess(v);
    const res = restricted ? null : await resolveSegment(tx, v.orgId, s.filters, now);
    out.push({ segment: s, restricted, healthReason: health, matched: res?.matched ?? null, recipients: res?.recipients.length ?? null });
  }
  return out;
}

export async function previewSegment(tx: Tx, v: Viewer, filters: SegmentFilters, now = new Date()) {
  assertCan(v, "crm.manage");
  await assertFiltersAllowed(tx, v, filters);
  await validateRefs(tx, v.orgId, filters);
  return resolveSegment(tx, v.orgId, filters, now);
}

export async function createSegment(tx: Tx, v: Viewer, input: z.input<typeof segmentSchema>) {
  assertCan(v, "crm.manage");
  const d = segmentSchema.parse(input);
  const filters = parseFilters(d.filters);
  await assertFiltersAllowed(tx, v, filters);
  await validateRefs(tx, v.orgId, filters);
  const [row] = await tx.insert(segments).values({ orgId: v.orgId, name: d.name, description: d.description ?? null, filters, createdByUserId: v.userId }).returning();
  await audit(tx, actor(v), "messaging.segment_created", "segment", row.id, { summary: `Created segment "${row.name}"`, after: { filters } });
  return row;
}

export async function updateSegment(tx: Tx, v: Viewer, id: string, input: z.input<typeof segmentSchema>) {
  const before = await getSegment(tx, v, id);
  await assertFiltersAllowed(tx, v, before.filters);
  const d = segmentSchema.parse(input);
  const filters = parseFilters(d.filters);
  await assertFiltersAllowed(tx, v, filters);
  await validateRefs(tx, v.orgId, filters);
  const active = await tx
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(and(eq(campaigns.segmentId, id), inArray(campaigns.status, ["pending_approval", "approved", "sending"])));
  if (active.length) throw new DomainError(`"${active[0].name}" is awaiting approval or sending with this segment. Cancel it or return it to draft first.`);
  await tx.update(segments).set({ name: d.name, description: d.description ?? null, filters, updatedAt: new Date() }).where(eq(segments.id, id));
  await audit(tx, actor(v), "messaging.segment_updated", "segment", id, { before: { name: before.name, filters: before.filters }, after: { name: d.name, filters } });
}

export async function archiveSegment(tx: Tx, v: Viewer, id: string) {
  const s = await getSegment(tx, v, id);
  const active = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.segmentId, id), inArray(campaigns.status, ["draft", "pending_approval", "approved", "sending"])));
  if (active.length) throw new DomainError("Campaigns still use this segment. Cancel or finish them first.");
  await tx.update(segments).set({ archivedAt: new Date() }).where(eq(segments.id, s.id));
  await audit(tx, actor(v), "messaging.segment_archived", "segment", s.id, { summary: `Archived segment "${s.name}"` });
}

/** Human-readable summary of filters for lists. */
export function describeFilters(f: SegmentFilters, names: { groups?: Map<string, string>; products?: Map<string, string>; tags?: Map<string, string>; forms?: Map<string, string> } = {}): string {
  const parts: string[] = [f.audience === "leads" ? "Open leads" : "Athletes"];
  if (f.athleteActive) parts.push(f.athleteActive);
  if (f.sport) parts.push(`sport: ${f.sport}`);
  if (f.groupId) parts.push(`group: ${names.groups?.get(f.groupId) ?? "?"}`);
  if (f.membershipStatus) parts.push(f.membershipStatus === "none" ? "no current membership" : `membership: ${f.membershipStatus.replace("_", " ")}`);
  if (f.productId) parts.push(`product: ${names.products?.get(f.productId) ?? "?"}`);
  if (f.attendance) parts.push(`${f.attendance.mode === "attended" ? "attended" : "no attendance"} in last ${f.attendance.days} days`);
  if (f.missingForm) parts.push(f.missingForm === "any" ? "missing a form" : `missing: ${names.forms?.get(f.missingForm) ?? "a form"}`);
  if (f.leadStage) parts.push(`stage: ${f.leadStage.replace(/_/g, " ")}`);
  if (f.tagId) parts.push(`tag: ${names.tags?.get(f.tagId) ?? "?"}`);
  if (f.recipientRole) parts.push(f.recipientRole === "guardian" ? "→ guardians only" : "→ adult athletes only");
  return parts.join(" · ");
}
