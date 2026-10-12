import { requireCap, getOrg } from "@/lib/auth/viewer";
import { policiesOf } from "@/lib/settings";
import { getPublicSite } from "@/lib/public-site";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { POLICY_FIELDS, PRORATION_LABELS, REFERENCE_PLANS, policyFromSettings } from "@/lib/membership-policy";
import { saveMembershipPolicyAction, saveOrgSettingsAction } from "./actions";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const v = await requireCap("settings.manage");
  const org = (await getOrg(v.orgId))!;
  const p = policiesOf(org.settings);
  const { content } = await getPublicSite();
  return (
    <>
      <PageHeader kicker="Settings" title="Organization & policies" description="Business policies are configurable — the app never invents prices or rules. Changes are audited." />
      <SettingsTabs current="org" />
      <ActionForm action={saveOrgSettingsAction} className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Branding" kicker="Shown in the app and public site" />
          <CardBody className="space-y-3">
            <Field label="Display name" htmlFor="displayName">
              <Input id="displayName" name="displayName" defaultValue={org.branding?.displayName ?? "Teamwork"} required />
            </Field>
            <Field label="Primary color" htmlFor="primaryColor" hint="Hex color. Keep enough contrast with white text.">
              <div className="flex items-center gap-2">
                <Input id="primaryColor" name="primaryColor" defaultValue={org.branding?.primaryColor ?? "#1d4ed8"} pattern="#[0-9a-fA-F]{6}" required className="w-40" />
                <span aria-hidden className="inline-block size-8 rounded-lg border border-edge" style={{ background: org.branding?.primaryColor ?? "#1d4ed8" }} />
              </div>
            </Field>
            <Field label="Logo URL (optional)" htmlFor="logoUrl" hint="Upload support comes with the asset library; a hosted URL works today.">
              <Input id="logoUrl" name="logoUrl" type="url" defaultValue={org.branding?.logoUrl ?? ""} />
            </Field>
            <div className="text-sm text-ink-3">
              Timezone: <span className="font-medium text-ink">{org.timezone}</span> · Currency: <span className="font-medium text-ink">{org.currency}</span>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Security & payments policy" />
          <CardBody className="space-y-3">
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input type="checkbox" name="requireStaffMfa" defaultChecked={p.requireStaffMfa} className="mt-1" />
              <span>
                Require two-step verification for all staff
                <span className="block text-xs text-ink-3">Staff without it are sent to set it up before they can use the Hub.</span>
              </span>
            </label>
            <Field label="Pending bank payments" htmlFor="pendingBankPaymentPolicy" hint="ACH/bank payments can take days to settle and can still fail.">
              <Select id="pendingBankPaymentPolicy" name="pendingBankPaymentPolicy" defaultValue={p.pendingBankPaymentPolicy}>
                <option value="grant_on_settlement">Grant credits/memberships only after funds settle (safer)</option>
                <option value="grant_on_pending">Grant immediately while pending (risk of reversal)</option>
              </Select>
            </Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Booking policy" />
          <CardBody className="grid gap-3 sm:grid-cols-2">
            <Field label="Families can book up to (days ahead)" htmlFor="bookingWindowDays">
              <Input id="bookingWindowDays" name="bookingWindowDays" type="number" min={1} defaultValue={p.bookingWindowDays} />
            </Field>
            <Field label="Family booking cutoff (minutes before start)" htmlFor="familyBookingCutoffMinutes">
              <Input id="familyBookingCutoffMinutes" name="familyBookingCutoffMinutes" type="number" min={0} defaultValue={p.familyBookingCutoffMinutes} />
            </Field>
            <label className="flex min-h-11 items-start gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="kioskPinOnly" defaultChecked={p.kioskPinOnly} className="mt-1" />
              <span>
                Kiosk: PIN check-in only
                <span className="block text-xs text-ink-3">The check-in kiosk never lists names; athletes enter the PIN a guardian or staff member set for them.</span>
              </span>
            </label>
            <p className="text-xs text-ink-3 sm:col-span-2">Cancellation and no-show penalties are set per session type in Schedule → Settings.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Messaging policy" />
          <CardBody className="grid gap-3 sm:grid-cols-2">
            <Field label="Quiet hours start" htmlFor="quietStart">
              <Input id="quietStart" name="quietStart" type="time" defaultValue={p.quietHours.start} />
            </Field>
            <Field label="Quiet hours end" htmlFor="quietEnd">
              <Input id="quietEnd" name="quietEnd" type="time" defaultValue={p.quietHours.end} />
            </Field>
            <label className="flex min-h-11 items-start gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="minorsReceiveDirectMessages" defaultChecked={p.minorsReceiveDirectMessages} className="mt-1" />
              <span>
                Minors may receive messages directly (otherwise messages about minors go to their guardians)
              </span>
            </label>
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Public website copy" kicker={content.draft ? "Currently draft text" : "Published"} />
          <CardBody className="space-y-3">
            <Field label="Headline" htmlFor="headline">
              <Input id="headline" name="headline" defaultValue={content.headline} maxLength={160} />
            </Field>
            <Field label="Intro" htmlFor="intro">
              <Textarea id="intro" name="intro" defaultValue={content.intro} maxLength={800} rows={3} />
            </Field>
          </CardBody>
        </Card>
        <div className="lg:col-span-2">
          <SubmitButton size="lg">Save settings</SubmitButton>
        </div>
      </ActionForm>
      <MembershipPolicyPanel settings={org.settings} />
    </>
  );
}

function MembershipPolicyPanel({ settings }: { settings: Record<string, unknown> | null }) {
  const policy = policyFromSettings(settings);
  const pending = new Set(policy.unconfirmed);
  const fmtUsd = (minor: number) => `$${(minor / 100).toFixed(2)}`;
  return (
    <Card className="mt-6" id="membership-policy">
      <CardHeader
        title="Membership policy"
        kicker="Owner / admin"
        action={pending.size ? <Badge variant="yellow">{pending.size} value{pending.size === 1 ? "" : "s"} need confirmation</Badge> : <Badge variant="green">All confirmed</Badge>}
      />
      <CardBody className="space-y-4">
        <p className="text-sm text-ink-3">
          Defaults come from Teamwork&apos;s documented procedures. Values marked &quot;Needs confirmation&quot; conflict between sources; tick &quot;Confirm&quot; when you have checked them. Billing, holds, in-season, cancellations and the family discount all read these values.
        </p>
        <ActionForm action={saveMembershipPolicyAction} className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          {POLICY_FIELDS.map((f) => {
            const value = policy[f.key];
            const needs = pending.has(f.key);
            const label = (
              <span className="inline-flex flex-wrap items-center gap-2">
                {f.label}
                {needs ? <Badge variant="yellow">Needs confirmation</Badge> : null}
              </span>
            );
            return (
              <div key={f.key} className="space-y-1">
                {f.kind === "bool" ? (
                  <label className="flex min-h-11 items-start gap-2 text-sm">
                    <input type="checkbox" name={f.key} defaultChecked={value === true} className="mt-1" />
                    <span>
                      {label}
                      <span className="block text-xs text-ink-3">{f.hint}</span>
                    </span>
                  </label>
                ) : f.kind === "proration" ? (
                  <Field label={label} htmlFor={`mp-${f.key}`} hint={f.hint}>
                    <Select id={`mp-${f.key}`} name={f.key} defaultValue={String(value)}>
                      {Object.entries(PRORATION_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </Select>
                  </Field>
                ) : (
                  <Field label={label} htmlFor={`mp-${f.key}`} hint={f.hint}>
                    <Input id={`mp-${f.key}`} name={f.key} type="number" min={f.min} max={f.max} defaultValue={String(value)} required />
                  </Field>
                )}
                {needs ? (
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" name="confirm" value={f.key} /> Confirm this value
                  </label>
                ) : null}
              </div>
            );
          })}
          <div className="sm:col-span-2">
            <SubmitButton>Save membership policy</SubmitButton>
          </div>
        </ActionForm>
        <div>
          <h3 className="mb-1 text-sm font-semibold">Reference plans (seeded as SAMPLE products to confirm)</h3>
          <ul className="space-y-1 text-sm">
            {REFERENCE_PLANS.map((p) => (
              <li key={p.key}>
                {p.name}: {p.classesPerWeek ? `${p.classesPerWeek}x/week` : "unlimited"}, {p.commitmentMonths ? `${p.commitmentMonths}-month commitment` : "no commitment"}, billed per {p.interval}, reference {fmtUsd(p.referencePriceMinor)} <Badge variant="yellow">Sample price, confirm</Badge>
              </li>
            ))}
          </ul>
        </div>
      </CardBody>
    </Card>
  );
}
