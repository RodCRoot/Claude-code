import { randomUUID } from "node:crypto";
import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { PeopleTabs } from "@/components/people-tabs";
import { KpiTile, Widget, WidgetEmpty } from "@/components/profile/studio";
import { Badge, ButtonLink, Callout, Input, PageHeader, Select } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { REJECTION_LABEL, staffReferralOverview, syncReferrals } from "@/lib/growth/referrals";
import { describeReward, growthSettings } from "@/lib/growth/settings";
import { formatMoney } from "@/lib/money";
import { fmtDate, todayLocal } from "@/lib/time";
import { applyAccountCreditAction, approveRewardAction, declineRewardAction } from "../../_growth/actions";

export const metadata = { title: "Referrals" };

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "n/a");
const STATUS_BADGE: Record<string, "neutral" | "blue" | "green" | "red"> = { inquired: "neutral", started: "blue", earned: "green", rejected: "red" };

export default async function ReferralsPage() {
  const v = await requireCap("crm.manage");
  const { o, settings } = await db.transaction(async (tx) => {
    await syncReferrals(tx, v.orgId, todayLocal());
    return { o: await staffReferralOverview(tx, v), settings: await growthSettings(tx, v.orgId) };
  });
  const canApprove = can(v, "billing.manage");
  const pending = o.rewards.filter((r) => r.status === "pending");
  const decided = o.rewards.filter((r) => r.status !== "pending").slice(0, 8);
  const reward = describeReward(settings.referral.reward);
  const rewardLabel = (r: (typeof o.rewards)[number]) =>
    r.kind === "account_credit"
      ? `${formatMoney(Number(r.amount_minor), r.currency ?? "USD")} account credit`
      : r.kind === "invoice_discount"
        ? `${formatMoney(Number(r.applied_minor ?? r.amount_minor), r.currency ?? "USD")} off first invoice`
        : `${r.credits} session credit${r.credits === 1 ? "" : "s"}`;
  const max = Math.max(1, o.funnel.inquired);
  return (
    <>
      <PageHeader
        kicker="People"
        title="Referrals"
        description="Families share a personal link. A referral counts when the new family passes the rules in Settings → Growth. Rewards wait here until a staff member approves them."
        actions={can(v, "settings.manage") ? <ButtonLink href="/settings/growth" variant="secondary">Referral settings</ButtonLink> : null}
      />
      <PeopleTabs current="referrals" showLeads showRequests />
      {!settings.referral.enabled ? (
        <Callout tone="warn" title="The referral program is off" className="mb-4">
          Families do not see a referral link and new codes are not attributed. An owner or admin can turn it on and set the reward in Settings → Growth.
        </Callout>
      ) : (
        <p className="mb-4 text-sm text-ink-3">
          Reward: <span className="font-medium text-ink">{reward ?? "none configured (staff handle thank-yous by hand)"}</span>, earned{" "}
          {settings.referral.earnedWhen === "first_paid_invoice" ? "when the referred member's first invoice is paid" : `after ${settings.referral.daysActive} days active`}.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-4">
        <KpiTile icon="people" label="Referred" value={o.funnel.inquired} hint="Passed the attribution rules" />
        <KpiTile icon="schedule" label="Started" value={o.funnel.started} hint={`${pct(o.funnel.started, o.funnel.inquired)} of referred`} tone="info" />
        <KpiTile icon="performance" label="Reward earned" value={o.funnel.earned} hint={`${pct(o.funnel.earned, o.funnel.inquired)} of referred`} tone="ok" />
        <KpiTile icon="clock" label="Rewards to approve" value={pending.length} hint="Nothing is issued until approved" tone={pending.length ? "warn" : "ok"} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        <Widget title="Rewards to approve" icon="billing" count={pending.length} className="lg:col-span-2" flush>
          {pending.length === 0 ? (
            <div className="px-4 py-3">
              <WidgetEmpty>No rewards are waiting. Earned rewards appear here for a one-click approval.</WidgetEmpty>
            </div>
          ) : (
            <ul className="divide-y divide-edge">
              {pending.map((r) => {
                const options = o.athleteOptions.filter((a) => a.payer_account_id === r.payer_account_id);
                return (
                  <li key={r.id} className="space-y-2 px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold">
                          {r.payer_name} <span className="font-normal text-ink-3">· {r.beneficiary === "referrer" ? "referring family" : "referred family"}</span>
                        </p>
                        <p className="text-xs text-ink-3">
                          For referring{" "}
                          <Link href={`/people/leads/${r.lead_id}`} className="underline">
                            {r.lead_first} {r.lead_last}
                          </Link>{" "}
                          · earned {fmtDate(r.created_at)}
                        </p>
                      </div>
                      <Badge variant="yellow">{rewardLabel(r)}</Badge>
                    </div>
                    {r.first_payment_refunded ? <p className="text-xs font-semibold text-bad">A refund was recorded on the new family&apos;s first payment. A full refund withholds this reward automatically.</p> : null}
                    {r.kind === "invoice_discount" ? (
                      <p className="text-xs text-ink-2">New family discount. It is applied automatically to this family&apos;s first open invoice and needs no approval. Decline it here if it should not apply.</p>
                    ) : null}
                    {canApprove ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <ActionForm action={approveRewardAction} className={r.kind === "invoice_discount" ? "hidden" : "flex flex-wrap items-end gap-2"}>
                          <input type="hidden" name="rewardId" value={r.id} />
                          {r.kind === "session_credits" && options.length > 1 ? (
                            <div>
                              <label htmlFor={`ath-${r.id}`} className="block text-xs font-semibold text-ink-2">
                                Credits go to
                              </label>
                              <Select id={`ath-${r.id}`} name="athleteId" required defaultValue="">
                                <option value="" disabled>
                                  Choose an athlete
                                </option>
                                {options.map((a) => (
                                  <option key={a.athlete_id} value={a.athlete_id}>
                                    {a.first_name} {a.last_name}
                                  </option>
                                ))}
                              </Select>
                            </div>
                          ) : null}
                          <SubmitButton size="sm" pendingText="Approving…">
                            Approve and issue
                          </SubmitButton>
                        </ActionForm>
                        <details className="text-sm">
                          <summary className="cursor-pointer py-1.5 text-xs font-semibold text-ink-2">Decline</summary>
                          <ActionForm action={declineRewardAction} className="mt-1 flex flex-wrap items-end gap-2">
                            <input type="hidden" name="rewardId" value={r.id} />
                            <div>
                              <label htmlFor={`why-${r.id}`} className="block text-xs font-semibold text-ink-2">
                                Reason
                              </label>
                              <Input id={`why-${r.id}`} name="reason" required maxLength={300} />
                            </div>
                            <SubmitButton size="sm" variant="secondary">
                              Decline reward
                            </SubmitButton>
                          </ActionForm>
                        </details>
                      </div>
                    ) : (
                      <p className="text-xs text-ink-3">Billing staff approve rewards.</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {decided.length ? (
            <div className="border-t border-edge px-4 py-3">
              <p className="kicker mb-1">Recently decided</p>
              <ul className="space-y-1 text-sm">
                {decided.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {r.payer_name} <span className="text-ink-3">· {rewardLabel(r)}</span>
                      {r.applied_invoice_id ? (
                        <>
                          {" "}
                          <Link href={`/billing/invoices/${r.applied_invoice_id}`} className="text-xs underline">
                            on {r.applied_invoice_number}
                          </Link>
                        </>
                      ) : null}
                      {r.status === "declined" && r.decline_reason ? <span className="block text-xs text-ink-3">{r.decline_reason}</span> : null}
                      {r.status === "approved" && r.kind !== "invoice_discount" && r.first_payment_refunded ? <span className="block text-xs font-semibold text-bad">First payment was refunded after approval. Review this credit.</span> : null}
                    </span>
                    <Badge variant={r.status === "approved" ? "green" : "neutral"}>{r.status === "approved" ? (r.kind === "invoice_discount" ? "Applied" : "Approved") : "Declined"}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Widget>

        <Widget title="Conversion funnel" icon="reports" href="/reports/growth-referrals" linkLabel="Report">
          <ol className="space-y-3">
            {(
              [
                ["Referred", o.funnel.inquired],
                ["Started", o.funnel.started],
                ["Reward earned", o.funnel.earned],
              ] as const
            ).map(([label, n]) => (
              <li key={label}>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium">{label}</span>
                  <span className="tabular font-semibold">{n}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-surface-2" aria-hidden>
                  <div className="h-2 rounded-full bg-brand" style={{ width: `${Math.round((n / max) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-ink-3">
            {o.funnel.rejected} not counted (self-referral, same household, already a member family, or already referred).
          </p>
        </Widget>

        <Widget title="Top referrers" icon="performance" count={o.leaderboard.length} flush>
          {o.leaderboard.length === 0 ? (
            <div className="px-4 py-3">
              <WidgetEmpty>No referrals yet.</WidgetEmpty>
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Referring families ranked by referrals that started</caption>
              <thead>
                <tr className="text-[11px] font-bold uppercase tracking-wide text-ink-2">
                  <th scope="col" className="border-b border-edge px-4 py-2 text-left">Family</th>
                  <th scope="col" className="border-b border-edge px-2 py-2 text-right">Referred</th>
                  <th scope="col" className="border-b border-edge px-2 py-2 text-right">Started</th>
                  <th scope="col" className="border-b border-edge px-4 py-2 text-right">Earned</th>
                </tr>
              </thead>
              <tbody>
                {o.leaderboard.map((l, i) => (
                  <tr key={l.payer_account_id} className="hover:bg-surface-2">
                    <th scope="row" className="border-b border-edge/70 px-4 py-1.5 text-left font-medium">
                      <span className="mr-2 inline-block w-4 text-ink-3 tabular">{i + 1}</span>
                      {l.name}
                    </th>
                    <td className="border-b border-edge/70 px-2 py-1.5 text-right tabular">{l.referred}</td>
                    <td className="border-b border-edge/70 px-2 py-1.5 text-right tabular">{l.started}</td>
                    <td className="border-b border-edge/70 px-4 py-1.5 text-right font-semibold tabular">{l.earned}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Widget>

        <Widget title="Recent referrals" icon="people" count={o.recent.length} className="lg:col-span-2" flush>
          {o.recent.length === 0 ? (
            <div className="px-4 py-3">
              <WidgetEmpty>Referrals appear here when a new family uses a referral link, or when staff add a code to a lead.</WidgetEmpty>
            </div>
          ) : (
            <ul className="divide-y divide-edge">
              {o.recent.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 hover:bg-surface-2">
                  <div className="min-w-0">
                    <Link href={`/people/leads/${r.lead_id}`} className="font-semibold hover:underline">
                      {r.first_name} {r.last_name}
                    </Link>
                    <span className="ml-2 text-xs text-ink-3">
                      referred by {r.referrer} · {fmtDate(r.created_at)}
                      {r.attached_via === "staff" ? " · code added by staff" : ""}
                    </span>
                  </div>
                  <Badge variant={STATUS_BADGE[r.status] ?? "neutral"}>
                    {r.status === "rejected" ? `Not counted: ${REJECTION_LABEL[r.rejection_reason as keyof typeof REJECTION_LABEL] ?? "rule"}` : r.status === "earned" ? "Reward earned" : r.status === "started" ? "Started" : "Inquired"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Widget>

        {o.creditAccounts.length ? (
          <Widget title="Account credit to apply" icon="billing" count={o.creditAccounts.length} className="lg:col-span-3" flush>
            <ul className="divide-y divide-edge">
              {o.creditAccounts.map((c) => (
                <li key={c.payerAccountId} className="flex flex-wrap items-end justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="font-semibold">{c.name}</p>
                    <p className="text-xs text-ink-3">
                      Credit balance <span className="font-semibold text-ink tabular">{formatMoney(c.balanceMinor)}</span>. Applying it lowers an invoice total; it is never recorded as a payment.
                    </p>
                  </div>
                  {canApprove && c.openInvoices.length ? (
                    <ActionForm action={applyAccountCreditAction} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="key" value={randomUUID()} />
                      <div>
                        <label htmlFor={`inv-${c.payerAccountId}`} className="block text-xs font-semibold text-ink-2">
                          Open invoice
                        </label>
                        <Select id={`inv-${c.payerAccountId}`} name="invoiceId" required>
                          {c.openInvoices.map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.number} · {formatMoney(i.totalMinor, i.currency)}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div>
                        <label htmlFor={`amt-${c.payerAccountId}`} className="block text-xs font-semibold text-ink-2">
                          Amount ($)
                        </label>
                        <Input id={`amt-${c.payerAccountId}`} name="amount" inputMode="decimal" required defaultValue={(c.balanceMinor / 100).toFixed(2)} className="w-28" />
                      </div>
                      <SubmitButton size="sm" variant="secondary">
                        Apply credit
                      </SubmitButton>
                    </ActionForm>
                  ) : (
                    <p className="text-xs text-ink-3">{c.openInvoices.length ? "Billing staff apply credit." : "No open invoice to apply it to yet."}</p>
                  )}
                </li>
              ))}
            </ul>
          </Widget>
        ) : null}
      </div>
    </>
  );
}
