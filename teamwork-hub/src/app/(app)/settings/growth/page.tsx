import { ActionForm, SubmitButton } from "@/components/forms";
import { SettingsTabs } from "@/components/settings-tabs";
import { Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getOrg, requireCap } from "@/lib/auth/viewer";
import { growthFromSettings, type RewardSpec } from "@/lib/growth/settings";
import { saveGrowthSettingsAction } from "../../_growth/actions";

export const metadata = { title: "Growth settings" };

function RewardFields({ prefix, legend, spec }: { prefix: string; legend: string; spec: RewardSpec }) {
  return (
    <fieldset className="space-y-3 rounded-lg border border-edge p-3">
      <legend className="px-1 text-sm font-semibold">{legend}</legend>
      <Field label="Reward type" htmlFor={`${prefix}Type`}>
        <Select id={`${prefix}Type`} name={`${prefix}Type`} defaultValue={spec.type}>
          <option value="none">None (staff say thank you by hand)</option>
          <option value="account_credit">Account credit</option>
          <option value="session_credits">Session credits</option>
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Account credit ($)" htmlFor={`${prefix}Amount`} hint="Only for account credit. Enter your real amount.">
          <Input id={`${prefix}Amount`} name={`${prefix}Amount`} inputMode="decimal" defaultValue={spec.amountMinor != null ? (spec.amountMinor / 100).toFixed(2) : ""} />
        </Field>
        <Field label="Session credits" htmlFor={`${prefix}Credits`} hint="Only for session credits.">
          <Input id={`${prefix}Credits`} name={`${prefix}Credits`} type="number" min={1} max={50} defaultValue={spec.credits ?? ""} />
        </Field>
        <Field label="Credits expire after (days)" htmlFor={`${prefix}CreditExpiryDays`} hint="Empty = no expiry.">
          <Input id={`${prefix}CreditExpiryDays`} name={`${prefix}CreditExpiryDays`} type="number" min={1} max={730} defaultValue={spec.creditExpiryDays ?? ""} />
        </Field>
      </div>
    </fieldset>
  );
}

export default async function GrowthSettingsPage() {
  const v = await requireCap("settings.manage");
  const org = (await getOrg(v.orgId))!;
  const g = growthFromSettings(org.settings);
  const saved = !!(org.settings as Record<string, unknown>)?.growth;
  return (
    <>
      <PageHeader kicker="Settings" title="Growth" description="Referral rewards and helpful suggestions. Nothing here has an amount until you enter one, and every reward waits for staff approval before it is issued. Changes are audited." />
      <SettingsTabs current="growth" />
      {org.isDemo && saved ? (
        <Callout tone="warn" title="Sample values" className="mb-4">
          This demo organization is seeded with a sample reward and sample text so the screens have something to show. They are not Teamwork&apos;s real reward or policy.
        </Callout>
      ) : !saved ? (
        <Callout tone="info" title="Defaults" className="mb-4">
          Nothing has been saved yet. The referral program is off and no reward is set. The suggestion thresholds below are starting defaults you can change.
        </Callout>
      ) : null}
      <ActionForm action={saveGrowthSettingsAction} className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader title="Referral program" kicker="Off until you turn it on" />
          <CardBody className="space-y-4">
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input type="checkbox" name="referralEnabled" defaultChecked={g.referral.enabled} className="mt-1" />
              <span>
                Referral program is on
                <span className="block text-xs text-ink-3">Families get a personal link on their Refer a friend page. When off, links are hidden and codes are not attributed.</span>
              </span>
            </label>
            <RewardFields prefix="reward" legend="Reward for the referring family" spec={g.referral.reward} />
            <fieldset className="space-y-3 rounded-lg border border-edge p-3">
              <legend className="px-1 text-sm font-semibold">Discount for the new family (optional)</legend>
              <Field
                label="Off the new family's first invoice ($)"
                htmlFor="newFamilyDiscount"
                hint="Leave empty for none. Applied automatically to the referred family's first open invoice as a discount. One per new billing account, never for existing or returning families."
              >
                <Input id="newFamilyDiscount" name="newFamilyDiscount" inputMode="decimal" className="max-w-40" defaultValue={g.referral.newFamilyDiscountMinor != null ? (g.referral.newFamilyDiscountMinor / 100).toFixed(2) : ""} />
              </Field>
              <p className="text-xs text-ink-3">
                It needs no approval because it only lowers an invoice the family still has to pay: no money is paid out, and a refund returns only what they paid. If their first invoice was already paid before the discount could apply, it becomes an account credit that waits for staff approval like any other reward.
              </p>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="A reward is earned when" htmlFor="earnedWhen">
                <Select id="earnedWhen" name="earnedWhen" defaultValue={g.referral.earnedWhen}>
                  <option value="first_paid_invoice">The new member&apos;s first invoice is paid</option>
                  <option value="days_active">The new member has been active for N days</option>
                </Select>
              </Field>
              <Field label="Days active (N)" htmlFor="daysActive" hint="Only for the days-active rule.">
                <Input id="daysActive" name="daysActive" type="number" min={1} max={365} defaultValue={g.referral.daysActive ?? ""} />
              </Field>
            </div>
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input type="checkbox" name="requireNewFamily" defaultChecked={g.referral.requireNewFamily} className="mt-1" />
              <span>
                The referred family must be new
                <span className="block text-xs text-ink-3">No one matching the inquiry may have had a membership here before.</span>
              </span>
            </label>
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input type="checkbox" name="blockSameHousehold" defaultChecked={g.referral.blockSameHousehold} className="mt-1" />
              <span>
                Block referrals within the same household
                <span className="block text-xs text-ink-3">Self-referrals are always blocked.</span>
              </span>
            </label>
            <Field label="How it works (shown to families)" htmlFor="howItWorks" hint="Plain text in your own words. Keep it friendly and short.">
              <Textarea id="howItWorks" name="howItWorks" rows={4} maxLength={1200} defaultValue={g.referral.howItWorks} />
            </Field>
            <p className="text-xs text-ink-3">An earned reward for the referring family is created as pending. Staff approve it in People → Referrals; only then is account credit or session credit issued. A pending reward is withheld if the new family&apos;s first payment is refunded in full.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Helpful suggestions" kicker="Rule-based, with the evidence shown" />
          <CardBody className="space-y-4">
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input type="checkbox" name="familyFacing" defaultChecked={g.offers.familyFacing} className="mt-1" />
              <span>
                Show suggestions to families
                <span className="block text-xs text-ink-3">At most one at a time on the Shop and billing pages, never a pop-up, and only to people who can see billing. Staff always see Opportunities.</span>
              </span>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="“Not now” hides a suggestion for (days)" htmlFor="dismissalDays">
                <Input id="dismissalDays" name="dismissalDays" type="number" min={1} max={365} required defaultValue={g.offers.dismissalDays} />
              </Field>
              <Field label="Session pack is low at (credits or fewer)" htmlFor="lowCreditsThreshold">
                <Input id="lowCreditsThreshold" name="lowCreditsThreshold" type="number" min={0} max={20} required defaultValue={g.offers.lowCreditsThreshold} />
              </Field>
              <Field label="Credits expiring within (days)" htmlFor="creditsExpiringDays">
                <Input id="creditsExpiringDays" name="creditsExpiringDays" type="number" min={1} max={120} required defaultValue={g.offers.creditsExpiringDays} />
              </Field>
              <Field label="Month to month for (months) before showing commitment savings" htmlFor="monthToMonthMonths">
                <Input id="monthToMonthMonths" name="monthToMonthMonths" type="number" min={1} max={36} required defaultValue={g.offers.monthToMonthMonths} />
              </Field>
              <Field label="No baseline test in (months)" htmlFor="assessmentMonths">
                <Input id="assessmentMonths" name="assessmentMonths" type="number" min={1} max={36} required defaultValue={g.offers.assessmentMonths} />
              </Field>
              <Field label="In Season ending within (days)" htmlFor="inSeasonEndingDays">
                <Input id="inSeasonEndingDays" name="inSeasonEndingDays" type="number" min={1} max={90} required defaultValue={g.offers.inSeasonEndingDays} />
              </Field>
            </div>
            <p className="text-xs text-ink-3">
              Prices in suggestions always come from Billing → Products. A suggestion only appears when the plan or item it mentions exists in the catalog. The weekly-limit rule is fixed: the limit was reached in 3 of the last 4 full weeks.
            </p>
          </CardBody>
        </Card>
        <div className="lg:col-span-2">
          <SubmitButton>Save growth settings</SubmitButton>
        </div>
      </ActionForm>
    </>
  );
}
