import { randomUUID } from "node:crypto";
import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, Field, Input } from "@/components/ui";
import type { Viewer } from "@/lib/authz/policy";
import { passesForLead, TRIAL_PASS_LIMITS } from "@/lib/growth/passes";
import { referralForLead, REJECTION_LABEL } from "@/lib/growth/referrals";
import { growthSettings } from "@/lib/growth/settings";
import { fmtDate } from "@/lib/time";
import { attachReferralAction, issueTrialPassAction } from "@/app/(app)/_growth/actions";

/** Lead detail: who referred this lead, and free trial passes (staff with crm.manage). */
export async function LeadGrowthCard({ viewer, leadId, closed }: { viewer: Viewer; leadId: string; closed: boolean }) {
  const [referral, passes, settings] = await Promise.all([referralForLead(db, viewer, leadId), passesForLead(db, viewer, leadId), growthSettings(db, viewer.orgId)]);
  return (
    <Card>
      <CardHeader title="Referral & trial pass" />
      <CardBody className="space-y-4">
        <section aria-label="Referral">
          <h3 className="kicker mb-1">Referred by</h3>
          {referral ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{referral.referrer}</span>
              <Badge variant={referral.status === "rejected" ? "red" : referral.status === "earned" ? "green" : "blue"}>
                {referral.status === "rejected" ? `Not counted: ${REJECTION_LABEL[referral.rejectionReason!]}` : referral.status === "earned" ? "Reward earned" : referral.status === "started" ? "Started" : "Inquired"}
              </Badge>
              <span className="text-xs text-ink-3">
                {fmtDate(referral.createdAt)} · {referral.via === "staff" ? "code added by staff" : "referral link"} ·{" "}
                <Link href="/people/referrals" className="underline">
                  Referrals
                </Link>
              </span>
            </div>
          ) : !settings.referral.enabled ? (
            <p className="text-sm text-ink-3">No referral. The referral program is off.</p>
          ) : (
            <ActionForm action={attachReferralAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="leadId" value={leadId} />
              <Field label="No referral yet. Add a family's code" htmlFor="ref-code" hint="For a code mentioned in person or by phone. The first code wins.">
                <Input id="ref-code" name="code" required maxLength={16} autoComplete="off" className="w-44 font-mono" />
              </Field>
              <SubmitButton size="sm" variant="secondary" className="mb-5">
                Add code
              </SubmitButton>
            </ActionForm>
          )}
        </section>
        <section aria-label="Trial passes" className="border-t border-edge pt-3">
          <h3 className="kicker mb-1">Free trial pass</h3>
          {passes.length ? (
            <ul className="mb-3 space-y-1 text-sm">
              {passes.map((p) => (
                <li key={p.id}>
                  <span className="font-medium">
                    {p.credits} session{p.credits === 1 ? "" : "s"}
                  </span>{" "}
                  <span className="text-ink-3">
                    · {p.credits - p.available - p.reserved} used, {p.reserved} booked · expires {fmtDate(p.expiresAt)} · {p.reason}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {closed ? (
            <p className="text-sm text-ink-3">This lead is converted. Grant credits from the athlete&apos;s profile or billing.</p>
          ) : (
            <ActionForm action={issueTrialPassAction} className="grid gap-2 sm:grid-cols-2" resetOnSuccess>
              <input type="hidden" name="leadId" value={leadId} />
              <input type="hidden" name="key" value={randomUUID()} />
              <Field label="Sessions" htmlFor="tp-credits" required>
                <Input id="tp-credits" name="credits" type="number" min={1} max={TRIAL_PASS_LIMITS.maxCredits} required />
              </Field>
              <Field label="Valid for (days)" htmlFor="tp-days" required>
                <Input id="tp-days" name="expiresInDays" type="number" min={1} max={TRIAL_PASS_LIMITS.maxExpiryDays} required />
              </Field>
              <Field label="Reason" htmlFor="tp-reason" required className="sm:col-span-2" hint="Recorded in the audit log, e.g. open house visit or coach invitation.">
                <Input id="tp-reason" name="reason" required maxLength={300} />
              </Field>
              <div className="sm:col-span-2">
                <SubmitButton size="sm" variant="secondary" pendingText="Issuing…">
                  Issue trial pass
                </SubmitButton>
                <p className="mt-1 text-xs text-ink-3">Free session credits through the credit ledger. The lead gets an athlete record so staff can book them; the lead stays open until converted.</p>
              </div>
            </ActionForm>
          )}
        </section>
      </CardBody>
    </Card>
  );
}
