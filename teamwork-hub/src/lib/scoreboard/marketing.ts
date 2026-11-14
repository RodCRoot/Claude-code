import { NO_SOURCE, normalizeLeadSource } from "@/lib/crm/lead-vocab";
import { vocabOverrides } from "@/lib/zenplanner/vocab";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { scoreboardMarketingSpend } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { parseMoneyToMinor } from "@/lib/money";
import { addMonths, continuesEarlier, dayEnd, dayStart, membershipCtes, monthEnd, monthLabel, monthStart, num, rowsOf, ymdOf, type Ctx, type Row } from "./core";
import { monthlyScoreboard } from "./monthly";

/**
 * Marketing economics. Spend is typed in by hand per month and channel (no ad-platform
 * integration). Leads and new members come from the CRM and memberships; attribution uses the
 * lead source the CRM already stores. Everything here is GROSS revenue, not profit.
 */

export const MARKETING_DEFINITIONS = [
  { key: "mk_spend", label: "Marketing spend", version: 1, definition: "The amounts entered by hand on this page, per calendar month and channel. Nothing is imported from an ad platform." },
  { key: "mk_leads", label: "Leads by source", version: 2, definition: "Lead records created in the month, grouped by the lead's normalised source: the Source list's own spelling when the stored value is on the list or is an older spelling of one (web inquiry counts as Website, walk in as Walk-in), otherwise the stored text. Leads with no source, or entered by staff without one, are shown as \"No source\". A spend channel is matched to a lead source by name, ignoring case." },
  { key: "mk_cpl", label: "Cost per lead", version: 1, definition: "Spend divided by leads created in the same period, per channel and overall. Blank when there were no leads (never shown as $0)." },
  {
    key: "mk_cpm",
    label: "Cost per new member",
    version: 1,
    definition:
      "Spend divided by new memberships sold in the same period (same rule as the monthly scoreboard: start date in the period, trial products and plan changes excluded). Per channel, a new member belongs to a channel when the athlete was converted from a lead with that source; members with no lead record appear under \"No lead record\". Overall, ALL spend is divided by ALL new members.",
  },
  { key: "mk_arpm", label: "Average monthly revenue per member", version: 1, definition: "Money collected on membership invoices over the complete months in the period divided by the sum of Active clients for those months (member-months). Same building blocks as the monthly scoreboard's Average revenue per member." },
  { key: "mk_loe", label: "Average length of engagement", version: 1, definition: "The monthly scoreboard's Length of engagement for the latest complete month: average whole months from first membership start to today for current members, or to the last membership end for members who left." },
  { key: "mk_ltv", label: "Estimated lifetime revenue per member", version: 1, definition: "Average monthly revenue per member x average length of engagement. An estimate of GROSS revenue: no coaching, rent or other cost is taken off, and current members are still adding months, so it understates long-stayers. It is not profit." },
  { key: "mk_ratio", label: "Lifetime revenue to acquisition cost", version: 1, definition: "Estimated lifetime revenue per member divided by cost per new member (overall). Gross revenue against marketing spend only; it says nothing about profit. Blank when there was no spend or no new members." },
];

const monthSchema = /^\d{4}-(0[1-9]|1[0-2])$/;

export type SpendInput = { month: string; channel: string; amount: string; note?: string | null };

/** Create or replace the spend for one month + channel (owner / admin; audited). */
export async function saveSpend(tx: Tx, v: Viewer, input: SpendInput) {
  assertCan(v, "scoreboard.manage");
  const errors: Record<string, string> = {};
  if (!monthSchema.test(input.month ?? "")) errors.month = "Choose a month";
  const channel = (input.channel ?? "").trim().replace(/\s+/g, " ");
  if (!channel || channel.length > 60) errors.channel = "Enter a channel (60 characters or fewer)";
  const amountMinor = parseMoneyToMinor(String(input.amount ?? ""));
  if (amountMinor == null || amountMinor < 0 || amountMinor > 100_000_000_00) errors.amount = "Enter an amount of 0 or more";
  if (Object.keys(errors).length) throw new UserError("Check the highlighted fields.", errors);
  const month = `${input.month}-01`;
  const note = (input.note ?? "").trim().slice(0, 300) || null;
  const [before] = await tx
    .select()
    .from(scoreboardMarketingSpend)
    .where(and(eq(scoreboardMarketingSpend.orgId, v.orgId), eq(scoreboardMarketingSpend.month, month), sql`lower(${scoreboardMarketingSpend.channel}) = lower(${channel})`))
    .for("update");
  const actor = { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role };
  if (before) {
    await tx.update(scoreboardMarketingSpend).set({ amountMinor: amountMinor!, note, channel, updatedAt: new Date() }).where(eq(scoreboardMarketingSpend.id, before.id));
    await audit(tx, actor, "scoreboard.spend_update", "scoreboard_marketing_spend", before.id, { summary: `Marketing spend ${input.month} ${channel}`, before: { amountMinor: before.amountMinor, note: before.note }, after: { amountMinor, note } });
    return before.id;
  }
  const [row] = await tx.insert(scoreboardMarketingSpend).values({ orgId: v.orgId, month, channel, amountMinor: amountMinor!, note, createdBy: v.userId }).returning();
  await audit(tx, actor, "scoreboard.spend_create", "scoreboard_marketing_spend", row.id, { summary: `Marketing spend ${input.month} ${channel}`, after: { amountMinor, note } });
  return row.id;
}

export async function deleteSpend(tx: Tx, v: Viewer, id: string) {
  assertCan(v, "scoreboard.manage");
  const [row] = await tx.delete(scoreboardMarketingSpend).where(and(eq(scoreboardMarketingSpend.id, id), eq(scoreboardMarketingSpend.orgId, v.orgId))).returning();
  if (!row) throw new UserError("That entry was not found.");
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "scoreboard.spend_delete", "scoreboard_marketing_spend", id, { summary: `Removed marketing spend ${row.month.slice(0, 7)} ${row.channel}`, before: { amountMinor: row.amountMinor } });
}

export async function listSpend(tx: Tx, orgId: string, first: string, last: string) {
  return tx
    .select()
    .from(scoreboardMarketingSpend)
    .where(and(eq(scoreboardMarketingSpend.orgId, orgId), sql`${scoreboardMarketingSpend.month} >= ${first}`, sql`${scoreboardMarketingSpend.month} <= ${last}`))
    .orderBy(sql`${scoreboardMarketingSpend.month} desc`, scoreboardMarketingSpend.channel);
}

/** Lead sources the CRM has stored, for the channel suggestions. */
export async function leadSourceOptions(tx: Tx, orgId: string): Promise<string[]> {
  const overrides = await vocabOverrides(tx, orgId);
  const raw = (await rowsOf<{ source: string }>(tx, sql`select distinct source from leads where org_id = ${orgId} and source is not null and source <> '' order by 1`)).map((r) => r.source);
  return [...new Set(raw.map((r) => normalizeLeadSource(r, overrides).label).filter((l) => l !== NO_SOURCE))].sort();
}

export type ChannelRow = { channel: string; spendMinor: number | null; leads: number; newMembers: number; costPerLeadMinor: number | null; costPerMemberMinor: number | null };
export type MarketingMonth = { month: string; label: string; partial: boolean; spendMinor: number | null; leads: number; newMembers: number; costPerLeadMinor: number | null; costPerMemberMinor: number | null };
export type MarketingEconomics = {
  first: string;
  last: string;
  months: MarketingMonth[];
  channels: ChannelRow[];
  totals: { spendMinor: number | null; leads: number; newMembers: number; costPerLeadMinor: number | null; costPerMemberMinor: number | null };
  arpmMinor: number | null;
  loeMonths: number | null;
  ltvMinor: number | null;
  ratio: number | null;
  entries: Awaited<ReturnType<typeof listSpend>>;
};

const div = (a: number | null, b: number) => (a == null || !b ? null : Math.round(a / b));
const key = (s: string) => s.trim().toLowerCase();

/** Marketing is org-wide: the page filter is ignored here (spend carries no location or program). */
export async function marketingEconomics(tx: Tx, v: Viewer, ctx: Ctx, opts: { months?: number } = {}): Promise<MarketingEconomics> {
  const c: Ctx = { ...ctx, filter: { locationId: null, productId: null }, filtered: false };
  const count = Math.min(24, Math.max(2, opts.months ?? 6));
  const last = monthStart(c.today);
  const first = addMonths(last, -(count - 1));
  const t0 = dayStart(c, first);
  const t1 = dayEnd(c, monthEnd(last));
  const entries = await listSpend(tx, c.orgId, first, last);
  const monthly = await monthlyScoreboard(tx, v, c, { months: count });

  const leadRows = await rowsOf<Row>(
    tx,
    sql`select date_trunc('month', created_at at time zone ${c.tz})::date as m, coalesce(nullif(source, ''), 'No source') as channel, count(*)::int as n
        from leads where org_id = ${c.orgId} and created_at >= ${t0} and created_at < ${t1} group by 1, 2`,
  );
  const memberRows = await rowsOf<Row>(
    tx,
    sql`with ${membershipCtes(c)}
        select date_trunc('month', ms.start_date)::date as m,
          coalesce((select coalesce(nullif(l.source, ''), 'No source') from leads l where l.org_id = ${c.orgId} and l.converted_athlete_id = ms.athlete_id order by l.converted_at desc nulls last limit 1), 'No lead record') as channel,
          count(*)::int as n
        from ms where ms.start_date >= ${first} and ms.start_date <= ${c.today} and not ms.trial_product and not ${continuesEarlier(c, "ms")}
        group by 1, 2`,
  );

  const names = new Map<string, string>();
  const ch = new Map<string, { spend: number | null; leads: number; members: number }>();
  const get = (name: string) => {
    const k = key(name);
    if (!names.has(k)) names.set(k, name);
    if (!ch.has(k)) ch.set(k, { spend: null, leads: 0, members: 0 });
    return ch.get(k)!;
  };
  const spendByMonth = new Map<string, number>();
  // Leads are grouped by the normalised source (lead-vocab.ts): the list's spelling when the stored value is on the
  // Source list or is an older spelling of one ("web_inquiry" is Website), otherwise the stored text tidied up.
  // A spend channel is matched the same way, so "walk-in" spend lines up with Walk-in leads.
  const overrides = await vocabOverrides(tx, c.orgId);
  const chan = (raw: string) => (raw === "No lead record" ? raw : normalizeLeadSource(raw === "No source" ? null : raw, overrides).label);
  const spendChan = (raw: string) => {
    const nrm = normalizeLeadSource(raw, overrides);
    return nrm.onList ? nrm.label : raw;
  };
  for (const e of entries) {
    const g = get(spendChan(e.channel));
    g.spend = (g.spend ?? 0) + e.amountMinor;
    spendByMonth.set(e.month, (spendByMonth.get(e.month) ?? 0) + e.amountMinor);
  }
  const leadsByMonth = new Map<string, number>();
  for (const r of leadRows) {
    get(chan(String(r.channel))).leads += num(r.n);
    leadsByMonth.set(ymdOf(r.m)!, (leadsByMonth.get(ymdOf(r.m)!) ?? 0) + num(r.n));
  }
  const membersByMonth = new Map<string, number>();
  for (const r of memberRows) {
    get(chan(String(r.channel))).members += num(r.n);
    membersByMonth.set(ymdOf(r.m)!, (membersByMonth.get(ymdOf(r.m)!) ?? 0) + num(r.n));
  }

  const months: MarketingMonth[] = [];
  for (let m = first; m <= last; m = addMonths(m, 1)) {
    const spend = spendByMonth.has(m) ? spendByMonth.get(m)! : null;
    const leads = leadsByMonth.get(m) ?? 0;
    const members = membersByMonth.get(m) ?? 0;
    months.push({ month: m, label: monthLabel(m), partial: m === last, spendMinor: spend, leads, newMembers: members, costPerLeadMinor: div(spend, leads), costPerMemberMinor: div(spend, members) });
  }
  const channels: ChannelRow[] = [...ch]
    .map(([k, g]) => ({ channel: names.get(k)!, spendMinor: g.spend, leads: g.leads, newMembers: g.members, costPerLeadMinor: div(g.spend, g.leads), costPerMemberMinor: div(g.spend, g.members) }))
    .sort((a, b) => (b.spendMinor ?? -1) - (a.spendMinor ?? -1) || b.leads - a.leads || a.channel.localeCompare(b.channel));
  const totalSpend = entries.length ? entries.reduce((s, e) => s + e.amountMinor, 0) : null;
  const totalLeads = months.reduce((s, m) => s + m.leads, 0);
  const totalMembers = months.reduce((s, m) => s + m.newMembers, 0);

  // ARPM over complete months = sum(collected on membership invoices) / sum(active clients).
  const complete = monthly.months.filter((m) => !m.partial);
  const memberMonths = complete.reduce((s, m) => s + (m.values.active ?? 0), 0);
  const collected = complete.reduce((s, m) => s + (m.values._membership_collected ?? 0), 0);
  const arpmMinor = memberMonths ? Math.round(collected / memberMonths) : null;
  const loeMonths = complete.length ? (complete[complete.length - 1].values.loe ?? null) : null;
  const ltvMinor = arpmMinor != null && loeMonths != null ? Math.round(arpmMinor * loeMonths) : null;
  const cac = div(totalSpend, totalMembers);
  return {
    first,
    last,
    months,
    channels,
    totals: { spendMinor: totalSpend, leads: totalLeads, newMembers: totalMembers, costPerLeadMinor: div(totalSpend, totalLeads), costPerMemberMinor: cac },
    arpmMinor,
    loeMonths,
    ltvMinor,
    ratio: ltvMinor != null && cac ? Math.round((ltvMinor / cac) * 10) / 10 : null,
    entries,
  };
}
