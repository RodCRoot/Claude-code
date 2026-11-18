import Link from "next/link";
import { db } from "@/db";
import { resetCheckinSettingsAction, saveCheckinSettingsAction } from "@/app/(app)/check-ins/actions";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SettingsTabs } from "@/components/settings-tabs";
import { Badge, Callout, Card, CardBody, CardHeader, Input, PageHeader, Textarea } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { DISLIKED, FATIGUE, HURT, LIKED, MOOD, POST_NOTE, PRE_NOTE, PRIOR_SORENESS, RATING, READINESS, RPE, SLEEP_HOURS, SLEEP_QUALITY, SORENESS, STRESS } from "@/lib/checkins/questions";
import { checkinSettings, defaultFlags, NUMBER_FIELDS, questionSetVersion, type CheckinSettings } from "@/lib/checkins/settings";
import { retentionContext } from "@/lib/retention/common";

export const metadata = { title: "Session check-ins" };

function Default({ on }: { on: boolean }) {
  return on ? <Badge>Default</Badge> : <Badge variant="blue">Edited</Badge>;
}

function Toggle({ name, label, hint, checked, isDefault }: { name: keyof CheckinSettings; label: string; hint?: string; checked: boolean; isDefault: boolean }) {
  return (
    <label className="flex min-h-11 items-start gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-1 size-4" />
      <span>
        <span className="font-medium">{label}</span> <Default on={isDefault} />
        {hint ? <span className="block text-xs text-ink-3">{hint}</span> : null}
      </span>
    </label>
  );
}

export default async function CheckinSettingsPage() {
  const v = await requireCap("settings.manage");
  const s = await checkinSettings(db, v.orgId);
  const d = defaultFlags(s);
  const { settings: retention } = await retentionContext(db, v.orgId);
  return (
    <>
      <PageHeader kicker="Settings" title="Session check-ins" description="The ready check before each in-gym session and the after check when it ends. Every value here starts as a default you can change. None is a norm or a medical threshold." />
      <SettingsTabs current="check-ins" />
      <ActionForm action={saveCheckinSettingsAction} className="max-w-3xl space-y-5">
        <Card>
          <CardHeader title="What is on" kicker={`Question set ${questionSetVersion(s)}`} />
          <CardBody className="space-y-2">
            <Toggle name="preEnabled" label="Ready check before sessions" checked={s.preEnabled} isDefault={d.preEnabled} />
            <Toggle name="postEnabled" label="After check when a session ends" hint="It replaced the old ten-second rating: the 1 to 5 rating is one of its questions." checked={s.postEnabled} isDefault={d.postEnabled} />
            <Toggle name="kioskOffer" label="Offer the ready check on the kiosk after a PIN check-in" hint="Four taps, skippable, and it goes back to the PIN pad by itself after 25 seconds without a tap." checked={s.kioskOffer} isDefault={d.kioskOffer} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Optional ready-check questions" kicker="Always asked: readiness, sleep quality, soreness, does anything hurt" />
          <CardBody className="space-y-2">
            <Toggle name="askSleepHours" label={`"${SLEEP_HOURS.question}"`} checked={s.askSleepHours} isDefault={d.askSleepHours} />
            <Toggle name="askFatigue" label={`"${FATIGUE.question}"`} checked={s.askFatigue} isDefault={d.askFatigue} />
            <Toggle name="askMood" label={`"${MOOD.question}"`} checked={s.askMood} isDefault={d.askMood} />
            <Toggle name="askStress" label={`"${STRESS.question}"`} checked={s.askStress} isDefault={d.askStress} />
            <Toggle name="askPriorSoreness" label={`"${PRIOR_SORENESS.question}"`} hint="Asked once per session, inside the next ready check, so soreness after a session can be set beside its load." checked={s.askPriorSoreness} isDefault={d.askPriorSoreness} />
            <p className="text-xs text-ink-3">Sleep, tiredness, mood and stress are the same items as the daily wellness check-in. If an athlete already answered one today it is reused, not asked again.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Quick chips" kicker="One per line, 12 at most, 40 characters each" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="likedChips" className="mb-1 flex items-center gap-2 text-sm font-semibold">
                &quot;{LIKED.question}&quot; <Default on={d.likedChips} />
              </label>
              <Textarea id="likedChips" name="likedChips" rows={9} defaultValue={s.likedChips.map((c) => c.label).join("\n")} />
            </div>
            <div>
              <label htmlFor="dislikedChips" className="mb-1 flex items-center gap-2 text-sm font-semibold">
                &quot;{DISLIKED.question}&quot; <Default on={d.dislikedChips} />
              </label>
              <Textarea id="dislikedChips" name="dislikedChips" rows={9} defaultValue={s.dislikedChips.map((c) => c.label).join("\n")} />
              <p className="mt-1 text-xs text-ink-3">&quot;{DISLIKED.nothing}&quot; is always offered as a one-tap answer.</p>
            </div>
            <p className="text-xs text-ink-3 sm:col-span-2">Changing chips or optional questions starts a new question-set number. Earlier answers keep the chip text they were given with.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Windows and alert thresholds" />
          <CardBody className="space-y-3">
            {NUMBER_FIELDS.map((f) => (
              <div key={f.key} className="grid gap-1 sm:grid-cols-[1fr_8rem] sm:items-center">
                <label htmlFor={f.key} className="text-sm">
                  <span className="font-medium">{f.label}</span> <Default on={d[f.key]} />
                  {f.hint ? <span className="block text-xs text-ink-3">{f.hint}</span> : null}
                </label>
                <Input id={f.key} name={f.key} type="number" min={f.min} max={f.max} step={f.step ?? 1} defaultValue={String(s[f.key])} required />
              </div>
            ))}
            <Callout tone="info">
              Always alerted, with no threshold: sharp pain, something hurting two sessions in a row, and any &quot;did not like&quot; comment. A low rating uses the retention setting (currently {retention.lowRatingThreshold} or lower), and ratings stay open for {retention.feedbackEntryDays} days:{" "}
              <Link href="/settings#retention" className="underline">
                retention thresholds
              </Link>
              . Alerts are tasks for staff. Nothing is ever sent to a family.
            </Callout>
          </CardBody>
        </Card>
        <SubmitButton className="min-h-11" pendingText="Saving…">
          Save check-in settings
        </SubmitButton>
      </ActionForm>
      <ActionForm action={resetCheckinSettingsAction} className="mt-3 max-w-3xl">
        <SubmitButton variant="ghost" confirm="Reset every check-in setting, including the chips, to the defaults?" pendingText="Resetting…">
          Reset to defaults
        </SubmitButton>
      </ActionForm>

      <Card className="mt-6 max-w-3xl">
        <CardHeader title="The questions, word for word" kicker="Read-only" />
        <CardBody className="space-y-3 text-sm">
          <div>
            <h3 className="font-semibold">Ready check</h3>
            <ol className="list-decimal space-y-0.5 pl-5 text-ink-2">
              <li>{READINESS.question} ({READINESS.options.map((o) => o.label).join(" / ")})</li>
              <li>{SLEEP_QUALITY.question} ({SLEEP_QUALITY.options.map((o) => o.label).join(" / ")})</li>
              <li>{SLEEP_HOURS.question} (optional)</li>
              <li>{SORENESS.preQuestion} (0 Not sore to 10 Worst ever)</li>
              <li>{HURT.preQuestion} (No, all good / {HURT.preToggle}; then where, {HURT.types.map((t) => t.label).join(" or ")}, {HURT.levels.map((l) => l.label).join(" / ")})</li>
              <li>{FATIGUE.question} ({FATIGUE.options.map((o) => o.label).join(" / ")})</li>
              <li>{MOOD.question} ({MOOD.options.map((o) => o.label).join(" / ")})</li>
              <li>{STRESS.question} ({STRESS.options.map((o) => o.label).join(" / ")})</li>
              <li>{PRIOR_SORENESS.question} (0 to 10, optional)</li>
              <li>{PRE_NOTE.question} (optional)</li>
            </ol>
          </div>
          <div>
            <h3 className="font-semibold">After check</h3>
            <ol className="list-decimal space-y-0.5 pl-5 text-ink-2">
              <li>{RPE.question} (0 Rest, 2 Easy, 3 Moderate, 5 Hard, 7 Very hard, 10 Max effort)</li>
              <li>{LIKED.question} (chips, optional text)</li>
              <li>{DISLIKED.question} (&quot;{DISLIKED.nothing}&quot;, chips, optional text)</li>
              <li>{HURT.postQuestion} (then where, what it feels like, how much, and: {HURT.startedQuestion})</li>
              <li>{SORENESS.postQuestion} (0 to 10)</li>
              <li>{RATING.question} ({RATING.options.map((o) => `${o.value} ${o.label}`).join(" / ")})</li>
              <li>{POST_NOTE.question} (optional)</li>
            </ol>
          </div>
          <p className="text-xs text-ink-3">Shown when sharp pain is picked: &quot;{HURT.sharpNote}&quot;</p>
        </CardBody>
      </Card>
    </>
  );
}
