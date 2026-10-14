import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { invoices, membershipEvents, memberships, products, productVersions } from "@/db/schema";
import { audit } from "@/lib/audit";
import { enqueue } from "@/lib/jobs";
import { addDaysYmd } from "@/lib/time";
import { billPeriod, holdOn, isStubStart, nextAnchorOnOrAfter, syncFamilyDiscount } from "./memberships";
import { addIntervalYmd } from "./util";

export const RENEWAL_JOB = "billing.generate_renewals";

export type RenewalSummary = {
  invoicesCreated: number;
  alreadyBilled: number;
  deferredForHold: number;
  cancelled: number;
  planChangesApplied: number;
  skippedExternal: number;
  /** Memberships billed by a Stripe/PayPal subscription: never renewed by Teamwork (no double billing). */
  skippedProviderBilled: number;
  statusChanges: number;
  /** Commitments that ended this run (membership continues month-to-month at the committed rate). */
  commitmentsEnded: number;
  familyDiscountChanges: number;
};

const SYSTEM = (orgId: string) => ({ orgId, actorUserId: null, actorRole: "system" });

/**
 * Daily renewal job. Idempotent: re-running for the same day creates nothing new, because each
 * period is keyed by (membership_id, period_start) and next_bill_date advances in the same transaction.
 * - Only billing_provider='manual' (Teamwork-invoiced) memberships are billed.
 * - external_zenplanner memberships are NEVER billed (Zen Planner still charges them until cutover).
 * - Holds covering the period start defer the period to the day after the hold (no invoice, no credits).
 * - Cancelled memberships / periods on or after cancel_at are not billed.
 */
export async function generateRenewals(tx: Tx, orgId: string, today: string): Promise<RenewalSummary> {
  const s: RenewalSummary = { invoicesCreated: 0, alreadyBilled: 0, deferredForHold: 0, cancelled: 0, planChangesApplied: 0, skippedExternal: 0, skippedProviderBilled: 0, statusChanges: 0, commitmentsEnded: 0, familyDiscountChanges: 0 };
  const ext = await tx.execute(sql`
    select count(*)::int as n from memberships where org_id = ${orgId} and billing_provider = 'external_zenplanner'
      and status in ('active','trialing','past_due','pending','on_hold') and next_bill_date <= ${today}`);
  s.skippedExternal = Number((ext.rows[0] as { n: number }).n);
  const prov = await tx.execute(sql`
    select count(*)::int as n from memberships where org_id = ${orgId} and billing_provider in ('stripe','paypal')
      and status in ('active','trialing','past_due','pending','on_hold')`);
  s.skippedProviderBilled = Number((prov.rows[0] as { n: number }).n);

  const due = await tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.billingProvider, "manual"),
        inArray(memberships.status, ["pending", "trialing", "active", "on_hold", "past_due"]),
        isNotNull(memberships.nextBillDate),
        lte(memberships.nextBillDate, today),
      ),
    )
    .for("update", { skipLocked: true });

  const endedPayers = new Set<string>();
  for (let m of due) {
    for (let guard = 0; guard < 24 && m.nextBillDate && m.nextBillDate <= today; guard++) {
      const periodStart = m.nextBillDate;
      if (m.cancelAt && periodStart >= m.cancelAt) {
        // A fixed-term In Season membership expires at its end date; it never auto-renews.
        const ended = m.kind === "in_season" ? "expired" : "cancelled";
        await tx.update(memberships).set({ status: ended, endDate: m.endDate ?? m.cancelAt, nextBillDate: null, updatedAt: new Date() }).where(eq(memberships.id, m.id));
        await tx.insert(membershipEvents).values({ membershipId: m.id, type: ended, effectiveOn: m.cancelAt, details: { by: "renewal_job" } });
        if (m.payerAccountId) endedPayers.add(m.payerAccountId);
        s.cancelled++;
        break;
      }
      // Commitment over: continue month-to-month at the committed rate (same version). Never a new commitment.
      if (m.commitmentEndsOn && periodStart > m.commitmentEndsOn) {
        const [done] = await tx
          .select({ id: membershipEvents.id })
          .from(membershipEvents)
          .where(and(eq(membershipEvents.membershipId, m.id), eq(membershipEvents.type, "commitment_ended")));
        if (!done) {
          await tx.insert(membershipEvents).values({
            membershipId: m.id,
            type: "commitment_ended",
            effectiveOn: addDaysYmd(m.commitmentEndsOn, 1),
            details: { commitmentEndsOn: m.commitmentEndsOn, continues: "month_to_month_at_committed_rate", productVersionId: m.productVersionId },
          });
          s.commitmentsEnded++;
        }
      }
      const hold = await holdOn(tx, m.id, periodStart);
      if (hold) {
        const resume = addDaysYmd(hold.endDate, 1);
        await tx.update(memberships).set({ nextBillDate: resume, updatedAt: new Date() }).where(eq(memberships.id, m.id));
        await tx.insert(membershipEvents).values({ membershipId: m.id, type: "renewal_deferred_hold", effectiveOn: periodStart, details: { holdId: hold.id, resumeOn: resume } });
        s.deferredForHold++;
        m = { ...m, nextBillDate: resume };
        continue;
      }
      // Apply a scheduled upgrade/downgrade whose effective date has arrived.
      const [sched] = await tx
        .select()
        .from(membershipEvents)
        .where(
          and(
            eq(membershipEvents.membershipId, m.id),
            eq(membershipEvents.type, "plan_change_scheduled"),
            lte(membershipEvents.effectiveOn, periodStart),
            sql`coalesce((${membershipEvents.details}->>'applied')::boolean, false) = false`,
          ),
        )
        .orderBy(sql`${membershipEvents.effectiveOn} desc`)
        .limit(1);
      if (sched?.toVersionId) {
        await tx.update(memberships).set({ productVersionId: sched.toVersionId, updatedAt: new Date() }).where(eq(memberships.id, m.id));
        await tx.execute(sql`update membership_events set details = details || '{"applied": true}'::jsonb where id = ${sched.id}`);
        await tx.insert(membershipEvents).values({ membershipId: m.id, type: "plan_changed", fromVersionId: m.productVersionId, toVersionId: sched.toVersionId, effectiveOn: periodStart, details: { scheduledEventId: sched.id } });
        m = { ...m, productVersionId: sched.toVersionId };
        s.planChangesApplied++;
      }
      const [row] = await tx
        .select({ version: productVersions, name: products.name })
        .from(productVersions)
        .innerJoin(products, eq(products.id, productVersions.productId))
        .where(eq(productVersions.id, m.productVersionId));
      const [existing] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.membershipId, m.id), eq(invoices.periodStart, periodStart), sql`${invoices.status} <> 'void'`));
      if (existing) {
        // Already billed (e.g. on creation); just advance the schedule.
        s.alreadyBilled++;
        const next = isStubStart(row.version, m.billingAnchorDay, periodStart)
          ? nextAnchorOnOrAfter(addDaysYmd(periodStart, 1), m.billingAnchorDay!)
          : addIntervalYmd(periodStart, row.version.interval, row.version.intervalCount, m.billingAnchorDay);
        await tx.update(memberships).set({ nextBillDate: m.endDate && next > m.endDate ? null : next }).where(eq(memberships.id, m.id));
      } else {
        await billPeriod(tx, SYSTEM(orgId), m, row.version, row.name, periodStart);
        s.invoicesCreated++;
      }
      const [fresh] = await tx.select().from(memberships).where(eq(memberships.id, m.id));
      m = fresh;
    }
  }
  const sync = await syncMembershipStatuses(tx, orgId, today, endedPayers);
  s.statusChanges = sync;
  // Family discount follows enrollment: re-check families where a membership just ended.
  for (const payerId of [...endedPayers].sort()) {
    const r = await syncFamilyDiscount(tx, SYSTEM(orgId), orgId, payerId);
    s.familyDiscountChanges += r.changes.length;
  }
  if (s.invoicesCreated || s.cancelled || s.deferredForHold) {
    await audit(tx, SYSTEM(orgId), "billing.renewals.run", "org", orgId, { summary: `Renewals for ${today}: ${JSON.stringify(s)}` });
  }
  return s;
}

/**
 * Derive statuses from holds, cancellations and overdue invoices.
 * External (Zen Planner) memberships are left as imported.
 */
export async function syncMembershipStatuses(tx: Tx, orgId: string, today: string, endedPayers?: Set<string>): Promise<number> {
  let changed = 0;
  const onHold = await tx.execute(sql`
    update memberships m set status = 'on_hold', updated_at = now()
    where m.org_id = ${orgId} and m.billing_provider <> 'external_zenplanner' and m.status in ('active','past_due','pending')
      and exists (select 1 from membership_holds h where h.membership_id = m.id and h.start_date <= ${today} and h.end_date >= ${today})`);
  changed += onHold.rowCount ?? 0;
  const offHold = await tx.execute(sql`
    update memberships m set status = 'active', updated_at = now()
    where m.org_id = ${orgId} and m.status = 'on_hold' and m.billing_provider <> 'external_zenplanner'
      and not exists (select 1 from membership_holds h where h.membership_id = m.id and h.start_date <= ${today} and h.end_date >= ${today})`);
  changed += offHold.rowCount ?? 0;
  const ended = await tx.execute(sql`
    update memberships set status = case when kind = 'in_season' then 'expired' else 'cancelled' end,
      end_date = coalesce(end_date, cancel_at), next_bill_date = null, updated_at = now()
    where org_id = ${orgId} and billing_provider <> 'external_zenplanner' and status in ('active','past_due','pending','trialing','on_hold')
      and cancel_at is not null and cancel_at <= ${today}
    returning payer_account_id`);
  changed += ended.rowCount ?? 0;
  for (const r of ended.rows as { payer_account_id: string | null }[]) if (r.payer_account_id) endedPayers?.add(r.payer_account_id);
  const pastDue = await tx.execute(sql`
    update memberships m set status = 'past_due', updated_at = now()
    where m.org_id = ${orgId} and m.billing_provider <> 'external_zenplanner' and m.status in ('active','pending','trialing')
      and exists (select 1 from invoices i where i.membership_id = m.id and i.status = 'open' and i.due_date < ${today})`);
  changed += pastDue.rowCount ?? 0;
  return changed;
}

/** Enqueue today's renewal run (deduped per org per day). */
export async function scheduleRenewals(tx: Tx, orgId: string, today: string) {
  return enqueue(tx, { type: RENEWAL_JOB, orgId, payload: { orgId, today }, dedupeKey: `${RENEWAL_JOB}:${orgId}:${today}` });
}
