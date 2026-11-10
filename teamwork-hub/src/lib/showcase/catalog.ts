/**
 * Builds the Showcase CATALOG for one athlete: every item that is allowed to appear on a
 * Showcase, read from allowlisted columns only. This file is the only place the Showcase reads
 * athlete data, and it never touches wellness, body map, forms, notes, billing, addresses,
 * account emails or phone numbers. The date of birth is read once to derive an age band and is
 * not returned.
 *
 * Callers check access first (./access.ts). `includeTraining` is false for an editor without
 * training access, so test results, maxes and consistency are simply absent.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, bookings, exercises, maxes, memberships, organizations, people, scheduleSessions } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { ageOn } from "@/lib/engagement/access";
import { loadActivity, streakFromActivity } from "@/lib/engagement/sync";
import { KG_PER_LB, convertUnit, isNum, unitFamily } from "@/lib/science/formulas";
import { athleteMetricSeries } from "@/lib/science/kpis";
import { DEFAULT_TZ, addDaysYmd, localDayBounds, todayLocal } from "@/lib/time";
import { isShareableMetric } from "./allowlist";
import type { CatalogLift, CatalogMetric, ShowcaseCatalog, ShowcaseOrg } from "./compose";

const STAFF_ROLES = ["owner", "admin", "operations", "coach"];
/** Sources that are device or vendor imports, never typed in by a family. */
const DEVICE_SOURCES = ["hawkin", "teambuildr", "other_vendor"];

const RECORDED_BY: Record<string, string> = {
  hawkin: "Hawkin Dynamics force plate, imported from the device",
  teambuildr: "TeamBuildr, imported",
  other_vendor: "testing device, imported",
  teamwork_manual: "Teamwork coach, by hand",
  teamwork_derived: "Teamwork, calculated from recorded results",
};

/** An internal viewer for read models that need one. Only ever used after access was checked. */
export function systemViewer(orgId: string): Viewer {
  return { userId: "00000000-0000-0000-0000-000000000000", orgId, role: "owner", personId: null, displayName: "System", mfaVerified: true };
}

/** Age band from an age. Bands are two years wide so a birthday cannot be worked out. */
export function ageBandOf(age: number | null): string | null {
  if (age === null || age < 0) return null;
  if (age < 11) return "Under 11";
  if (age >= 19) return "19 or older";
  const lo = age % 2 === 1 ? age : age - 1;
  return `${lo} to ${lo + 1}`;
}

export function showcaseOrgOf(org: { name: string; branding: Record<string, string> | null }): ShowcaseOrg {
  const b = org.branding ?? {};
  const color = /^#[0-9a-fA-F]{6}$/.test(b.primaryColor ?? "") ? b.primaryColor : "#1d4ed8";
  // Only a same-origin logo path is used: the public page makes no third-party requests.
  const logo = typeof b.logoUrl === "string" && /^\/[A-Za-z0-9_./-]+$/.test(b.logoUrl) && !b.logoUrl.startsWith("//") ? b.logoUrl : null;
  return { name: b.displayName || org.name, primaryColor: color, logoPath: logo };
}

export async function showcaseOrg(tx: Tx, orgId: string): Promise<ShowcaseOrg & { tz: string }> {
  const [o] = await tx.select({ name: organizations.name, branding: organizations.branding, tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  return { ...showcaseOrgOf({ name: o?.name ?? "Teamwork", branding: o?.branding ?? {} }), tz: o?.tz ?? DEFAULT_TZ };
}

export async function buildCatalog(tx: Tx, orgId: string, athleteId: string, opts: { includeTraining: boolean; today?: string; tz?: string }): Promise<ShowcaseCatalog | null> {
  const tz = opts.tz ?? DEFAULT_TZ;
  const today = opts.today ?? todayLocal(tz);
  const [a] = await tx
    .select({
      firstName: people.firstName,
      preferredName: people.preferredName,
      lastName: people.lastName,
      dob: people.dateOfBirth,
      sport: athletes.sport,
      position: athletes.position,
      gradYear: athletes.gradYear,
      school: athletes.school,
      bodyMassKg: athletes.bodyMassKg,
    })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.id, athleteId), eq(athletes.orgId, orgId)));
  if (!a) return null;
  const massKg = a.bodyMassKg != null && a.bodyMassKg !== "" && Number(a.bodyMassKg) > 0 ? Number(a.bodyMassKg) : null;
  const catalog: ShowcaseCatalog = {
    athlete: {
      firstName: (a.preferredName || a.firstName).trim(),
      lastName: a.lastName.trim(),
      sport: a.sport,
      position: a.position,
      gradYear: a.gradYear,
      school: a.school,
      ageBand: ageBandOf(ageOn(a.dob, today)),
      weightLb: massKg === null ? null : massKg / KG_PER_LB,
    },
    metrics: null,
    lifts: null,
    consistency: null,
  };
  if (!opts.includeTraining) return catalog;

  // --- Test metrics: latest, best and the comparable trend (science/comparability rules) -----
  const series = await athleteMetricSeries(tx, systemViewer(orgId), athleteId, { to: today });
  // A result is "verified" only when a device import or a staff login recorded every value behind it.
  const verifiedRows = (
    await tx.execute(sql`
      select mv.test_session_id as sid, mv.metric_definition_id as mid,
        bool_and(coalesce(mv.source = any(${sql.raw(`array['${DEVICE_SOURCES.join("','")}']`)}) or u.role = any(${sql.raw(`array['${STAFF_ROLES.join("','")}']`)}), false)) as verified
      from metric_values mv left join users u on u.id = mv.entered_by and u.org_id = mv.org_id
      where mv.org_id = ${orgId} and mv.athlete_id = ${athleteId} and mv.value is not null and mv.aggregation not in ('vendor_mean','vendor_best')
      group by 1, 2`)
  ).rows as { sid: string; mid: string; verified: boolean }[];
  const verified = new Set(verifiedRows.filter((r) => r.verified).map((r) => `${r.sid}:${r.mid}`));

  const metrics: CatalogMetric[] = [];
  for (const s of series) {
    if (!isShareableMetric(s.metric)) continue;
    const valued = s.points.filter((p) => isNum(p.value));
    const latest = valued.at(-1);
    if (!latest) continue;
    const point = (p: (typeof valued)[number]) => ({ value: p.value!, date: p.date, verified: verified.has(`${p.sessionId}:${s.metric.id}`) });
    let best: (typeof valued)[number] | null = null;
    if (s.metric.higherIsBetter !== null) {
      for (const p of valued) if (!best || (s.metric.higherIsBetter ? p.value! > best.value! : p.value! < best.value!)) best = p;
    }
    metrics.push({
      id: s.metric.id,
      name: s.metric.name,
      unit: s.metric.unit,
      precision: s.metric.precision,
      higherIsBetter: s.metric.higherIsBetter,
      category: s.metric.category,
      testName: latest.testTypeName,
      protocol: latest.context?.protocol ?? null,
      description: s.metric.description,
      recordedBy: RECORDED_BY[latest.context?.source ?? latest.source] ?? "Teamwork",
      latest: point(latest),
      best: best ? point(best) : null,
      trend: valued.map((p) => ({ value: p.value!, date: p.date })),
      notCompared: s.excludedPoints.length,
    });
  }
  catalog.metrics = metrics.sort((x, y) => x.name.localeCompare(y.name));

  // --- Lift maxes: best measured max per lift, else the latest estimate (never mixed) --------
  const maxRows = await tx
    .select({ m: maxes, name: exercises.name, role: sql<string | null>`(select u.role from users u where u.id = ${maxes.enteredBy} and u.org_id = ${maxes.orgId})` })
    .from(maxes)
    .innerJoin(exercises, eq(exercises.id, maxes.exerciseId))
    .where(and(eq(maxes.orgId, orgId), eq(maxes.athleteId, athleteId)));
  const byEx = new Map<string, CatalogLift & { kg: number; measured: boolean }>();
  for (const { m, name, role } of maxRows.sort((x, y) => x.m.recordedOn.localeCompare(y.m.recordedOn))) {
    if (unitFamily(m.unit) !== "mass" || m.recordedOn > today) continue;
    const kg = convertUnit(Number(m.value), m.unit, "kg");
    if (!isNum(kg)) continue;
    const measured = m.kind !== "estimated";
    const prev = byEx.get(m.exerciseId);
    // Measured always wins over estimated; within a kind the heavier (measured) or newer (estimated) wins.
    const better = !prev || (measured && !prev.measured) || (measured === prev.measured && (measured ? kg > prev.kg : true));
    if (!better) continue;
    byEx.set(m.exerciseId, {
      exerciseId: m.exerciseId,
      name,
      value: Number(m.value),
      unit: m.unit,
      date: m.recordedOn,
      basis: measured ? "measured" : "estimated",
      method: m.method,
      verified: measured && (m.kind === "imported" || STAFF_ROLES.includes(role ?? "")),
      relative: massKg ? kg / massKg : null,
      kg,
      measured,
    });
  }
  catalog.lifts = [...byEx.values()].map(({ kg: _kg, measured: _m, ...l }) => (void _kg, void _m, l)).sort((x, y) => x.name.localeCompare(y.name));

  // --- Consistency: a 12-month count, the weekly streak, and the first membership month ------
  const since = localDayBounds(addDaysYmd(today, -365), tz).start;
  const [att] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(and(eq(bookings.orgId, orgId), eq(bookings.athleteId, athleteId), eq(bookings.status, "attended"), gte(scheduleSessions.startsAt, since)));
  const [first] = await tx.select({ start: sql<string | null>`min(${memberships.startDate})` }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.athleteId, athleteId)));
  const streak = streakFromActivity(await loadActivity(tx, orgId, athleteId, tz), today, tz);
  catalog.consistency = { sessions12mo: att?.n ?? 0, streakWeeks: streak.current, memberSince: first?.start ? String(first.start).slice(0, 7) : null };
  return catalog;
}
