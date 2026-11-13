import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { importBatches, zpReconciliations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { todayLocal } from "@/lib/time";

/**
 * Reconciliation: the hub's counts beside numbers typed in from Zen Planner's dashboard.
 * The owner's daily report shows these figures drift between Zen Planner's own reports, so a
 * difference is expected; the page shows which hub breakdown would explain it.
 */
export const RECON_FIELDS = [
  { key: "activeMembers", label: "Active members", money: false },
  { key: "memberships", label: "Memberships", money: false },
  { key: "onHold", label: "On hold", money: false },
  { key: "pastDueMinor", label: "Past due total", money: true },
] as const;
export type ReconKey = (typeof RECON_FIELDS)[number]["key"];

export type HubCounts = {
  /** Distinct athletes with a current (active, trial or past due) membership. */
  activeMembers: number;
  /** Current memberships: active, trial, past due and on hold. */
  memberships: number;
  onHold: number;
  /** Unpaid amount on imported Zen Planner bills that are past their due date. Null when no bills were imported. */
  pastDueMinor: number | null;
  // Breakdowns used to explain differences.
  peopleActive: number;
  prospects: number;
  alumni: number;
  activeWithoutMembership: number;
  membersWithSeveralMemberships: number;
  extraMemberships: number;
  pendingMemberships: number;
  pastDueMemberships: number;
  trialMemberships: number;
  hubInvoicesPastDueMinor: number;
  billsImported: number;
  membersByLocation: Record<string, number>;
};

export async function hubCounts(tx: Tx, orgId: string, asOf = todayLocal()): Promise<HubCounts> {
  const one = async (q: ReturnType<typeof sql>) => ((await tx.execute(q)).rows[0] ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => Number(v ?? 0);
  const m = await one(sql`
    select
      count(distinct athlete_id) filter (where status in ('active','trialing','past_due'))::int as active_members,
      count(*) filter (where status in ('active','trialing','past_due','on_hold'))::int as memberships,
      count(*) filter (where status = 'on_hold')::int as on_hold,
      count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'past_due')::int as past_due,
      count(*) filter (where status = 'trialing')::int as trialing
    from memberships where org_id = ${orgId}`);
  const multi = await one(sql`
    select count(*)::int as members, coalesce(sum(c - 1), 0)::int as extra from (
      select athlete_id, count(*) as c from memberships
      where org_id = ${orgId} and status in ('active','trialing','past_due','on_hold') group by athlete_id having count(*) > 1) x`);
  const p = await one(sql`
    select
      count(*) filter (where status = 'active' and archived_at is null)::int as active,
      count(*) filter (where status in ('prospect','lead') and archived_at is null)::int as prospects,
      count(*) filter (where status = 'inactive' and archived_at is null)::int as alumni
    from people where org_id = ${orgId}`);
  const noMembership = await one(sql`
    select count(*)::int as c from athletes a join people p on p.id = a.person_id
    where a.org_id = ${orgId} and p.status = 'active' and p.archived_at is null and a.active
      and not exists (select 1 from memberships m where m.athlete_id = a.id and m.status in ('active','trialing','past_due','on_hold'))`);
  const bills = await one(sql`
    select count(*)::int as c, coalesce(sum(amount_unpaid_minor) filter (where due_date < ${asOf} and amount_unpaid_minor > 0), 0)::bigint as past_due
    from zp_bills where org_id = ${orgId}`);
  const inv = await one(sql`
    select coalesce(sum(total_minor), 0)::bigint as past_due from invoices where org_id = ${orgId} and status = 'open' and due_date < ${asOf}`);
  const loc = await tx.execute(sql`
    select coalesce(d.primary_location, '(no Primary Location)') as loc, count(distinct m.athlete_id)::int as c
    from memberships m join athletes a on a.id = m.athlete_id left join zp_person_details d on d.person_id = a.person_id
    where m.org_id = ${orgId} and m.status in ('active','trialing','past_due') group by 1 order by 2 desc`);
  return {
    activeMembers: n(m.active_members),
    memberships: n(m.memberships),
    onHold: n(m.on_hold),
    pastDueMinor: n(bills.c) > 0 ? n(bills.past_due) : null,
    peopleActive: n(p.active),
    prospects: n(p.prospects),
    alumni: n(p.alumni),
    activeWithoutMembership: n(noMembership.c),
    membersWithSeveralMemberships: n(multi.members),
    extraMemberships: n(multi.extra),
    pendingMemberships: n(m.pending),
    pastDueMemberships: n(m.past_due),
    trialMemberships: n(m.trialing),
    hubInvoicesPastDueMinor: n(inv.past_due),
    billsImported: n(bills.c),
    membersByLocation: Object.fromEntries((loc.rows as { loc: string; c: number }[]).map((r) => [r.loc, Number(r.c)])),
  };
}

export type ReconLine = {
  key: ReconKey;
  label: string;
  money: boolean;
  entered: number | null;
  hub: number | null;
  /** hub minus entered; null when either side is missing. */
  difference: number | null;
  reasons: { text: string; exact: boolean }[];
};

/** Likely reasons for each difference, from the hub's own breakdowns. `exact` = that breakdown equals the gap. */
export function explain(entered: Partial<Record<ReconKey, number | null>>, hub: HubCounts): ReconLine[] {
  return RECON_FIELDS.map((f) => {
    const e = entered[f.key] ?? null;
    const h = hub[f.key];
    const diff = e != null && h != null ? h - e : null;
    const reasons: ReconLine["reasons"] = [];
    const add = (count: number, text: string, direction: 1 | -1 | 0) => {
      if (!count || diff == null || diff === 0) return;
      if (direction !== 0 && Math.sign(diff) !== direction) return;
      reasons.push({ text, exact: Math.abs(diff) === count });
    };
    if (f.key === "activeMembers") {
      add(hub.prospects, `${hub.prospects} prospect(s) are in the hub. Zen Planner's figure is higher by that much if its report counts prospects.`, -1);
      add(hub.alumni, `${hub.alumni} alumni / inactive people are in the hub. Zen Planner's figure is higher by that much if its report includes alumni.`, -1);
      add(hub.activeWithoutMembership, `${hub.activeWithoutMembership} active athlete(s) have no current membership here. A Zen Planner report that counts people by Status instead of by membership includes them.`, -1);
      add(hub.pastDueMemberships, `${hub.pastDueMemberships} membership(s) are past due and counted as active here.`, 1);
      add(hub.trialMemberships, `${hub.trialMemberships} trial membership(s) are counted as active here.`, 1);
      for (const [loc, c] of Object.entries(hub.membersByLocation)) {
        if (Object.keys(hub.membersByLocation).length < 2) break;
        add(hub.activeMembers - c, `Location filter: ${c} of the hub's ${hub.activeMembers} active members have Primary Location "${loc}". A dashboard filtered to that location shows ${c}.`, 1);
      }
    } else if (f.key === "memberships") {
      add(hub.extraMemberships, `${hub.membersWithSeveralMemberships} member(s) hold more than one current membership (${hub.extraMemberships} extra). A count of people is lower by that much.`, 1);
      add(hub.onHold, `${hub.onHold} on-hold membership(s) are included here. A Zen Planner count of active memberships leaves them out.`, 1);
      add(hub.pendingMemberships, `${hub.pendingMemberships} membership(s) start in the future and are not counted here.`, -1);
    } else if (f.key === "onHold") {
      if (diff != null && diff !== 0) reasons.push({ text: "Holds are imported from the Membership grid's Status and hold-date columns. A hold added or ended in Zen Planner after the export, or an export without those columns, shows up as a difference.", exact: false });
    } else if (f.key === "pastDueMinor") {
      if (h == null) reasons.push({ text: "No Zen Planner bills have been imported, so the hub has no past-due figure to compare. Import the Bill grid.", exact: false });
      else if (diff != null && diff !== 0) {
        reasons.push({ text: "The hub's figure is the unpaid amount on imported bills past their due date. Bills paid, written off or added in Zen Planner after the export, or a due-date range that left older bills out, change it.", exact: false });
        if (hub.hubInvoicesPastDueMinor) reasons.push({ text: `Teamwork's own past-due invoices ($${(hub.hubInvoicesPastDueMinor / 100).toFixed(2)}) are not part of this figure.`, exact: false });
      }
    }
    if (diff != null && diff !== 0 && !reasons.length) reasons.push({ text: "No single hub breakdown explains this. Check the filter (location, status, date) on the Zen Planner report the number came from, and whether the export was taken at the same time.", exact: false });
    return { key: f.key, label: f.label, money: f.money, entered: e, hub: h, difference: diff, reasons };
  });
}

export type ReconInput = { batchId?: string | null; asOf?: string | null; entered: Partial<Record<ReconKey, number | null>>; note?: string | null };

export async function saveReconciliation(tx: Tx, v: Viewer, input: ReconInput) {
  assertCan(v, "imports.manage");
  const asOf = input.asOf && /^\d{4}-\d{2}-\d{2}$/.test(input.asOf) ? input.asOf : todayLocal();
  const entered: Record<string, number | null> = {};
  let any = false;
  for (const f of RECON_FIELDS) {
    const val = input.entered[f.key];
    if (val == null) entered[f.key] = null;
    else {
      if (!Number.isInteger(val) || val < 0) throw new UserError(`${f.label}: enter a number that is zero or more.`, { [f.key]: "Zero or more" });
      entered[f.key] = val;
      any = true;
    }
  }
  if (!any) throw new UserError("Type in at least one number from Zen Planner's dashboard.");
  let batchId: string | null = null;
  if (input.batchId) {
    const [b] = await tx.select({ id: importBatches.id }).from(importBatches).where(and(eq(importBatches.id, input.batchId), eq(importBatches.orgId, v.orgId), eq(importBatches.source, "zenplanner")));
    if (!b) throw new UserError("Choose a Zen Planner import from this organization.");
    batchId = b.id;
  }
  const hub = await hubCounts(tx, v.orgId, asOf);
  const { membersByLocation, ...flatHub } = hub;
  const [row] = await tx
    .insert(zpReconciliations)
    .values({ orgId: v.orgId, importBatchId: batchId, asOf, entered, hub: { ...flatHub, ...Object.fromEntries(Object.entries(membersByLocation).map(([k, c]) => [`location:${k}`, c])) }, note: input.note?.trim().slice(0, 500) || null, createdBy: v.userId })
    .returning();
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "zenplanner.reconciliation_saved", "zp_reconciliation", row.id, { summary: `Saved Zen Planner reconciliation as of ${asOf}`, after: { entered } });
  return row;
}

/** Rebuild HubCounts from a saved snapshot. */
export function hubFromSnapshot(s: Record<string, number | null>): HubCounts {
  const membersByLocation: Record<string, number> = {};
  const rest: Record<string, number | null> = {};
  for (const [k, val] of Object.entries(s)) {
    if (k.startsWith("location:")) membersByLocation[k.slice(9)] = Number(val ?? 0);
    else rest[k] = val;
  }
  return { ...(rest as unknown as Omit<HubCounts, "membersByLocation">), membersByLocation };
}

export async function listReconciliations(tx: Tx, v: Viewer, limit = 20) {
  assertCan(v, "imports.manage");
  return tx
    .select({ r: zpReconciliations, filename: importBatches.originalFilename, entityType: importBatches.entityType })
    .from(zpReconciliations)
    .leftJoin(importBatches, eq(importBatches.id, zpReconciliations.importBatchId))
    .where(eq(zpReconciliations.orgId, v.orgId))
    .orderBy(desc(zpReconciliations.createdAt))
    .limit(limit);
}
