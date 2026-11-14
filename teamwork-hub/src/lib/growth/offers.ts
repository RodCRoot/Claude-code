import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, offerDismissals, offerEvents, people, tasks, type OfferKey } from "@/db/schema";
import { AuthzError, can, canOnAthlete, payerAccountIdsFor, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { listCatalog } from "@/lib/billing/catalog";
import { UserError } from "@/lib/billing/errors";
import { actorOf } from "@/lib/billing/util";
import { policyFromSettings } from "@/lib/membership-policy";
import { formatMoney } from "@/lib/money";
import { addDaysYmd, DEFAULT_TZ, fmtDate, startOfWeekYmd } from "@/lib/time";
import { growthFromSettings, type GrowthSettings } from "./settings";
import { familyName, shopItems } from "./shop";

/**
 * Helpful offers: plain rules over facts already in the system. Every offer carries the evidence
 * that triggered it, every dollar figure comes from the catalog, and nothing is predicted or scored.
 * Each rule only fires when the thing it would suggest actually exists in the catalog.
 */
export type Offer = {
  key: OfferKey;
  athleteId: string;
  personId: string;
  athleteName: string;
  payerAccountId: string | null;
  membershipId: string | null;
  /** Staff heading. */
  title: string;
  /** One or two plain sentences for the family (no pressure, no dashes). */
  familyText: string;
  /** The facts that triggered the rule. */
  evidence: string[];
  /** Estimates only, from catalog list prices. Null when no honest figure exists. */
  estMonthlyMinor: number | null;
  estOneTimeMinor: number | null;
  estBasis: string;
  currency: string;
  /** False when the suggestion depends on something an owner has not confirmed yet. */
  familyVisible: boolean;
  familyCta: { label: string; href: string };
  staffAction: { label: string; href: string };
};

export const OFFER_LABEL: Record<OfferKey, string> = {
  weekly_cap: "Using every class on the plan",
  credits_low: "Session pack running low",
  commitment_savings: "Commitment plan savings",
  sibling_discount: "Sibling not enrolled",
  assessment_due: "Baseline test due",
  in_season_ending: "In Season ending soon",
};

/** Which suggestion a family sees first when several apply (time-sensitive first). */
const FAMILY_PRIORITY: OfferKey[] = ["in_season_ending", "credits_low", "weekly_cap", "assessment_due", "commitment_savings", "sibling_discount"];

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: Tx, q: ReturnType<typeof sql>) => (await tx.execute(q)).rows as T[];
const num = (v: unknown) => Number(v ?? 0);

const monthly = (priceMinor: number, interval: string, count: number) =>
  interval === "month" ? Math.round(priceMinor / count) : interval === "week" ? Math.round((priceMinor * 52) / 12 / count) : interval === "year" ? Math.round(priceMinor / 12 / count) : 0;

const isInSeasonProduct = (p: { name: string; category: string | null }) => /in[\s-]?season/i.test(`${p.category ?? ""} ${p.name}`);

type LiveMembership = {
  id: string;
  athlete_id: string;
  payer_account_id: string | null;
  kind: string;
  status: string;
  start_date: string;
  end_date: string | null;
  price_minor: string;
  currency: string;
  interval: string;
  interval_count: number;
  classes_per_week: number | null;
  unlimited: boolean;
  commitment_months: number;
  product_id: string;
  product_name: string;
};

export async function computeOffers(tx: Tx, orgId: string, opts: { today: string; now?: Date; athleteIds?: string[]; settings?: GrowthSettings }): Promise<Offer[]> {
  const now = opts.now ?? new Date();
  const T = opts.today;
  if (opts.athleteIds && !opts.athleteIds.length) return [];
  const [org] = await rows<{ settings: Record<string, unknown>; currency: string }>(tx, sql`select settings, currency from organizations where id = ${orgId}`);
  if (!org) return [];
  const settings = opts.settings ?? growthFromSettings(org.settings);
  const cfg = settings.offers;
  const policy = policyFromSettings(org.settings);
  const scope = opts.athleteIds ? sql`and a.id in ${opts.athleteIds}` : sql``;

  const athleteRows = await rows<{ id: string; person_id: string; first_name: string; last_name: string }>(
    tx,
    sql`select a.id, a.person_id, coalesce(p.preferred_name, p.first_name) as first_name, p.last_name
        from athletes a join people p on p.id = a.person_id where a.org_id = ${orgId} and a.active ${scope}`,
  );
  const A = new Map(athleteRows.map((a) => [a.id, a]));
  if (!A.size) return [];
  const live = (
    await rows<LiveMembership>(
      tx,
      sql`select m.id, m.athlete_id, m.payer_account_id, m.kind, m.status, m.start_date, m.end_date,
            pv.price_minor, pv.currency, pv.interval, pv.interval_count, pv.classes_per_week, pv.unlimited, pv.commitment_months,
            p.id as product_id, p.name as product_name
          from memberships m join product_versions pv on pv.id = m.product_version_id join products p on p.id = pv.product_id
            join athletes a on a.id = m.athlete_id
          where m.org_id = ${orgId} and m.status in ('active','trialing') and m.start_date <= ${T} and (m.end_date is null or m.end_date >= ${T}) ${scope}`,
    )
  ).filter((m) => A.has(m.athlete_id));
  const catalog = (await listCatalog(tx, orgId, T)).filter((c) => c.product.active && c.current);
  const plans = catalog.filter((c) => c.product.kind === "recurring_membership" && !isInSeasonProduct(c.product)).map((c) => ({ product: c.product, v: c.current! }));
  const shop = await shopItems(tx, orgId, T);
  const shopHref = (productId: string | null | undefined) => (productId && shop.some((s) => s.productId === productId) ? `/shop#item-${productId}` : null);
  const payerOf = new Map<string, string | null>();
  for (const r of await rows<{ athlete_id: string; payer_account_id: string }>(tx, sql`select pb.athlete_id, pb.payer_account_id from payer_beneficiaries pb join athletes a on a.id = pb.athlete_id where a.org_id = ${orgId} ${scope}`)) {
    if (!payerOf.has(r.athlete_id)) payerOf.set(r.athlete_id, r.payer_account_id);
  }
  const out: Offer[] = [];
  const base = (key: OfferKey, athleteId: string, m?: LiveMembership | null) => {
    const a = A.get(athleteId)!;
    return {
      key,
      athleteId,
      personId: a.person_id,
      athleteName: `${a.first_name} ${a.last_name}`,
      payerAccountId: m?.payer_account_id ?? payerOf.get(athleteId) ?? null,
      membershipId: m?.id ?? null,
      currency: m?.currency ?? org.currency ?? "USD",
      familyVisible: true,
    };
  };
  const money = (minor: number, currency = org.currency ?? "USD") => formatMoney(minor, currency);

  // --- 1. Weekly cap reached in 3 of the last 4 full weeks → next plan up -------------------
  const capped = live.filter((m) => m.kind === "regular" && m.classes_per_week != null);
  if (capped.length) {
    const thisWeek = startOfWeekYmd(T);
    const from = addDaysYmd(thisWeek, -28);
    const counts = await rows<{ athlete_id: string; week: string; n: number }>(
      tx,
      sql`select b.athlete_id, to_char(date_trunc('week', s.starts_at at time zone ${DEFAULT_TZ}), 'YYYY-MM-DD') as week, count(*)::int as n
          from bookings b join schedule_sessions s on s.id = b.session_id join service_types st on st.id = s.service_type_id
          where b.org_id = ${orgId} and b.athlete_id in ${capped.map((m) => m.athlete_id)} and b.status in ('booked','attended','no_show')
            and st.kind = 'class'
            and (s.starts_at at time zone ${DEFAULT_TZ})::date >= ${from} and (s.starts_at at time zone ${DEFAULT_TZ})::date < ${thisWeek}
          group by 1, 2`,
    );
    for (const m of capped) {
      const cap = m.classes_per_week!;
      const weeksAtCap = counts.filter((c) => c.athlete_id === m.athlete_id && c.n >= cap).length;
      if (weeksAtCap < 3) continue;
      const sameShape = plans.filter((p) => p.product.id !== m.product_id && p.v.interval === m.interval && p.v.intervalCount === m.interval_count && p.v.currency === m.currency && p.v.priceMinor > num(m.price_minor));
      const higher = sameShape.filter((p) => (p.v.classesPerWeek != null && p.v.classesPerWeek > cap) || (p.v.classesPerWeek == null && p.v.unlimited));
      if (!higher.length) continue; // only when such a plan exists
      const rank = (p: (typeof higher)[number]) => [p.v.commitmentMonths === m.commitment_months ? 0 : 1, p.v.classesPerWeek ?? 99, p.v.priceMinor];
      const next = higher.sort((x, y) => {
        const a = rank(x);
        const b = rank(y);
        return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      })[0];
      const diff = monthly(next.v.priceMinor, next.v.interval, next.v.intervalCount) - monthly(num(m.price_minor), m.interval, m.interval_count);
      const nextLabel = next.v.classesPerWeek ? `${next.v.classesPerWeek}x per week` : "unlimited";
      const a = A.get(m.athlete_id)!;
      out.push({
        ...base("weekly_cap", m.athlete_id, m),
        title: `${a.first_name} is using every class on the ${cap}x per week plan`,
        familyText: `${a.first_name} has used every class on the ${cap}x per week plan in ${weeksAtCap} of the last 4 weeks. The ${nextLabel} plan is ${money(diff, m.currency)} more per month. If another training day would help, the front desk can switch plans whenever you like.`,
        evidence: [
          `Reached the weekly limit of ${cap} in ${weeksAtCap} of the last 4 full weeks`,
          `Current plan: ${m.product_name} at ${money(num(m.price_minor), m.currency)} per ${m.interval}`,
          `Next plan up: ${next.product.name} at ${money(next.v.priceMinor, next.v.currency)} per ${next.v.interval}${next.v.commitmentMonths ? ` (${next.v.commitmentMonths} month commitment)` : ""}`,
        ],
        estMonthlyMinor: diff,
        estOneTimeMinor: null,
        estBasis: "Catalog price difference between the two plans, per month",
        familyCta: { label: "Ask the front desk", href: "/messages" },
        staffAction: { label: "Start plan change", href: `/billing/memberships/${m.id}` },
      });
    }
  }

  // --- 2. Purchased credits low or expiring → renewal -----------------------------------------
  const buckets = await rows<{ athlete_id: string; available: number; granted: number; expires_at: Date | null; created_at: Date; product_id: string | null; product_name: string | null }>(
    tx,
    sql`select cb.athlete_id, cb.available, cb.granted, cb.expires_at, cb.created_at, p.id as product_id, p.name as product_name
        from credit_buckets cb join athletes a on a.id = cb.athlete_id
          left join invoice_lines il on il.id = cb.source_invoice_line_id
          left join product_versions pv on pv.id = il.product_version_id left join products p on p.id = pv.product_id
        where cb.org_id = ${orgId} and cb.source_kind = 'purchase' and cb.status = 'active'
          and (cb.expires_at is null or cb.expires_at > ${now.toISOString()}::timestamptz) ${scope}
        order by cb.created_at desc`,
  );
  const expiringBy = new Date(now.getTime() + cfg.creditsExpiringDays * 86_400_000);
  for (const athleteId of new Set(buckets.map((b) => b.athlete_id))) {
    if (!A.has(athleteId)) continue;
    const mine = buckets.filter((b) => b.athlete_id === athleteId);
    const pack = mine.find((b) => b.granted > Math.max(1, cfg.lowCreditsThreshold));
    const available = mine.reduce((s, b) => s + b.available, 0);
    const expiring = mine.filter((b) => b.available > 0 && b.expires_at && new Date(b.expires_at) <= expiringBy).sort((x, y) => +new Date(x.expires_at!) - +new Date(y.expires_at!))[0];
    const low = !!pack && available <= cfg.lowCreditsThreshold;
    if (!low && !expiring) continue;
    const src = expiring ?? pack ?? mine[0];
    const product = src.product_id ? catalog.find((c) => c.product.id === src.product_id) : null;
    const a = A.get(athleteId)!;
    const packName = product ? familyName(product.product.name) : "session pack";
    const href = shopHref(product?.product.id);
    const evidence: string[] = [];
    if (low) evidence.push(`${available} of ${pack!.granted} purchased session credits left (suggest at ${cfg.lowCreditsThreshold} or fewer)`);
    if (expiring) evidence.push(`${expiring.available} credit${expiring.available === 1 ? "" : "s"} expire on ${fmtDate(expiring.expires_at)} (within ${cfg.creditsExpiringDays} days)`);
    if (product?.current) evidence.push(`Renewal: ${product.product.name} at ${money(product.current.priceMinor, product.current.currency)}${href ? ", sellable online" : ", not in the online shop"}`);
    out.push({
      ...base("credits_low", athleteId),
      title: expiring && !low ? `${a.first_name}'s session credits expire soon` : `${a.first_name}'s session pack is running low`,
      familyText:
        expiring && !low
          ? `${expiring.available} of ${a.first_name}'s sessions expire on ${fmtDate(expiring.expires_at)}. There is still time to book them. When you are ready for more, another ${packName} is ${href ? "in the shop" : "available at the front desk"}.`
          : `${a.first_name} has ${available} session${available === 1 ? "" : "s"} left from the ${packName}. When you are ready, another one is ${href ? "in the shop" : "available at the front desk"}.`,
      evidence,
      estMonthlyMinor: null,
      estOneTimeMinor: product?.current?.priceMinor ?? null,
      estBasis: product?.current ? "Catalog price of the same pack, one time" : "No matching catalog item, so no figure",
      currency: product?.current?.currency ?? org.currency ?? "USD",
      familyCta: href ? { label: "See it in the shop", href } : { label: "Ask the front desk", href: "/messages" },
      staffAction: { label: "Open profile", href: `/people/${a.person_id}` },
    });
  }

  // --- 3. Month to month for N months → commitment plan savings --------------------------------
  const m2mSince = addMonths(T, -cfg.monthToMonthMonths);
  for (const m of live.filter((x) => x.kind === "regular" && x.commitment_months === 0 && x.start_date <= m2mSince)) {
    const twin = plans
      .filter((p) => p.product.id !== m.product_id && p.v.commitmentMonths > 0 && p.v.interval === m.interval && p.v.intervalCount === m.interval_count && p.v.currency === m.currency)
      .filter((p) => (p.v.classesPerWeek ?? null) === (m.classes_per_week ?? null) && p.v.unlimited === m.unlimited && p.v.priceMinor < num(m.price_minor))
      .sort((x, y) => x.v.priceMinor - y.v.priceMinor)[0];
    if (!twin) continue; // only if the catalog has one
    const save = monthly(num(m.price_minor), m.interval, m.interval_count) - monthly(twin.v.priceMinor, twin.v.interval, twin.v.intervalCount);
    const months = Math.max(cfg.monthToMonthMonths, Math.floor(daysApart(m.start_date, T) / 30));
    const a = A.get(m.athlete_id)!;
    out.push({
      ...base("commitment_savings", m.athlete_id, m),
      title: `${a.first_name} could save with a commitment plan`,
      familyText: `${a.first_name} has been on a month to month plan for about ${months} months. The same plan with a ${twin.v.commitmentMonths} month commitment is ${money(save, m.currency)} less per month. The front desk can walk you through the terms.`,
      evidence: [
        `Month to month since ${fmtDate(m.start_date)} (shown after ${cfg.monthToMonthMonths} months)`,
        `Current: ${m.product_name} at ${money(num(m.price_minor), m.currency)} per ${m.interval}`,
        `Commitment option: ${twin.product.name} at ${money(twin.v.priceMinor, twin.v.currency)} per ${twin.v.interval} for ${twin.v.commitmentMonths} months`,
      ],
      estMonthlyMinor: null,
      estOneTimeMinor: null,
      estBasis: `Family saves ${money(save, m.currency)} per month; the value to the gym is a ${twin.v.commitmentMonths} month commitment`,
      familyCta: { label: "Ask the front desk", href: "/messages" },
      staffAction: { label: "Start plan change", href: `/billing/memberships/${m.id}` },
    });
  }

  // --- 4. Sibling on file but not enrolled, and a family discount exists ----------------------
  if (policy.familyDiscountPercent > 0) {
    const confirmed = !policy.unconfirmed.includes("familyDiscountPercent");
    const sibs = await rows<{ payer_account_id: string; athlete_id: string; first_name: string }>(
      tx,
      sql`select pb.payer_account_id, a.id as athlete_id, coalesce(p.preferred_name, p.first_name) as first_name
          from payer_beneficiaries pb join athletes a on a.id = pb.athlete_id join people p on p.id = a.person_id
          where a.org_id = ${orgId} and a.active
            and not exists (select 1 from memberships m where m.athlete_id = a.id and m.status in ('pending','trialing','active','on_hold','past_due'))`,
    );
    const seenPayer = new Set<string>();
    for (const m of live.filter((x) => x.kind === "regular" && x.payer_account_id)) {
      if (seenPayer.has(m.payer_account_id!)) continue;
      const others = sibs.filter((s) => s.payer_account_id === m.payer_account_id && s.athlete_id !== m.athlete_id);
      if (!others.length) continue;
      seenPayer.add(m.payer_account_id!);
      const names = others.map((o) => o.first_name).join(" and ");
      const a = A.get(m.athlete_id)!;
      out.push({
        ...base("sibling_discount", m.athlete_id, m),
        familyVisible: confirmed,
        title: `${names} ${others.length === 1 ? "is" : "are"} on file but not enrolled`,
        familyText: `${names} ${others.length === 1 ? "is" : "are"} on your account and not enrolled right now. Families with two or more athletes enrolled get ${policy.familyDiscountPercent}% off each membership. If ${others.length === 1 ? names : "they"} would like to train alongside ${a.first_name}, the front desk can help.`,
        evidence: [
          `${a.first_name} is enrolled (${m.product_name}); ${names} ${others.length === 1 ? "is" : "are"} already on file as ${others.length === 1 ? "an athlete" : "athletes"} on the same billing account with no membership`,
          `Family discount in Settings: ${policy.familyDiscountPercent}%${confirmed ? "" : " (not confirmed by an owner yet, so families do not see this suggestion)"}`,
        ],
        estMonthlyMinor: null,
        estOneTimeMinor: null,
        estBasis: "Depends on the plan the sibling chooses, so no figure",
        familyCta: { label: "Ask the front desk", href: "/messages" },
        staffAction: { label: "Open profile", href: `/people/${a.person_id}?tab=family` },
      });
    }
  }

  // --- 5. No baseline test in N months → assessment -----------------------------------------
  const assessProduct = catalog.find((c) => c.product.kind === "assessment");
  const [assessService] = await rows<{ id: string }>(tx, sql`select id from service_types where org_id = ${orgId} and kind = 'assessment' and active limit 1`);
  if ((assessProduct || assessService) && live.length) {
    const memberIds = [...new Set(live.map((m) => m.athlete_id))];
    const lastTests = await rows<{ athlete_id: string; last: Date | null }>(
      tx,
      sql`select x.athlete_id, max(x.at) as last from (
            select ts.athlete_id, ts.tested_at as at from test_sessions ts where ts.org_id = ${orgId} and ts.athlete_id in ${memberIds}
            union all
            select b.athlete_id, s.starts_at from bookings b join schedule_sessions s on s.id = b.session_id join service_types st on st.id = s.service_type_id
              where b.org_id = ${orgId} and b.athlete_id in ${memberIds} and st.kind = 'assessment' and b.status in ('attended','booked')
          ) x group by x.athlete_id`,
    );
    const cutoff = new Date(`${addMonths(T, -cfg.assessmentMonths)}T12:00:00Z`);
    for (const athleteId of memberIds) {
      const m = live.find((x) => x.athlete_id === athleteId)!;
      // A brand-new member is not "overdue": wait until they have been here as long as the window.
      if (m.start_date > addMonths(T, -cfg.assessmentMonths)) continue;
      const last = lastTests.find((t) => t.athlete_id === athleteId)?.last ?? null;
      if (last && new Date(last) > cutoff) continue;
      const a = A.get(athleteId)!;
      const href = shopHref(assessProduct?.product.id);
      out.push({
        ...base("assessment_due", athleteId, m),
        title: `${a.first_name} has no baseline test in ${cfg.assessmentMonths} months`,
        familyText: last
          ? `${a.first_name}'s last baseline test was on ${fmtDate(last)}. A fresh assessment shows how training is paying off and what to work on next.`
          : `${a.first_name} does not have a baseline test on file yet. An assessment gives the coaches a starting point and shows progress over time.`,
        evidence: [
          last ? `Last test or assessment: ${fmtDate(last)} (suggest after ${cfg.assessmentMonths} months)` : `No test session or assessment on file; member since ${fmtDate(m.start_date)}`,
          assessProduct?.current ? `Assessment in catalog: ${assessProduct.product.name} at ${money(assessProduct.current.priceMinor, assessProduct.current.currency)}${href ? ", sellable online" : ""}` : "Assessment sessions exist on the schedule; no assessment product in the catalog",
        ],
        estMonthlyMinor: null,
        estOneTimeMinor: assessProduct?.current?.priceMinor ?? null,
        estBasis: assessProduct?.current ? "Catalog price of the assessment, one time" : "No assessment product in the catalog, so no figure",
        familyCta: href ? { label: "See it in the shop", href } : { label: "Ask the front desk", href: "/messages" },
        staffAction: { label: "Open profile", href: `/people/${a.person_id}` },
      });
    }
  }

  // --- 6. In Season ending soon → returning plan ---------------------------------------------
  const endingBy = addDaysYmd(T, cfg.inSeasonEndingDays);
  const ending = live.filter((m) => m.kind === "in_season" && m.end_date && m.end_date <= endingBy);
  if (ending.length) {
    const paused = await rows<{ in_season_id: string; membership_id: string; product_name: string; price_minor: string; currency: string; interval: string; interval_count: number; status: string }>(
      tx,
      sql`select h.related_membership_id as in_season_id, m.id as membership_id, p.name as product_name, pv.price_minor, pv.currency, pv.interval, pv.interval_count, m.status
          from membership_holds h join memberships m on m.id = h.membership_id join product_versions pv on pv.id = m.product_version_id join products p on p.id = pv.product_id
          where h.kind = 'in_season' and h.related_membership_id in ${ending.map((m) => m.id)} and m.org_id = ${orgId}`,
    );
    for (const m of ending) {
      const back = paused.find((p) => p.in_season_id === m.id && !["cancelled", "expired"].includes(p.status));
      if (!back && !plans.length) continue; // nothing to return to
      const a = A.get(m.athlete_id)!;
      const backMonthly = back ? monthly(num(back.price_minor), back.interval, back.interval_count) : null;
      out.push({
        ...base("in_season_ending", m.athlete_id, m),
        title: `${a.first_name}'s In Season plan ends ${fmtDate(m.end_date)}`,
        familyText: back
          ? `${a.first_name}'s In Season plan ends on ${fmtDate(m.end_date)}. The regular plan (${familyName(back.product_name)}) picks back up the next day. If the season is running long or plans have changed, just let the front desk know.`
          : `${a.first_name}'s In Season plan ends on ${fmtDate(m.end_date)}. When the season wraps up, the front desk can help choose a plan to come back to.`,
        evidence: [
          `In Season membership (${m.product_name}) ends ${fmtDate(m.end_date)} (within ${cfg.inSeasonEndingDays} days)`,
          back ? `Regular plan paused for the season: ${back.product_name} at ${money(num(back.price_minor), back.currency)} per ${back.interval}` : "No paused regular plan is linked; the catalog has regular plans to offer",
        ],
        estMonthlyMinor: backMonthly,
        estOneTimeMinor: null,
        estBasis: back ? "Catalog price of the paused regular plan, per month, once it resumes" : "Depends on the plan chosen, so no figure",
        membershipId: back?.membership_id ?? m.id,
        familyCta: { label: "Ask the front desk", href: "/messages" },
        staffAction: { label: back ? "Open regular plan" : "Open membership", href: `/billing/memberships/${back?.membership_id ?? m.id}` },
      });
    }
  }
  return out;
}

function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0, 12)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, dim)).padStart(2, "0")}`;
}
const daysApart = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

/** Staff list (billing staff only; coaches never see billing). Largest estimate first. */
export async function staffOpportunities(tx: Tx, v: Viewer, opts: { today: string; athleteId?: string; now?: Date }): Promise<Offer[]> {
  if (!can(v, "billing.view_all")) throw new AuthzError();
  const offers = await computeOffers(tx, v.orgId, { today: opts.today, now: opts.now, athleteIds: opts.athleteId ? [opts.athleteId] : undefined });
  const value = (o: Offer) => o.estMonthlyMinor ?? o.estOneTimeMinor ?? -1;
  return offers.sort((a, b) => value(b) - value(a) || a.athleteName.localeCompare(b.athleteName));
}

async function logEvent(tx: Tx, orgId: string, e: { athleteId: string; offerKey: OfferKey; event: "shown" | "accepted" | "dismissed" | "task_created"; audience: "family" | "staff"; userId: string; day: string }) {
  await tx.insert(offerEvents).values({ orgId, ...e }).onConflictDoNothing();
}

/** "Create task": a deduped follow-up in People → Tasks (one per athlete and offer per month). */
export async function createOfferTask(tx: Tx, v: Viewer, input: { athleteId: string; offerKey: OfferKey; today: string }) {
  if (!can(v, "billing.view_all")) throw new AuthzError();
  const offer = (await computeOffers(tx, v.orgId, { today: input.today, athleteIds: [input.athleteId] })).find((o) => o.key === input.offerKey);
  if (!offer) throw new UserError("That opportunity no longer applies.");
  const ins = await tx
    .insert(tasks)
    .values({
      orgId: v.orgId,
      title: `Opportunity: ${offer.title}`,
      description: `${offer.evidence.join("\n")}\nEstimate: ${offer.estBasis}`,
      dueAt: new Date(Date.now() + 3 * 86_400_000),
      assigneeUserId: v.userId,
      relatedPersonId: offer.personId,
      relatedType: "growth_offer",
      relatedId: offer.athleteId,
      source: "growth",
      dedupeKey: `growth:offer:${offer.athleteId}:${offer.key}:${input.today.slice(0, 7)}`,
      createdBy: v.userId,
    })
    .onConflictDoNothing()
    .returning({ id: tasks.id });
  if (ins.length) {
    await audit(tx, actorOf(v), "growth.offer.task", "task", ins[0].id, { summary: `Follow-up task for opportunity: ${offer.title}` });
    await logEvent(tx, v.orgId, { athleteId: offer.athleteId, offerKey: offer.key, event: "task_created", audience: "staff", userId: v.userId, day: input.today });
  }
  return { created: ins.length > 0 };
}

// ---------------------------------------------------------------------------
// Families: at most ONE gentle suggestion, dismissible, never for people who cannot see billing
// ---------------------------------------------------------------------------

/** Athletes whose billing this family viewer may see (policy.ts decides; payer view access). */
async function billingVisibleAthletes(tx: Tx, v: Viewer): Promise<string[]> {
  if (v.role !== "guardian" && v.role !== "athlete") return [];
  const payers = await payerAccountIdsFor(tx, v, "view");
  if (!payers.length) return [];
  const cand = await rows<{ athlete_id: string }>(
    tx,
    sql`select pb.athlete_id from payer_beneficiaries pb join athletes a on a.id = pb.athlete_id where pb.payer_account_id in ${payers} and a.org_id = ${v.orgId}`,
  );
  const out: string[] = [];
  for (const id of new Set(cand.map((c) => c.athlete_id))) if (await canOnAthlete(tx, v, id, "billing.read")) out.push(id);
  return out;
}

export async function familySuggestion(tx: Tx, v: Viewer, opts: { today: string; now?: Date; record?: boolean }): Promise<Offer | null> {
  const now = opts.now ?? new Date();
  const [org] = await rows<{ settings: Record<string, unknown> }>(tx, sql`select settings from organizations where id = ${v.orgId}`);
  const settings = growthFromSettings(org?.settings);
  if (!settings.offers.familyFacing) return null;
  const athleteIds = await billingVisibleAthletes(tx, v);
  if (!athleteIds.length) return null;
  const offers = (await computeOffers(tx, v.orgId, { today: opts.today, now, athleteIds, settings })).filter((o) => o.familyVisible);
  if (!offers.length) return null;
  const dismissed = await tx
    .select({ athleteId: offerDismissals.athleteId, offerKey: offerDismissals.offerKey })
    .from(offerDismissals)
    .where(and(eq(offerDismissals.userId, v.userId), gt(offerDismissals.until, now)));
  const open = offers.filter((o) => !dismissed.some((d) => d.athleteId === o.athleteId && d.offerKey === o.key));
  open.sort((a, b) => FAMILY_PRIORITY.indexOf(a.key) - FAMILY_PRIORITY.indexOf(b.key) || a.athleteName.localeCompare(b.athleteName));
  const pick = open[0] ?? null;
  if (pick && opts.record !== false) await logEvent(tx, v.orgId, { athleteId: pick.athleteId, offerKey: pick.key, event: "shown", audience: "family", userId: v.userId, day: opts.today });
  return pick;
}

const OFFER_KEYS = Object.keys(OFFER_LABEL) as OfferKey[];
export const isOfferKey = (k: string): k is OfferKey => (OFFER_KEYS as string[]).includes(k);

/** "Not now": hidden for this person for the configured number of days. */
export async function dismissOffer(tx: Tx, v: Viewer, input: { athleteId: string; offerKey: string; today: string; now?: Date }) {
  if (!isOfferKey(input.offerKey)) throw new UserError("Unknown suggestion.");
  if (!(await billingVisibleAthletes(tx, v)).includes(input.athleteId)) throw new AuthzError();
  const now = input.now ?? new Date();
  const [org] = await rows<{ settings: Record<string, unknown> }>(tx, sql`select settings from organizations where id = ${v.orgId}`);
  const days = growthFromSettings(org?.settings).offers.dismissalDays;
  const until = new Date(now.getTime() + days * 86_400_000);
  await tx
    .insert(offerDismissals)
    .values({ orgId: v.orgId, userId: v.userId, athleteId: input.athleteId, offerKey: input.offerKey, dismissedAt: now, until })
    .onConflictDoUpdate({ target: [offerDismissals.userId, offerDismissals.athleteId, offerDismissals.offerKey], set: { dismissedAt: now, until } });
  await logEvent(tx, v.orgId, { athleteId: input.athleteId, offerKey: input.offerKey, event: "dismissed", audience: "family", userId: v.userId, day: input.today });
  return { until };
}

/** The family followed the suggestion's link. Returns where to send them. */
export async function acceptOffer(tx: Tx, v: Viewer, input: { athleteId: string; offerKey: string; today: string }) {
  if (!isOfferKey(input.offerKey)) throw new UserError("Unknown suggestion.");
  if (!(await billingVisibleAthletes(tx, v)).includes(input.athleteId)) throw new AuthzError();
  const offer = (await computeOffers(tx, v.orgId, { today: input.today, athleteIds: [input.athleteId] })).find((o) => o.key === input.offerKey && o.familyVisible);
  if (!offer) return { href: "/shop" };
  await logEvent(tx, v.orgId, { athleteId: offer.athleteId, offerKey: offer.key, event: "accepted", audience: "family", userId: v.userId, day: input.today });
  return { href: offer.familyCta.href };
}

/** Athlete names for a set of ids in this org (used by pages). */
export async function athleteNames(tx: Tx, orgId: string, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const r = await tx.select({ id: athletes.id, first: people.firstName, last: people.lastName }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(and(eq(athletes.orgId, orgId), inArray(athletes.id, ids)));
  return new Map(r.map((x) => [x.id, `${x.first} ${x.last}`]));
}
