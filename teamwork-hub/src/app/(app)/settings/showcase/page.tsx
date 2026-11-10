import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SettingsTabs } from "@/components/settings-tabs";
import { Card, CardBody, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { getOrg, requireCap } from "@/lib/auth/viewer";
import { SHOWCASE_POLICY_TEXT, SHOWCASE_POLICY_VERSION } from "@/lib/showcase/allowlist";
import { DEFAULT_SHOWCASE_SETTINGS, EXPIRY_CHOICES, showcaseSettingsOf } from "@/lib/showcase/settings";
import { saveShowcaseSettingsAction } from "./actions";

export const metadata = { title: "Showcase settings" };

export default async function ShowcaseSettingsPage() {
  const v = await requireCap("settings.manage");
  const org = (await getOrg(v.orgId))!;
  const s = showcaseSettingsOf(org.settings);
  const d = DEFAULT_SHOWCASE_SETTINGS;
  return (
    <>
      <PageHeader kicker="Settings" title="Showcase and monthly recaps" description="What families can take outside the gym. These are starting defaults, not rules: change them to fit Teamwork. Changes are audited." />
      <SettingsTabs current="showcase" />
      <div className="grid gap-5 lg:grid-cols-2">
        <ActionForm action={saveShowcaseSettingsAction} className="space-y-5">
          <Card>
            <CardHeader title="Athlete Showcase" />
            <CardBody className="space-y-3">
              <label className="flex min-h-11 items-start gap-2 text-sm">
                <input type="checkbox" name="enabled" defaultChecked={s.enabled} className="mt-1" />
                <span>
                  Families can build and share a Showcase
                  <span className="block text-xs text-ink-3">When off, nobody can publish and every link already shared shows a &quot;not available&quot; page right away.</span>
                </span>
              </label>
              <Field label="Youngest age that can draft their own" htmlFor="sc-minage" hint={`Default ${d.minAge}. Younger athletes need a guardian to build it. A guardian always publishes for anyone under 18.`}>
                <Input id="sc-minage" name="minAge" type="number" min={8} max={17} step={1} defaultValue={s.minAge} required />
              </Field>
              <Field label="Default link lifetime" htmlFor="sc-expiry" hint={`Default ${d.defaultExpiryDays} days. The person publishing can pick another.`}>
                <Select id="sc-expiry" name="defaultExpiryDays" defaultValue={String(s.defaultExpiryDays)}>
                  {EXPIRY_CHOICES.map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? "No end date" : `${n} days`}
                    </option>
                  ))}
                </Select>
              </Field>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Monthly progress recap" />
            <CardBody className="space-y-3">
              <label className="flex min-h-11 items-start gap-2 text-sm">
                <input type="checkbox" name="recapEnabled" defaultChecked={s.recapEnabled} className="mt-1" />
                <span>
                  Assemble a recap for each athlete every month
                  <span className="block text-xs text-ink-3">Families see it in the Hub. No email or text is sent for it.</span>
                </span>
              </label>
              <Field label="Days coaches have to add a note after the month ends" htmlFor="rc-grace" hint={`Default ${d.recapGraceDays}. After that the month's numbers are frozen.`}>
                <Input id="rc-grace" name="recapGraceDays" type="number" min={0} max={14} step={1} defaultValue={s.recapGraceDays} required />
              </Field>
            </CardBody>
          </Card>
          <SubmitButton size="lg">Save settings</SubmitButton>
        </ActionForm>
        <div className="space-y-5">
          <Card>
            <CardHeader title="What a Showcase can never show" />
            <CardBody className="space-y-2 text-sm text-ink-2">
              <p>Wellness check-ins, body map, injury or health forms, coach notes, billing, which days an athlete attended, date of birth, home address, and the email or phone on an account. This list is fixed in code and is not a setting.</p>
              <p>
                Published pages are listed for staff under{" "}
                <Link href="/people/showcases" className="font-semibold text-brand underline">
                  People, Showcases
                </Link>
                . Owners and admins can turn any link off there.
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Consent wording" kicker={`Sample text · ${SHOWCASE_POLICY_VERSION}`} />
            <CardBody className="space-y-2 text-sm text-ink-2">
              <p className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs">Sample wording. Have it reviewed before real families use Showcase. The exact text is stored with every consent.</p>
              <p>{SHOWCASE_POLICY_TEXT}</p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
