import { ActionForm, SubmitButton } from "@/components/forms";
import { BadgeMedallion } from "@/components/engagement/medallion";
import { SettingsTabs } from "@/components/settings-tabs";
import { Badge, Card, CardBody, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { XP_KINDS } from "@/db/schema";
import { getOrg, requireCap } from "@/lib/auth/viewer";
import { BADGES } from "@/lib/engagement/badges";
import { levelThreshold, levelTitle } from "@/lib/engagement/levels";
import { DEFAULT_XP, MAX_XP_PER_EVENT, XP_KIND_LABEL, engagementSettingsOf } from "@/lib/engagement/settings";
import { saveEngagementSettingsAction } from "./actions";

export const metadata = { title: "Engagement settings" };

export default async function EngagementSettingsPage() {
  const v = await requireCap("settings.manage");
  const org = (await getOrg(v.orgId))!;
  const s = engagementSettingsOf(org.settings);
  return (
    <>
      <PageHeader kicker="Settings" title="Engagement" description="Streaks, XP, levels and badges on Athlete Home. Point values are starting defaults, not a rule: change them to fit your gym. Changes are audited." />
      <SettingsTabs current="engagement" />
      <div className="grid gap-5 lg:grid-cols-2">
        <ActionForm action={saveEngagementSettingsAction} className="space-y-5">
          <Card>
            <CardHeader title="What athletes see" />
            <CardBody className="space-y-3">
              <label className="flex min-h-11 items-start gap-2 text-sm">
                <input type="checkbox" name="levelsEnabled" defaultChecked={s.levelsEnabled} className="mt-1" />
                <span>
                  XP and levels
                  <span className="block text-xs text-ink-3">When off, no XP is awarded and Athlete Home hides the level ring.</span>
                </span>
              </label>
              <label className="flex min-h-11 items-start gap-2 text-sm">
                <input type="checkbox" name="badgesEnabled" defaultChecked={s.badgesEnabled} className="mt-1" />
                <span>
                  Badges
                  <span className="block text-xs text-ink-3">When off, no badges are awarded or shown.</span>
                </span>
              </label>
              <p className="text-xs text-ink-3">The weekly streak, goals and this week&apos;s progress stay on either way. Turning these back on fills in XP and badges from each athlete&apos;s history.</p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="XP per action" kicker="Defaults, adjust freely" />
            <CardBody className="grid gap-3 sm:grid-cols-2">
              {XP_KINDS.map((k) => (
                <Field key={k} label={XP_KIND_LABEL[k]} htmlFor={`xp-${k}`} hint={`Default ${DEFAULT_XP[k]}`}>
                  <Input id={`xp-${k}`} name={k} type="number" min={0} max={MAX_XP_PER_EVENT} step={1} defaultValue={s.xp[k]} required />
                </Field>
              ))}
              <p className="text-xs text-ink-3 sm:col-span-2">
                New values apply to XP earned from now on. XP already earned is never changed. A wellness check-in earns XP for being submitted (once a day); the answers never affect XP.
              </p>
            </CardBody>
          </Card>
          <SubmitButton size="lg">Save engagement settings</SubmitButton>
        </ActionForm>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Levels" kicker="Fixed curve" />
            <CardBody>
              <p className="mb-2 text-sm text-ink-2">Each level takes 100 XP more than the one before.</p>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <li key={n} className="flex justify-between gap-2">
                    <span>
                      {n} · {levelTitle(n)}
                    </span>
                    <span className="tabular text-ink-3">{levelThreshold(n)} XP</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Badge catalog" kicker={`${BADGES.length} badges`} action={s.badgesEnabled ? <Badge variant="green">On</Badge> : <Badge>Off</Badge>} />
            <CardBody>
              <ul className="space-y-2.5">
                {BADGES.map((b) => (
                  <li key={b.key} className="flex items-center gap-3">
                    <BadgeMedallion def={b} size={40} />
                    <span className="min-w-0 text-sm">
                      <span className="font-semibold">{b.name}</span>
                      <span className="block text-xs text-ink-3">{b.description}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
