import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, Select, Textarea, type BadgeVariant } from "@/components/ui";
import { SUBMITTABLE_WIN_TYPES, type WinStatus } from "@/db/schema";
import { type Viewer } from "@/lib/authz/policy";
import { fmt, fmtDate, todayLocal } from "@/lib/time";
import type { WinsAccess } from "@/lib/wins/access";
import { competingThisWeekFamily } from "@/lib/wins/calendar";
import { CONSENT_LABEL, DETAIL_MAX, HEADLINE_MAX, MARKETING_POLICY_TEXT, WIN_STATUS_LABEL, WIN_TYPE_LABEL } from "@/lib/wins/shared";
import { winsForAthlete, type FeedItem, type WinView } from "@/lib/wins/wins";
import { answerConsentAction, answerDraftAction, revokeConsentAction, setSharingAction, submitWinAction, withdrawWinAction } from "@/app/(app)/wins/actions";
import { PhotoUpload } from "./client";

export const STATUS_VARIANT: Record<WinStatus, BadgeVariant> = { awaiting_family: "yellow", pending: "blue", approved: "green", declined: "neutral", removed: "neutral" };

const check = "size-5 shrink-0 rounded border-edge accent-brand";

/** The form everyone uses to add a win: the athlete, a guardian who can act for them, or staff. */
export function WinSubmitForm({ athletes, staff, tz }: { athletes: { id: string; label: string; displayName: string | null }[]; staff: boolean; tz?: string }) {
  if (!athletes.length) return null;
  const today = todayLocal(tz);
  return (
    <ActionForm action={submitWinAction} resetOnSuccess className="space-y-3">
      {athletes.length === 1 ? (
        <input type="hidden" name="athleteId" value={athletes[0].id} />
      ) : (
        <Field label="Athlete" htmlFor="win-athlete" required>
          <Select id="win-athlete" name="athleteId" required defaultValue="">
            <option value="" disabled>
              Choose an athlete
            </option>
            {athletes.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What kind of win?" htmlFor="win-type" required>
          <Select id="win-type" name="type" required defaultValue="placing">
            {SUBMITTABLE_WIN_TYPES.map((t) => (
              <option key={t} value={t}>
                {WIN_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Sport" htmlFor="win-sport" required>
          <Input id="win-sport" name="sport" required maxLength={40} autoComplete="off" />
        </Field>
        <Field label="When did it happen?" htmlFor="win-date" required>
          <Input id="win-date" name="occurredOn" type="date" required defaultValue={today} max={today} />
        </Field>
      </div>
      <Field label="Headline" htmlFor="win-headline" required hint={`One short line, up to ${HEADLINE_MAX} characters. First name only: leave last names out.`}>
        <Input id="win-headline" name="headline" required maxLength={HEADLINE_MAX} autoComplete="off" />
      </Field>
      <Field label="A little more detail (optional)" htmlFor="win-detail" hint={`Up to ${DETAIL_MAX} characters.`}>
        <Textarea id="win-detail" name="detail" rows={2} maxLength={DETAIL_MAX} />
      </Field>
      <Field label="Link to a write-up (optional)" htmlFor="win-link" hint="Only gym staff and your own family see this link. The app never opens or reads it.">
        <Input id="win-link" name="sourceUrl" type="url" inputMode="url" placeholder="https://" autoComplete="off" />
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-2">Once staff approve it, where may it be shown?</legend>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" name="showInApp" defaultChecked className={check} />
          <span>In the app&apos;s Wins feed, for other gym families</span>
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" name="showOnTv" defaultChecked className={check} />
          <span>On the gym TV board</span>
        </label>
        <p className="text-xs text-ink-3">
          {staff
            ? "Shown under the athlete's display name only, and never when the family has hidden the name. Public marketing use is a separate choice only the family can make."
            : "Shown under the display name you chose (for example a first name and last initial), and never when the name is hidden. Public marketing use is a separate choice you make later; it is off unless you turn it on."}
        </p>
      </fieldset>
      <Callout tone="info">Please leave out health, injuries, body weight and school grades. A staff member reviews every win before anyone else sees it. You can add a photo after sending.</Callout>
      <SubmitButton pendingText="Sending…">{staff ? "Add win for review" : "Send to staff"}</SubmitButton>
    </ActionForm>
  );
}

/** One win as the athlete's own family sees it, with the choices that viewer may make. */
export function FamilyWinItem({ w, access, tz }: { w: WinView; access: WinsAccess; tz?: string }) {
  const self = access.relationship === "self";
  const whose = self ? "your" : `${access.firstName}'s`;
  const active = w.status === "pending" || w.status === "approved" || w.status === "awaiting_family";
  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0" id={`win-${w.id}`}>
      <div>
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant="yellow">{w.typeLabel}</Badge>
          <Badge variant={STATUS_VARIANT[w.status]}>{WIN_STATUS_LABEL[w.status]}</Badge>
          <span className="text-xs text-ink-3">
            {w.sport} · {fmtDate(w.occurredOn)}
          </span>
        </p>
        <p className="mt-1 text-[15px] font-semibold text-ink">{w.headline}</p>
        {w.detail ? <p className="text-sm text-ink-2">{w.detail}</p> : null}
        {w.sourceUrl ? (
          <p className="mt-1 text-xs">
            <a href={w.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold text-brand underline">
              Link you added<span className="sr-only"> for {w.headline} (opens in a new tab)</span>
            </a>
          </p>
        ) : null}
        {w.hasPhoto ? (
          <p className="mt-2 flex flex-wrap items-end gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- served by an auth-checked route, not a static asset */}
            <img src={`/api/wins/${w.id}/photo`} alt={`Photo for: ${w.headline}`} className="max-h-40 rounded-md border border-edge" />
            <span className="text-xs text-ink-3">{w.photoApproved ? "Photo approved by staff." : "Photo waiting for staff approval. Only your family and staff see it."}</span>
          </p>
        ) : null}
      </div>

      {w.status === "awaiting_family" ? (
        <Callout tone="warn" title="The gym heard about this. Is it right?">
          <p>A staff member drafted this from something they heard. Nobody else sees it unless you say yes, and staff still review it after that.</p>
          {access.canSubmit ? (
            <ActionForm action={answerDraftAction} className="mt-2 flex flex-wrap gap-2">
              <input type="hidden" name="winId" value={w.id} />
              <SubmitButton name="answer" value="confirm" size="sm">
                Yes, that is right<span className="sr-only">: {w.headline}</span>
              </SubmitButton>
              <SubmitButton name="answer" value="decline" variant="secondary" size="sm">
                No, remove it<span className="sr-only">: {w.headline}</span>
              </SubmitButton>
            </ActionForm>
          ) : (
            <p className="mt-1 text-xs">{self ? "Ask a parent or guardian to answer." : "A parent or guardian who manages bookings for this athlete can answer."}</p>
          )}
        </Callout>
      ) : null}

      {active ? (
        <div className="grid gap-3 rounded-md border border-edge bg-surface-2/50 p-3 sm:grid-cols-2">
          <div>
            <h4 className="text-sm font-semibold">In the gym community</h4>
            {!access.displayName ? <p className="mt-1 text-xs text-ink-2">{self ? "Your" : `${access.firstName}'s`} name is hidden from other families, so this win is not shown to them, whatever is ticked here.</p> : null}
            {access.canSetSharing ? (
              <ActionForm action={setSharingAction} className="mt-1 space-y-1">
                <input type="hidden" name="winId" value={w.id} />
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input type="checkbox" name="showInApp" defaultChecked={w.showInApp} className={check} />
                  <span>
                    Wins feed in the app{access.displayName ? `, as ${access.displayName}` : ""}
                    <span className="sr-only">: {w.headline}</span>
                  </span>
                </label>
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input type="checkbox" name="showOnTv" defaultChecked={w.showOnTv} className={check} />
                  <span>
                    Gym TV board<span className="sr-only">: {w.headline}</span>
                  </span>
                </label>
                <SubmitButton variant="secondary" size="sm">
                  Save<span className="sr-only"> where {w.headline} is shown</span>
                </SubmitButton>
              </ActionForm>
            ) : (
              <p className="mt-1 text-sm text-ink-2">
                Wins feed in the app: <strong>{w.showInApp ? "on" : "off"}</strong>. Gym TV: <strong>{w.showOnTv ? "on" : "off"}</strong>.{" "}
                {self && access.isMinor ? "A parent or guardian can change this." : ""}
              </p>
            )}
            {w.status !== "approved" ? <p className="mt-1 text-xs text-ink-3">Nothing is shown until staff approve it.</p> : null}
          </div>
          <div>
            <h4 className="text-sm font-semibold">Public marketing</h4>
            <p className="mt-1 text-sm text-ink-2">
              Social posts and the gym website: <strong>{CONSENT_LABEL[w.marketingConsent]}</strong>
              {w.marketingConsent !== "none" && w.marketingConsentAt ? ` (${w.marketingConsentByName ?? "family"}, ${fmt(w.marketingConsentAt, "MMM d, yyyy", tz)})` : ""}.
            </p>
            {w.consentRequested ? <p className="mt-1 text-sm font-medium text-ink">The gym would like to share this win publicly. It is your choice, and saying no changes nothing else.</p> : null}
            {w.marketingConsent === "granted" ? (
              access.canWithdraw ? (
                <ActionForm action={revokeConsentAction} className="mt-2">
                  <input type="hidden" name="winId" value={w.id} />
                  <SubmitButton variant="secondary" size="sm" confirm="Withdraw permission for public marketing? The gym is told to stop using this win and to take down posts it controls.">
                    Withdraw permission<span className="sr-only">: {w.headline}</span>
                  </SubmitButton>
                </ActionForm>
              ) : null
            ) : access.canConsent && !access.displayName ? (
              <p className="mt-1 text-xs text-ink-3">Not available while the name is hidden from other families: public marketing would use the display name.</p>
            ) : access.canConsent ? (
              <details className="mt-1">
                <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-brand underline">
                  {w.marketingConsent === "none" ? "Choose" : "Change your answer"}
                  <span className="sr-only">: public marketing for {w.headline}</span>
                </summary>
                <p className="rounded-md border border-edge bg-surface p-2 text-xs text-ink-2">{MARKETING_POLICY_TEXT}</p>
                <ActionForm action={answerConsentAction} className="mt-2 flex flex-wrap gap-2">
                  <input type="hidden" name="winId" value={w.id} />
                  <SubmitButton name="answer" value="grant" size="sm">
                    I agree, allow it<span className="sr-only">: {w.headline}</span>
                  </SubmitButton>
                  {w.marketingConsent === "none" ? (
                    <SubmitButton name="answer" value="decline" variant="secondary" size="sm">
                      No thanks<span className="sr-only">: {w.headline}</span>
                    </SubmitButton>
                  ) : null}
                </ActionForm>
              </details>
            ) : access.consentBlockedReason ? (
              <p className="mt-1 text-xs text-ink-3">{access.consentBlockedReason}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {active && (access.canSubmit || access.canWithdraw) ? (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-2 underline">
            Photo and removal<span className="sr-only">: {w.headline}</span>
          </summary>
          <div className="space-y-3 pt-1">
            {access.canSubmit ? <PhotoUpload winId={w.id} has={w.hasPhoto} /> : null}
            {access.canWithdraw ? (
              <ActionForm action={withdrawWinAction}>
                <input type="hidden" name="winId" value={w.id} />
                <SubmitButton variant="secondary" size="sm" pendingText="Removing…" confirm={`Remove this win from ${whose} profile, the Wins feed, the gym TV and the gym's marketing list?`}>
                  Remove this win<span className="sr-only">: {w.headline}</span>
                </SubmitButton>
              </ActionForm>
            ) : null}
          </div>
        </details>
      ) : null}
    </li>
  );
}

/** The community Wins feed: display names only. */
export function WinsFeedList({ items, empty }: { items: FeedItem[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-ink-3">{empty}</p>;
  return (
    <ul className="divide-y divide-edge">
      {items.map((i) => (
        <li key={i.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
          {i.photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- served by an auth-checked route
            <img src={`/api/wins/${i.id}/photo`} alt="" className="size-16 shrink-0 rounded-md border border-edge object-cover" />
          ) : null}
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-bold">{i.name}</span>
              <Badge variant="yellow">{i.typeLabel}</Badge>
              {i.mine ? <Badge variant="brand">Yours</Badge> : null}
            </p>
            <p className="mt-0.5 font-medium text-ink">{i.headline}</p>
            {i.detail ? <p className="text-sm text-ink-2">{i.detail}</p> : null}
            <p className="mt-0.5 text-xs text-ink-3">
              {i.news ? `${i.news.source} · ` : ""}
              {i.sport} · {i.when}
              {i.news?.url ? (
                <>
                  {" · "}
                  <a href={i.news.url} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold text-brand underline">
                    Read it at {i.news.source}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </>
              ) : null}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** "Teamwork athletes competing this week": display names, sport and day only. */
export async function CompetingFamilyCard({ v, orgName }: { v: Viewer; orgName: string }) {
  const { items, more } = await competingThisWeekFamily(db, v);
  if (!items.length) return null;
  return (
    <Card id="wins-competing">
      <CardHeader title={`${orgName} athletes competing this week`} kicker="Good luck out there" />
      <CardBody>
        <ul className="divide-y divide-edge text-sm">
          {items.map((i, idx) => (
            <li key={idx} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 first:pt-0 last:pb-0">
              <span>
                <span className="font-semibold">{i.name}</span> <span className="text-ink-2">{i.sport}</span>
              </span>
              <span className="text-ink-2">
                {i.kindLabel} · <span className="font-semibold text-ink">{i.day}</span>
              </span>
            </li>
          ))}
        </ul>
        {more ? <p className="mt-2 text-xs text-ink-3">And {more} more.</p> : null}
        <p className="mt-3 text-xs text-ink-3">
          From the seasons families add under On Your Own and team schedules the gym keeps. Names follow each family&apos;s display choice; hidden athletes are never listed. <Link href="/leaderboards#display-names" className="font-semibold text-brand underline">How names appear</Link>
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * Athlete Home: "Your wins". Things waiting for the family first (a draft to confirm, a marketing
 * question), then the latest wins. Renders nothing without profile access.
 */
export async function WinsHomeCard({ v, athleteId, firstName }: { v: Viewer; athleteId: string; firstName: string; tz?: string }) {
  let data: Awaited<ReturnType<typeof winsForAthlete>>;
  try {
    data = await winsForAthlete(db, v, athleteId, { limit: 20 });
  } catch {
    return null;
  }
  const { access, wins } = data;
  const isAthlete = v.role === "athlete";
  const drafts = wins.filter((w) => w.status === "awaiting_family");
  const asks = wins.filter((w) => w.consentRequested && w.status === "approved");
  const recent = wins.filter((w) => w.status === "approved" || w.status === "pending").slice(0, 3);
  return (
    <Card id="wins-home">
      <CardHeader title={isAthlete ? "Your wins" : `${firstName}'s wins`} kicker="Outside the gym" action={<Link href={`/wins?athlete=${athleteId}`} className="text-sm font-semibold text-brand underline">{access.canSubmit ? "Add a win" : "All wins"}</Link>} />
      <CardBody className="space-y-3">
        {drafts.map((w) => (
          <Callout key={w.id} tone="warn" title="The gym heard about a win. Is it right?">
            <p className="font-medium text-ink">{w.headline}</p>
            <p className="mt-1">
              <Link href={`/wins?athlete=${athleteId}#win-${w.id}`} className="font-semibold text-brand underline">
                {access.canSubmit ? "Confirm or remove it" : "See it"}
              </Link>
            </p>
          </Callout>
        ))}
        {asks.map((w) => (
          <Callout key={w.id} tone="info" title="The gym would like to share a win publicly">
            <p className="font-medium text-ink">{w.headline}</p>
            <p className="mt-1">
              {access.canConsent ? (
                <Link href={`/wins?athlete=${athleteId}#win-${w.id}`} className="font-semibold text-brand underline">
                  Read the wording and choose
                </Link>
              ) : (
                (access.consentBlockedReason ?? "A parent or guardian decides.")
              )}
            </p>
          </Callout>
        ))}
        {recent.length ? (
          <ul className="divide-y divide-edge">
            {recent.map((w) => (
              <li key={w.id} className="py-2 text-sm first:pt-0 last:pb-0">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge variant="yellow">{w.typeLabel}</Badge>
                  {w.status === "pending" ? <Badge variant="blue">Waiting for staff review</Badge> : null}
                  <span className="text-xs text-ink-3">{fmtDate(w.occurredOn)}</span>
                </p>
                <p className="mt-1 font-medium text-ink">{w.headline}</p>
              </li>
            ))}
          </ul>
        ) : !drafts.length && !asks.length ? (
          <p className="text-sm text-ink-2">{isAthlete ? "Made a team, set a personal best, won a game? Tell us and we will celebrate it." : `Did ${firstName} make a team, set a personal best or win a game? Tell us and we will celebrate it.`}</p>
        ) : null}
      </CardBody>
    </Card>
  );
}
