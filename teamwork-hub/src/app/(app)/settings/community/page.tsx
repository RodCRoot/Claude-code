import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SettingsTabs } from "@/components/settings-tabs";
import { Badge, Card, CardBody, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { DISPLAY_NAME_MODES } from "@/db/schema";
import { getOrg, requireCap } from "@/lib/auth/viewer";
import { listDisplayTokens, MAX_ACTIVE_DISPLAYS } from "@/lib/community/board";
import { communitySettingsOf, ORG_MESSAGE_MAX, ROTATION_MAX, ROTATION_MIN, SHOUTOUT_LIMIT_MAX } from "@/lib/community/settings";
import { DISPLAY_MODE_HINT, DISPLAY_MODE_LABEL, PANEL_KEYS, PANEL_LABEL } from "@/lib/community/shared";
import { fmt } from "@/lib/time";
import { OneTimeLinkForm } from "../users/client";
import { createDisplayAction, revokeDisplayAction, saveCommunitySettingsAction } from "./actions";

export const metadata = { title: "Community settings" };

const PANEL_HINT: Record<(typeof PANEL_KEYS)[number], string> = {
  pr_bell: "Measured PRs set this week: name, lift, new value and the gain.",
  streaks: "The longest current weekly streaks.",
  level_ups: "Athletes who reached a new level or earned a badge this week.",
  leaderboards: "Rotating boards by age group. Measured maxes only.",
  classes: "Time, class, coach and spots left. Never who is booked.",
  milestones: "Session counts and membership milestones. Never birthdays.",
  shoutouts: "Coach shoutouts from the last 7 days.",
  challenges: "Current team challenges and their progress.",
  message: "The gym message below, when one is set.",
};

export default async function CommunitySettingsPage() {
  const v = await requireCap("settings.manage");
  const org = (await getOrg(v.orgId))!;
  const s = communitySettingsOf(org.settings);
  const tz = org.timezone;
  const displays = await listDisplayTokens(db, v);
  const active = displays.filter((d) => !d.revokedAt);
  return (
    <>
      <PageHeader
        kicker="Settings"
        title="Community"
        description="The gym TV board, leaderboards, coach shoutouts and team challenges. Families choose how each athlete is named, or hide them. Nothing here ever shows last names, ages, health or billing. Changes are audited."
      />
      <SettingsTabs current="community" />
      <div className="grid gap-5 lg:grid-cols-2">
        <ActionForm action={saveCommunitySettingsAction} className="space-y-5">
          <Card>
            <CardHeader title="Community features" action={s.enabled ? <Badge variant="green">On</Badge> : <Badge>Off</Badge>} />
            <CardBody className="space-y-4">
              <label className="flex min-h-11 items-start gap-2 text-sm">
                <input type="checkbox" name="enabled" defaultChecked={s.enabled} className="mt-1" />
                <span>
                  Turn on the gym TV board, leaderboards, shoutouts and challenges
                  <span className="block text-xs text-ink-3">When off, the TV shows a plain welcome screen, the Leaderboards page is empty and no shoutouts can be posted.</span>
                </span>
              </label>
              <Field label="Default name on boards" htmlFor="cm-mode" hint="Used until a family picks something else. A guardian chooses for athletes under 18; adults choose for themselves.">
                <Select id="cm-mode" name="defaultDisplayMode" defaultValue={s.defaultDisplayMode}>
                  {DISPLAY_NAME_MODES.map((m) => (
                    <option key={m} value={m}>
                      {DISPLAY_MODE_LABEL[m]}
                    </option>
                  ))}
                </Select>
              </Field>
              <ul className="space-y-0.5 text-xs text-ink-3">
                {DISPLAY_NAME_MODES.map((m) => (
                  <li key={m}>
                    <span className="font-semibold text-ink-2">{DISPLAY_MODE_LABEL[m]}:</span> {DISPLAY_MODE_HINT[m]}
                  </li>
                ))}
              </ul>
              <Field label="Shoutouts per staff member per day" htmlFor="cm-limit" hint="A starting default, not a rule. Removed shoutouts still count for the day.">
                <Input id="cm-limit" name="shoutoutDailyLimit" type="number" min={1} max={SHOUTOUT_LIMIT_MAX} step={1} defaultValue={s.shoutoutDailyLimit} required />
              </Field>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Gym TV panels" kicker="Shown in rotation" />
            <CardBody className="space-y-3">
              <fieldset>
                <legend className="sr-only">Panels on the gym TV</legend>
                <div className="space-y-1">
                  {PANEL_KEYS.map((k) => (
                    <label key={k} className="flex min-h-11 items-start gap-2 text-sm">
                      <input type="checkbox" name="panels" value={k} defaultChecked={s.panels[k]} className="mt-1" />
                      <span>
                        {PANEL_LABEL[k]}
                        <span className="block text-xs text-ink-3">{PANEL_HINT[k]}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label="Seconds per panel" htmlFor="cm-rot" hint={`${ROTATION_MIN} to ${ROTATION_MAX}. Panels cut from one to the next with no animation and no sound.`}>
                <Input id="cm-rot" name="rotationSeconds" type="number" min={ROTATION_MIN} max={ROTATION_MAX} step={1} defaultValue={s.rotationSeconds} required />
              </Field>
              <Field label="Gym message (optional)" htmlFor="cm-msg" hint={`Plain text, up to ${ORG_MESSAGE_MAX} characters. Shown as its own panel.`}>
                <Input id="cm-msg" name="orgMessage" maxLength={ORG_MESSAGE_MAX} defaultValue={s.orgMessage ?? ""} autoComplete="off" />
              </Field>
            </CardBody>
          </Card>
          <SubmitButton size="lg">Save community settings</SubmitButton>
        </ActionForm>

        <div className="space-y-5">
          <Card id="displays">
            <CardHeader title="Gym TV screens" kicker={`${active.length} of ${MAX_ACTIVE_DISPLAYS} connected`} action={<Link href="/display" className="text-sm font-semibold text-brand underline">Preview the board</Link>} />
            <CardBody className="space-y-4">
              <p className="text-sm text-ink-2">
                A screen is not a login. Its link can only show the board: it cannot open any other page, and it cannot change anything. Revoke a screen and it goes blank within a minute.
              </p>
              {displays.length === 0 ? <p className="text-sm text-ink-3">No screens yet.</p> : null}
              <ul className="divide-y divide-edge">
                {displays.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span className="min-w-0">
                      <span className="block font-semibold">{d.label}</span>
                      <span className="block text-xs text-ink-3">
                        Added {fmt(d.createdAt, "MMM d, yyyy", tz)}
                        {d.createdBy ? ` by ${d.createdBy}` : ""} · {d.lastSeenAt ? `last seen ${fmt(d.lastSeenAt, "MMM d, h:mm a", tz)}` : "never opened"}
                      </span>
                    </span>
                    {d.revokedAt ? (
                      <Badge>Revoked {fmt(d.revokedAt, "MMM d", tz)}</Badge>
                    ) : (
                      <ActionForm action={revokeDisplayAction}>
                        <input type="hidden" name="id" value={d.id} />
                        <SubmitButton variant="secondary" size="sm" pendingText="Revoking…" confirm="Revoke this screen? It stops showing the board and its link never works again.">
                          Revoke<span className="sr-only">: {d.label}</span>
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
              <div className="rounded-md border border-edge p-3">
                <h3 className="text-sm font-semibold">Add a screen</h3>
                <OneTimeLinkForm action={createDisplayAction} submitLabel="Create screen link">
                  <Field label="Screen name" htmlFor="cm-screen" hint="For example Front lobby TV. Open the link once in the TV's browser, then leave it running.">
                    <Input id="cm-screen" name="label" maxLength={60} required autoComplete="off" />
                  </Field>
                </OneTimeLinkForm>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="What the board can show" />
            <CardBody>
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
                <li>First names with a last initial, or first names only, as each family chose. Hidden athletes never appear.</li>
                <li>Athletes are only ranked inside their own age group (U12, U14, U16, U18, Adults). Ages are never shown.</li>
                <li>Measured maxes only. Estimated maxes and body weight are never shown.</li>
                <li>No birthdays, health details, billing details or class lists.</li>
              </ul>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
