import { and, eq, inArray, sql } from "drizzle-orm";
import {
  athletes,
  bookings,
  formRequests,
  formTemplates,
  formTemplateVersions,
  guardianships,
  invoiceLines,
  invoices,
  leads,
  locations,
  membershipEvents,
  membershipHolds,
  memberships,
  organizations,
  payerAccounts,
  payerAuthorizations,
  payerBeneficiaries,
  paymentAttempts,
  people,
  products,
  productVersions,
  scheduleSessions,
  scoreboardExpenses,
  scoreboardMarketingSpend,
  serviceTypes,
  staffPayRates,
  timeEntries,
  transactions,
} from "../../src/db/schema";
import { ensureStages } from "../../src/lib/crm/stages";
import { addIntervalYmd } from "../../src/lib/billing/util";
import { addDaysYmd, daysBetween, isoWeekday, localToUtc } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * Several months of SYNTHETIC business history so the owner scoreboard's monthly table, slot
 * utilisation and trends have something to show: invented members joining, changing plans, going
 * on hold and leaving; weekly classes with attendance; monthly invoices and payments (a few
 * unpaid across the aging buckets); leads by source with consults; older time-clock shifts;
 * SAMPLE marketing spend, expenses and "ideal" targets. Every name, price and amount is invented
 * and every row is flagged is_demo. Deterministic for a given `today`.
 *
 * Only runs for the demo database (`pnpm db:fresh`) or when a test asks for it by name, so the
 * other modules' fixtures and counts are unchanged.
 */

const FIRST = ["Aria", "Beckett", "Callum", "Delia", "Emmett", "Farah", "Gideon", "Harlow", "Idris", "Juno", "Kellan", "Liora", "Marlo", "Nadia", "Orrin", "Pia", "Quill", "Rhea", "Soren", "Tamsin", "Ulric", "Vesper", "Wren", "Xavi", "Yara", "Zane"];
const LAST = ["Ashgrove", "Brindle", "Calloway", "Dunmore", "Elmhart", "Fairwind", "Glenrock", "Hartsong", "Ivywood", "Jessamy", "Kestrel", "Larkspur"];
const SOURCES = ["web_inquiry", "web_inquiry", "referral", "referral", "instagram", "google", "walk_in", "facebook"];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function chunked<T>(rows: T[], insert: (part: T[]) => Promise<unknown>, size = 400) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

type Slot = { key: string; title: string; loc: "b" | "l"; weekdays: number[]; time: string; cap: number; coach: string };
const SLOTS: Slot[] = [
  { key: "ms", title: "Middle School Performance (sample)", loc: "b", weekdays: [1, 3], time: "16:00", cap: 10, coach: "tess" },
  { key: "hs", title: "High School Strength (sample)", loc: "b", weekdays: [1, 3], time: "17:15", cap: 8, coach: "marcus" },
  { key: "adult", title: "Adult Performance (sample)", loc: "b", weekdays: [2, 4], time: "06:15", cap: 8, coach: "marcus" },
  { key: "open", title: "Saturday Open Gym (sample)", loc: "b", weekdays: [6], time: "10:30", cap: 14, coach: "tess" },
  { key: "lyd", title: "Linton Youth Development (history, sample)", loc: "l", weekdays: [2, 4], time: "18:00", cap: 12, coach: "tess" },
  { key: "fri", title: "Friday Mobility (sample)", loc: "b", weekdays: [5], time: "18:30", cap: 12, coach: "tess" },
];

type Seg = { plan: string; start: string; end: string | null; status: "active" | "on_hold" | "past_due" | "cancelled" | "expired"; cancelReason?: string };
type Member = {
  key: string;
  first: string;
  last: string;
  loc: "b" | "l";
  segs: Seg[];
  slots: string[];
  /** 1x-per-week members only come on the slot's first weekday. */
  firstDayOnly?: boolean;
  p: number;
  /** Stops attending after this date (slipping / gone quiet). */
  quietAfter?: string;
  holds: { start: string; end: string }[];
  unpaidAround?: number;
  source: string | null;
  athleteId?: string;
  personId?: string;
  payerId?: string;
  membershipIds: string[];
};

export async function seedScoreboard(ctx: SeedCtx) {
  const { tx, orgId, today: T, tz } = ctx;
  const sched = ctx.extra.scheduling;
  if (!sched?.gpt || !ctx.extra.billing) return; // needs scheduling + billing
  const rand = rng(20261112);
  const pick = <X>(xs: X[]) => xs[Math.floor(rand() * xs.length)];
  const ex: Record<string, string> = {};
  ctx.extra.scoreboard = ex;

  // --- Plans (existing SAMPLE products; one extra plan valid at the second location only) ---
  const locs = await tx.select().from(locations).where(eq(locations.orgId, orgId));
  const bloom = locs.find((l) => l.name === "Bloomington")?.id ?? null;
  const linton = locs.find((l) => l.name === "Linton")?.id ?? null;
  const versionOf = async (name: string) => {
    const rows = await tx
      .select({ id: productVersions.id, price: productVersions.priceMinor, version: productVersions.version })
      .from(productVersions)
      .innerJoin(products, eq(products.id, productVersions.productId))
      .where(and(eq(products.orgId, orgId), eq(products.name, name)));
    return rows.sort((a, b) => b.version - a.version)[0] ?? null;
  };
  const [lintonProduct] = await tx
    .insert(products)
    .values({ orgId, name: "Sample — Linton Youth Development 2x per Week", kind: "recurring_membership", category: "Memberships", description: "SAMPLE plan and price for demo data.", locationIds: linton ? [linton] : [], isDemo: true })
    .returning();
  const [lintonVersion] = await tx.insert(productVersions).values({ productId: lintonProduct.id, version: 1, priceMinor: 13900, interval: "month", classesPerWeek: 2, effectiveFrom: addDaysYmd(T, -400) }).returning();
  const plans: Record<string, { id: string; price: number; cpw: number } | null> = {
    one: await versionOf("Sample — Athlete/Adult Performance 1x per Week (Month to Month)").then((v) => v && { id: v.id, price: v.price, cpw: 1 }),
    two: await versionOf("Sample — Athlete/Adult Performance 2x per Week (Month to Month)").then((v) => v && { id: v.id, price: v.price, cpw: 2 }),
    three: await versionOf("Sample — Athlete/Adult Performance 3x per Week (6 Months)").then((v) => v && { id: v.id, price: v.price, cpw: 3 }),
    unl: await versionOf("Sample — Unlimited Monthly Membership").then((v) => v && { id: v.id, price: v.price, cpw: 3 }),
    trial: await versionOf("Sample — Free Trial Week").then((v) => v && { id: v.id, price: v.price, cpw: 2 }),
    linton: { id: lintonVersion.id, price: 13900, cpw: 2 },
  };
  if (!plans.one || !plans.two || !plans.three || !plans.unl) return;
  ex.lintonProductId = lintonProduct.id;

  // --- Members ------------------------------------------------------------------------------
  const members: Member[] = [];
  const add = (m: Omit<Member, "key" | "first" | "last" | "membershipIds" | "holds" | "source"> & Partial<Pick<Member, "holds" | "source">>) => {
    const i = members.length;
    members.push({ key: `sb_${i}`, first: FIRST[i % FIRST.length], last: LAST[(i * 5 + Math.floor(i / FIRST.length)) % LAST.length], membershipIds: [], holds: [], source: pick(SOURCES), ...m });
  };
  // 30 steady members who joined over the last ten months and are still here.
  let k = 0;
  let inHs = 0;
  for (let i = 0; i < 30; i++) {
    const isLinton = i % 4 === 3;
    const plan = isLinton ? "linton" : ["two", "one", "three", "unl", "two"][k++ % 5];
    const slots = isLinton ? ["lyd"] : plan === "two" ? (inHs++ < 7 ? ["hs"] : [k % 2 ? "ms" : "adult"]) : plan === "one" ? [k % 2 ? "ms" : "adult"] : plan === "three" ? ["ms", "open"] : ["adult", "open", "fri"];
    add({ loc: isLinton ? "l" : "b", segs: [{ plan, start: addDaysYmd(T, -(20 + Math.floor(rand() * 280))), end: null, status: "active" }], slots, firstDayOnly: plan === "one", p: 0.8 + rand() * 0.15 });
  }
  // 6 real losses spread over earlier months.
  const reasons = ["Moved away (sample)", "Season ended (sample)", "Schedule conflict (sample)", "Cost (sample)", "Graduated (sample)", "Injury, not training (sample)"];
  [150, 118, 96, 71, 44, 19].forEach((ago, i) => {
    const start = addDaysYmd(T, -(ago + 60 + Math.floor(rand() * 120)));
    add({ loc: i === 2 ? "l" : "b", segs: [{ plan: i === 2 ? "linton" : pick(["one", "two"]), start, end: addDaysYmd(T, -ago), status: "cancelled", cancelReason: reasons[i] }], slots: i === 2 ? ["lyd"] : ["ms"], p: 0.6, quietAfter: addDaysYmd(T, -(ago + 12)) });
  });
  // 4 rebuilds: the old plan ends and a different plan starts the next day (NOT a loss, NOT a sale).
  [130, 85, 52, 9].forEach((ago, i) => {
    const change = addDaysYmd(T, -ago);
    add({ loc: "b", segs: [{ plan: i % 2 ? "one" : "two", start: addDaysYmd(T, -(ago + 90)), end: change, status: "cancelled", cancelReason: "Plan change (sample)" }, { plan: i % 2 ? "two" : "three", start: i === 3 ? change : addDaysYmd(change, 1), end: null, status: "active" }], slots: ["hs"], p: 0.88 });
  });
  // Trials: two converted, one did not, one running now.
  if (plans.trial) {
    add({ loc: "b", segs: [{ plan: "trial", start: addDaysYmd(T, -110), end: addDaysYmd(T, -103), status: "expired" }, { plan: "two", start: addDaysYmd(T, -102), end: null, status: "active" }], slots: ["hs"], p: 0.9 });
    add({ loc: "b", segs: [{ plan: "trial", start: addDaysYmd(T, -64), end: addDaysYmd(T, -57), status: "expired" }, { plan: "one", start: addDaysYmd(T, -55), end: null, status: "active" }], slots: ["ms"], p: 0.85 });
    add({ loc: "b", segs: [{ plan: "trial", start: addDaysYmd(T, -41), end: addDaysYmd(T, -34), status: "expired" }], slots: ["ms"], p: 0.5 });
    add({ loc: "b", segs: [{ plan: "trial", start: addDaysYmd(T, -3), end: addDaysYmd(T, 4), status: "active" }], slots: ["ms"], p: 0.9 });
  }
  // Holds: three past, two running now (one ends within a week).
  const hold = (i: number, start: number, end: number) => members[i].holds.push({ start: addDaysYmd(T, start), end: addDaysYmd(T, end) });
  hold(1, -140, -110);
  hold(4, -95, -67);
  hold(8, -60, -39);
  hold(12, -9, 5);
  hold(16, -20, 22);
  for (const i of [12, 16]) members[i].segs[0] = { ...members[i].segs[0], status: "on_hold", start: addDaysYmd(T, -200) };
  for (const i of [1, 4, 8]) members[i].segs[0].start = addDaysYmd(T, -260);
  // Slipping (10 to 25 days quiet), under-using, and over the weekly limit.
  [[2, 12], [6, 17], [10, 23]].forEach(([i, ago]) => {
    members[i].quietAfter = addDaysYmd(T, -ago);
    members[i].segs[0].start = addDaysYmd(T, -150);
  });
  Object.assign(members[5], { slots: ["ms"], firstDayOnly: false, p: 0.22, segs: [{ plan: "three", start: addDaysYmd(T, -170), end: null, status: "active" }] });
  Object.assign(members[9], { slots: ["ms", "adult"], firstDayOnly: false, p: 0.97, segs: [{ plan: "one", start: addDaysYmd(T, -160), end: null, status: "active" }] });
  // Sold yesterday (the daily page's "during yesterday" change) and unpaid invoices across the aging buckets.
  members[14].segs[0].start = addDaysYmd(T, -1);
  [[0, 8], [13, 40], [17, 75], [20, 105]].forEach(([i, ago]) => {
    members[i].unpaidAround = ago;
    members[i].segs[0].start = addDaysYmd(T, -230);
    if (ago === 8) members[i].segs[0].status = "past_due";
  });

  // --- People, athletes, payers ------------------------------------------------------------------
  for (const m of members) {
    const [p] = await tx.insert(people).values({ orgId, firstName: m.first, lastName: m.last, dateOfBirth: addDaysYmd(T, -(13 * 365 + Math.floor(rand() * 1400))), isDemo: true }).returning();
    const [a] = await tx.insert(athletes).values({ orgId, personId: p.id, sport: pick(["Soccer", "Basketball", "Volleyball", "Track & Field", "Baseball", "Multi-sport"]), level: "Level 1", isDemo: true }).returning();
    const [g] = await tx.insert(people).values({ orgId, firstName: `Parent of ${m.first}`, lastName: m.last, email: `${m.key}.parent@example.test`, isDemo: true }).returning();
    const [pa] = await tx.insert(payerAccounts).values({ orgId, name: `${m.first} ${m.last} family (sample)`, isDemo: true }).returning();
    await tx.insert(guardianships).values({ orgId, guardianPersonId: g.id, athleteId: a.id });
    await tx.insert(payerBeneficiaries).values({ payerAccountId: pa.id, athleteId: a.id });
    await tx.insert(payerAuthorizations).values({ payerAccountId: pa.id, personId: g.id });
    Object.assign(m, { athleteId: a.id, personId: p.id, payerId: pa.id });
    ctx.athletes[m.key] = a.id;
    ctx.people[m.key] = p.id;
    ctx.payers[m.key] = pa.id;
  }

  // Required forms are on file for all but two members, so the radar and the audit are not flooded.
  const required = await tx
    .select({ versionId: formTemplateVersions.id, templateId: formTemplates.id })
    .from(formTemplateVersions)
    .innerJoin(formTemplates, eq(formTemplates.id, formTemplateVersions.templateId))
    .where(and(eq(formTemplates.orgId, orgId), eq(formTemplates.requiredForBooking, true), eq(formTemplates.active, true), eq(formTemplateVersions.status, "published")));
  const latest = new Map(required.map((r) => [r.templateId, r.versionId]));
  const formRows: (typeof formRequests.$inferInsert)[] = [];
  for (const [i, m] of members.entries()) {
    if (i === 21 || i === 25) continue;
    for (const versionId of latest.values()) formRows.push({ orgId, templateVersionId: versionId, subjectPersonId: m.personId!, athleteId: m.athleteId!, status: "completed", completedAt: localToUtc(m.segs[0].start, "08:30", tz), source: "imported_archive", isDemo: true });
  }
  await chunked(formRows, (part) => tx.insert(formRequests).values(part));

  // --- Memberships, holds, invoices, payments -------------------------------------------------------
  const at = (ymd: string, time: string) => localToUtc(ymd, time, tz);
  const invRows: (typeof invoices.$inferInsert)[] = [];
  const lineRows: (typeof invoiceLines.$inferInsert)[] = [];
  const txnRows: (typeof transactions.$inferInsert)[] = [];
  const attemptRows: (typeof paymentAttempts.$inferInsert)[] = [];
  let invNo = 0;
  const uuid = () => crypto.randomUUID();
  for (const m of members) {
    for (const [si, s] of m.segs.entries()) {
      const plan = plans[s.plan]!;
      const anchor = Math.min(28, Number(s.start.slice(8)));
      let next: string | null = null;
      const isTrial = s.plan === "trial";
      const [row] = await tx
        .insert(memberships)
        .values({
          orgId,
          athleteId: m.athleteId!,
          payerAccountId: m.payerId!,
          productVersionId: plan.id,
          status: s.status,
          startDate: s.start,
          endDate: s.end,
          cancelAt: s.status === "cancelled" ? s.end : null,
          cancelReason: s.cancelReason ?? null,
          billingProvider: isTrial ? "none" : "manual",
          billingAnchorDay: isTrial ? null : anchor,
          isDemo: true,
          createdAt: at(s.start, "09:00"),
          updatedAt: at(s.end && s.end <= T ? s.end : s.start, "09:00"),
        })
        .returning();
      m.membershipIds.push(row.id);
      if (si === 0) {
        for (const h of m.holds) {
          await tx.insert(membershipHolds).values({ membershipId: row.id, startDate: h.start, endDate: h.end, reason: "Family travel (sample)", kind: "hold", requestedOn: addDaysYmd(h.start, -3), requestChannel: "email", createdBy: ctx.users.erin, createdAt: at(addDaysYmd(h.start, -2), "11:00") });
        }
      }
      if (isTrial) continue;
      // One invoice per monthly period that has started, skipping periods that begin inside a hold.
      for (let ps = s.start; ps <= T && (!s.end || ps < s.end); ps = addIntervalYmd(ps, "month", 1, anchor)) {
        const pe = addDaysYmd(addIntervalYmd(ps, "month", 1, anchor), -1);
        if (si === 0 && m.holds.some((h) => h.start <= ps && h.end >= ps)) continue;
        const unpaid = m.unpaidAround != null && Math.abs(daysBetween(ps, addDaysYmd(T, -m.unpaidAround))) <= 15 && !invRows.some((r) => r.membershipId === row.id && r.status === "open");
        const id = uuid();
        const issued = at(ps, "06:00");
        invRows.push({ id, orgId, payerAccountId: m.payerId!, number: `SB-${String(++invNo).padStart(5, "0")}`, status: unpaid ? "open" : "paid", subtotalMinor: plan.price, totalMinor: plan.price, issuedAt: issued, dueDate: ps, paidAt: unpaid ? null : at(ps, "13:00"), membershipId: row.id, periodStart: ps, periodEnd: pe, source: "membership_renewal", memo: "Synthetic history (sample)", isDemo: true, createdAt: issued, updatedAt: issued });
        lineRows.push({ invoiceId: id, productVersionId: plan.id, athleteId: m.athleteId!, description: `Membership ${ps} to ${pe} (sample)`, quantity: 1, unitAmountMinor: plan.price, amountMinor: plan.price });
        if (!unpaid) {
          const paidAt = at(addDaysYmd(ps, ps < T && rand() < 0.2 ? 1 : 0), "13:00");
          if (paidAt.getTime() <= Date.now() || ps < T) txnRows.push({ orgId, payerAccountId: m.payerId!, invoiceId: id, kind: "manual_payment", status: "settled", amountMinor: plan.price, currency: "USD", provider: "manual", methodType: "check", occurredAt: paidAt, settledAt: paidAt, recordedBy: ctx.users.erin, manualReference: `SAMPLE-HIST-${invNo}`, verification: "staff_attested", isDemo: true, createdAt: paidAt });
          else invRows[invRows.length - 1] = { ...invRows[invRows.length - 1], status: "open", paidAt: null };
        } else {
          attemptRows.push({ orgId, invoiceId: id, provider: "manual", amountMinor: plan.price, currency: "USD", methodType: "card", status: "failed", idempotencyKey: `sb-hist-fail-${invNo}`, failureCode: "sample_decline", failureMessage: "Sample decline (synthetic history)", createdBy: ctx.users.erin, createdAt: at(addDaysYmd(ps, 1), "10:00"), updatedAt: at(addDaysYmd(ps, 1), "10:00") });
        }
        next = addIntervalYmd(ps, "month", 1, anchor);
      }
      if (!s.end && next) await tx.update(memberships).set({ nextBillDate: next }).where(eq(memberships.id, row.id));
    }
  }
  // A plan change made in place (same membership, new version) two months back.
  if (members[18].membershipIds[0]) await tx.insert(membershipEvents).values({ membershipId: members[18].membershipIds[0], type: "plan_changed", fromVersionId: plans.one!.id, toVersionId: plans.two!.id, effectiveOn: addDaysYmd(T, -62), details: { sample: true }, actorUserId: ctx.users.erin, createdAt: at(addDaysYmd(T, -62), "10:00") });
  await chunked(invRows, (part) => tx.insert(invoices).values(part));
  await chunked(lineRows, (part) => tx.insert(invoiceLines).values(part));
  await chunked(txnRows, (part) => tx.insert(transactions).values(part));
  if (attemptRows.length) await tx.insert(paymentAttempts).values(attemptRows);
  // One refund last month (shown as a positive refund in the money view).
  const refundOf = txnRows.find((r) => r.settledAt && daysBetween(new Date(r.settledAt).toISOString().slice(0, 10), T) > 35);
  if (refundOf) {
    const when = at(addDaysYmd(T, -33), "15:00");
    await tx.insert(transactions).values({ orgId, payerAccountId: refundOf.payerAccountId, invoiceId: refundOf.invoiceId, kind: "refund", status: "settled", amountMinor: -4000, currency: "USD", provider: "manual", occurredAt: when, settledAt: when, recordedBy: ctx.users.rod, manualReference: "SAMPLE-HIST-REFUND", verification: "staff_attested", notes: "Goodwill refund (sample)", isDemo: true, createdAt: when });
  }

  // --- Weekly classes and attendance (26 weeks back through next week) --------------------------------
  const locId = (l: "b" | "l") => (l === "b" ? bloom : linton);
  const sessRows: (typeof scheduleSessions.$inferInsert)[] = [];
  const bookRows: (typeof bookings.$inferInsert)[] = [];
  const activeSeg = (m: Member, d: string) => m.segs.findIndex((s) => s.start <= d && (!s.end || s.end > d));
  for (let d = addDaysYmd(T, -182); d <= addDaysYmd(T, 6); d = addDaysYmd(d, 1)) {
    for (const slot of SLOTS) {
      if (!slot.weekdays.includes(isoWeekday(d))) continue;
      const id = uuid();
      const startsAt = at(d, slot.time);
      sessRows.push({ id, orgId, serviceTypeId: sched.gpt, title: slot.title, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), timezone: tz, coachUserId: ctx.users[slot.coach], locationId: locId(slot.loc), capacity: slot.cap, waitlistCapacity: 4, status: d < T ? "completed" : "scheduled", isDemo: true, createdAt: at(addDaysYmd(d, -21), "08:00") });
      let taken = 0;
      const rot = sessRows.length % members.length; // rotate who gets in first when a class fills
      for (const m of [...members.slice(rot), ...members.slice(0, rot)]) {
        if (!m.slots.includes(slot.key) || taken >= slot.cap) continue;
        if (m.firstDayOnly && isoWeekday(d) !== slot.weekdays[0]) continue;
        const si = activeSeg(m, d);
        if (si < 0 || (m.quietAfter && d > m.quietAfter) || m.holds.some((h) => h.start <= d && h.end >= d)) continue;
        const r = rand();
        const status = d >= T ? (r < m.p ? "booked" : null) : r < m.p ? "attended" : r < m.p + 0.06 ? "no_show" : null;
        if (!status) continue;
        if (status !== "no_show") taken++;
        bookRows.push({ orgId, sessionId: id, athleteId: m.athleteId!, status, entitlementSource: "membership", membershipId: m.membershipIds[si], checkedInAt: status === "attended" ? startsAt : null, checkInMethod: status === "attended" ? "kiosk" : null, source: "seed", isDemo: true, createdAt: at(addDaysYmd(d, -2), "12:00") });
      }
    }
  }

  // --- Leads and consults ---------------------------------------------------------------------------------
  await ensureStages(tx, orgId);
  const [assess] = await tx.select().from(serviceTypes).where(and(eq(serviceTypes.orgId, orgId), eq(serviceTypes.kind, "assessment")));
  const leadRows: (typeof leads.$inferInsert)[] = [];
  let consultNo = 0;
  const consult = (d: string) => {
    if (!assess) return null;
    const id = uuid();
    const startsAt = at(d, `${10 + (consultNo++ % 4)}:${consultNo % 2 ? "00" : "30"}`);
    sessRows.push({ id, orgId, serviceTypeId: assess.id, title: "Athletic Assessment (sample)", startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), timezone: tz, coachUserId: null, locationId: bloom, capacity: 1, status: d < T ? "completed" : "scheduled", isDemo: true, createdAt: at(addDaysYmd(d, -5), "09:00") });
    return { id, startsAt };
  };
  // Every member who came through the CRM has a won lead and an attended consult a few days before joining.
  for (const m of members) {
    if (!m.source) continue;
    const joined = m.segs[0].start;
    const created = at(addDaysYmd(joined, -(6 + Math.floor(rand() * 9))), "14:20");
    const s = consult(addDaysYmd(joined, -(1 + Math.floor(rand() * 4))));
    if (s) bookRows.push({ orgId, sessionId: s.id, athleteId: m.athleteId!, status: "attended", entitlementSource: "comp", checkedInAt: s.startsAt, checkInMethod: "staff", source: "seed", isDemo: true, createdAt: created });
    leadRows.push({ orgId, personId: m.personId!, stage: "won", source: m.source, interest: "Performance training (sample)", ownerUserId: ctx.users.erin, convertedAthleteId: m.athleteId!, convertedAt: at(joined, "09:00"), assessmentSessionId: s?.id ?? null, lastContactedAt: new Date(created.getTime() + 86_400_000), inquiry: { sample: true }, isDemo: true, createdAt: created, updatedAt: at(joined, "09:00") });
  }
  // Leads that did not join: lost, stalled, or had a consult without buying.
  const fates = ["lost", "lost", "contacted", "assessment_done", "assessment_done", "assessment_booked", "lost"];
  for (let mo = 0; mo < 7; mo++) {
    const n = 7 + Math.floor(rand() * 5) + (mo === 2 ? 4 : 0) - (mo === 1 ? 4 : 0);
    for (let k = 0; k < n; k++) {
      const ago = mo * 30 + 2 + Math.floor(rand() * 27);
      const d = addDaysYmd(T, -ago);
      const stage = ago < 12 ? pick(["new", "contacted", "assessment_booked"]) : pick(fates);
      const [p] = await tx.insert(people).values({ orgId, firstName: `${pick(FIRST)}`, lastName: `${pick(LAST)} (lead)`, status: "lead", isDemo: true }).returning();
      const s = stage === "assessment_done" || stage === "assessment_booked" || (stage === "lost" && rand() < 0.4) ? consult(addDaysYmd(d, stage === "assessment_booked" ? 9 : 4)) : null;
      leadRows.push({ orgId, personId: p.id, stage: s && stage === "assessment_booked" && addDaysYmd(d, 9) < T ? "contacted" : stage, source: pick(SOURCES), interest: "Performance training (sample)", ownerUserId: ctx.users.erin, lostReason: stage === "lost" ? pick(["No response (sample)", "Chose another program (sample)", "Schedule (sample)"]) : null, assessmentSessionId: s && !(stage === "assessment_booked" && addDaysYmd(d, 9) < T) ? s.id : null, lastContactedAt: stage === "new" ? null : at(addDaysYmd(d, 1), "10:00"), inquiry: { sample: true }, isDemo: true, createdAt: at(d, "16:40"), updatedAt: at(d, "16:40") });
    }
  }
  // Today's consults: one lead with no booking on the roster (the daily page calls it out).
  const todays = consult(T);
  if (todays) {
    const [p] = await tx.insert(people).values({ orgId, firstName: "Odessa", lastName: "Fairwind (lead)", status: "lead", isDemo: true }).returning();
    leadRows.push({ orgId, personId: p.id, stage: "assessment_booked", source: "referral", interest: "Performance training (sample)", ownerUserId: ctx.users.erin, assessmentSessionId: todays.id, lastContactedAt: at(addDaysYmd(T, -2), "10:00"), inquiry: { sample: true }, isDemo: true, createdAt: at(addDaysYmd(T, -4), "12:00"), updatedAt: at(addDaysYmd(T, -2), "10:00") });
  }
  await chunked(sessRows, (part) => tx.insert(scheduleSessions).values(part));
  await chunked(bookRows, (part) => tx.insert(bookings).values(part));
  await chunked(leadRows, (part) => tx.insert(leads).values(part));

  // --- Older time-clock shifts (the payroll seed covers the last five weeks) -------------------------------
  const staffIds = [ctx.users.marcus, ctx.users.tess, ctx.users.erin].filter(Boolean);
  const hasRates = staffIds.length ? await tx.select({ id: staffPayRates.id }).from(staffPayRates).where(inArray(staffPayRates.userId, staffIds)).limit(1) : [];
  if (hasRates.length) {
    await tx.insert(staffPayRates).values([
      { orgId, userId: ctx.users.marcus, label: "Coach (sample rate)", rateMinor: 1600, effectiveFrom: addDaysYmd(T, -400), isDemo: true },
      { orgId, userId: ctx.users.tess, label: "Coach (sample rate)", rateMinor: 1525, effectiveFrom: addDaysYmd(T, -400), isDemo: true },
      { orgId, userId: ctx.users.erin, label: "Front desk (sample rate)", rateMinor: 1400, effectiveFrom: addDaysYmd(T, -400), isDemo: true },
    ]);
    const shifts: (typeof timeEntries.$inferInsert)[] = [];
    const shift = (user: string, d: string, tin: string, tout: string) => {
      const clockIn = at(d, tin);
      const clockOut = at(d, tout);
      shifts.push({ orgId, userId: ctx.users[user], clockIn, clockOut, originalClockIn: clockIn, originalClockOut: clockOut, source: "kiosk", isDemo: true, createdBy: ctx.users.kiosk ?? null, createdAt: clockIn });
    };
    for (let d = addDaysYmd(T, -(Number(T.slice(8)) + 122)); d < addDaysYmd(T, -36); d = addDaysYmd(d, 1)) {
      const wd = isoWeekday(d);
      if (wd === 1 || wd === 3 || wd === 5) shift("marcus", d, "15:30", "19:45");
      if (wd === 2 || wd === 4) shift("tess", d, "16:00", "20:05");
      if (wd === 6) shift("tess", d, "09:00", "12:10");
      if (wd <= 5) shift("erin", d, "09:00", "13:00");
    }
    await chunked(shifts, (part) => tx.insert(timeEntries).values(part));
  }

  // --- SAMPLE marketing spend, expenses and ideal targets (owner-entered data in real use) ------------------
  const m0 = `${T.slice(0, 7)}-01`;
  const monthBack = (n: number) => {
    const d = new Date(Date.UTC(Number(m0.slice(0, 4)), Number(m0.slice(5, 7)) - 1 - n, 1));
    return d.toISOString().slice(0, 10);
  };
  const spend: (typeof scoreboardMarketingSpend.$inferInsert)[] = [];
  const costs: (typeof scoreboardExpenses.$inferInsert)[] = [];
  for (let n = 0; n < 7; n++) {
    const month = monthBack(n);
    spend.push({ orgId, month, channel: "instagram", amountMinor: 30000 + (n % 3) * 5000, note: "Sample spend", createdBy: ctx.users.rod, isDemo: true });
    spend.push({ orgId, month, channel: "google", amountMinor: 25000, note: "Sample spend", createdBy: ctx.users.rod, isDemo: true });
    if (n % 2 === 0) spend.push({ orgId, month, channel: "facebook", amountMinor: 15000, note: "Sample spend", createdBy: ctx.users.rod, isDemo: true });
    if (n === 2) spend.push({ orgId, month, channel: "Flyers (sample)", amountMinor: 6000, note: "Sample spend", createdBy: ctx.users.rod, isDemo: true });
    costs.push({ orgId, month, category: "rent", label: "Sample", amountMinor: 250000, createdBy: ctx.users.rod, isDemo: true });
    costs.push({ orgId, month, category: "software", label: "Sample", amountMinor: 32000, createdBy: ctx.users.rod, isDemo: true });
    if (n % 3 === 0) costs.push({ orgId, month, category: "other", label: "Insurance (sample)", amountMinor: 45000, createdBy: ctx.users.rod, isDemo: true });
  }
  // The oldest month shown has no time-clock data: a hand-entered payroll figure fills it.
  costs.push({ orgId, month: monthBack(5), category: "payroll_manual", label: "Sample", amountMinor: 240000, createdBy: ctx.users.rod, isDemo: true });
  await tx.insert(scoreboardMarketingSpend).values(spend);
  await tx.insert(scoreboardExpenses).values(costs);
  await tx
    .update(organizations)
    .set({ settings: sql`${organizations.settings} || ${JSON.stringify({ scoreboard: { targets: { leads: 14, showed: 8, trials_sold: 1, sold: 6, close_rate: 60, lost: 2, active: 60, visits: 500, avg_attendance: 5, loe: 6 } } })}::jsonb` })
    .where(eq(organizations.id, orgId));
}
