import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SettingsTabs } from "@/components/settings-tabs";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { NEWS_AUDIENCES, NEWS_SOURCE_KINDS } from "@/db/schema";
import { getOrg, requireCap } from "@/lib/auth/viewer";
import { ensureDefaultSources, listSources, newsOrg, type NewsSource } from "@/lib/newswatch/settings";
import { AUDIENCE_LABEL, DAILY_CAP_MAX, NEWS_USER_AGENT, SOURCE_KIND_LABEL, SOURCE_NAME_MAX, SOURCE_URL_MAX } from "@/lib/newswatch/shared";
import { DEFAULT_TZ, fmt } from "@/lib/time";
import { addSourceAction, deleteSourceAction, saveNewsSettingsAction, toggleSourceAction, updateSourceAction } from "../../wins/news-actions";

export const metadata = { title: "News watch" };

export default async function NewsWatchSettingsPage() {
  const v = await requireCap("settings.manage");
  const org = (await getOrg(v.orgId))!;
  const tz = org.timezone || DEFAULT_TZ;
  await db.transaction((tx) => ensureDefaultSources(tx, v.orgId));
  const s = (await newsOrg(db, v.orgId))!.settings;
  const sources = await listSources(db, v);
  return (
    <>
      <PageHeader
        kicker="Settings"
        title="News watch"
        description="Looks for watched athletes and alumni in the headlines of local news feeds and puts possible matches in Wins, Leads to check. A person approves every clip before anyone else sees it."
      />
      <SettingsTabs current="newswatch" />

      <Callout tone="warn" title="What this can and cannot do" className="mb-4">
        <ul className="list-disc space-y-1 pl-5">
          <li>It reads headlines and short summaries from feeds. It never opens or stores the articles, and never copies their text or pictures.</li>
          <li>Papers behind a paywall are covered only through what their own feed or a news search feed shows. The Hub does not get around paywalls or blocks. A story that names an athlete only inside the article can be missed.</li>
          <li>It can match the wrong person with the same name. That is why nothing is shared until a person approves it, and why &quot;Not our athlete&quot; teaches it.</li>
          <li>A news search feed is a service run by someone else. It can change, stop working or change its terms at any time. Every source below can be switched off, and a licensed news service could replace it later (none is connected).</li>
          <li>Searching by name sends that full name to the search service. Only athletes whose family opted in, and alumni staff put on the watch list, are ever searched.</li>
          <li>Nothing is posted outside this app. Public marketing stays a copy-and-post step for staff, with the family&apos;s separate consent.</li>
          <li>
            The check runs as a nightly job. No background worker is deployed yet, so nothing is monitored on its own until the app is hosted with one. Until then use Run now on{" "}
            <Link href="/settings/jobs" className="font-semibold text-brand underline">
              Scheduled jobs
            </Link>
            .
          </li>
        </ul>
      </Callout>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card id="news-settings">
          <CardHeader title="Switches" kicker={s.enabled ? "News watch is on" : "News watch is off"} />
          <CardBody>
            <ActionForm action={saveNewsSettingsAction} className="space-y-4">
              <label className="flex min-h-11 items-start gap-2 text-sm">
                <input type="checkbox" name="enabled" defaultChecked={s.enabled} className="mt-0.5 size-5 accent-brand" />
                <span>
                  <strong>Read the news sources each night</strong>
                  <span className="block text-ink-3">Off: nothing is requested from any site.</span>
                </span>
              </label>
              <fieldset className="space-y-1">
                <legend className="text-sm font-semibold">Who may approve a clip</legend>
                <p className="text-sm text-ink-3">The owner and admins always can. Every clip needs one of these people to approve it before it is shown. Other staff can only mark &quot;our athlete&quot; or &quot;not our athlete&quot;.</p>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" name="operationsMayApprove" defaultChecked={s.operationsMayApprove} className="size-5 accent-brand" />
                  Also let operations staff approve
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" name="coachesMayApprove" defaultChecked={s.coachesMayApprove} className="size-5 accent-brand" />
                  Also let coaches approve (their own athletes, and alumni)
                </label>
              </fieldset>
              <Field label="Most feed requests per day" htmlFor="nw-cap" hint={`All sources together, 1 to ${DAILY_CAP_MAX}. A news search uses one request per watched person.`}>
                <Input id="nw-cap" name="dailyRequestCap" type="number" min={1} max={DAILY_CAP_MAX} defaultValue={s.dailyRequestCap} required />
              </Field>
              <Field label="Ignore headlines older than (days)" htmlFor="nw-age">
                <Input id="nw-age" name="maxAgeDays" type="number" min={1} max={365} defaultValue={s.maxAgeDays} required />
              </Field>
              <SubmitButton>Save</SubmitButton>
            </ActionForm>
            <p className="mt-4 text-xs text-ink-3">
              The Hub identifies itself to every site as <code className="rounded bg-surface-2 px-1">{NEWS_USER_AGENT}</code>, waits at most 10 seconds, and leaves a failing source alone for a while (30 minutes, doubling, up to a day).
            </p>
            <p className="mt-2 text-sm">
              <Link href="/wins/watch" className="font-semibold text-brand underline">
                Who is watched
              </Link>{" "}
              ·{" "}
              <Link href="/wins/news" className="font-semibold text-brand underline">
                Clips to approve
              </Link>
            </p>
          </CardBody>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          <Card id="news-sources">
            <CardHeader title="Sources" kicker={`${sources.filter((x) => x.enabled).length} on of ${sources.length}`} />
            <CardBody>
              <p className="mb-3 text-sm text-ink-3">The first four are sample defaults for Bloomington, Bedford and Greene County. Change or delete them freely. Use only feeds a publisher offers, or a news search feed, and check that their terms allow this use.</p>
              <ul className="divide-y divide-edge">
                {sources.map((src) => (
                  <SourceRow key={src.id} src={src} tz={tz} />
                ))}
              </ul>
            </CardBody>
          </Card>
          <Card id="add-source">
            <CardHeader title="Add a source" kicker="For example a college athletics site for alumni" />
            <CardBody>
              <SourceForm action={addSourceAction} idp="new" submit="Add source" reset />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

function SourceRow({ src, tz }: { src: NewsSource; tz: string }) {
  return (
    <li className="space-y-2 py-4 first:pt-0 last:pb-0">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{src.name}</span>
        <Badge variant={src.enabled ? "green" : "neutral"}>{src.enabled ? "On" : "Off"}</Badge>
        <Badge variant="neutral">{SOURCE_KIND_LABEL[src.kind]}</Badge>
        {src.isDefault ? <Badge variant="yellow">Sample default</Badge> : null}
      </p>
      <p className="break-all text-xs text-ink-3">
        {src.url}
        {src.kind === "search" ? ` · only ${src.sites.join(", ")}` : ""} · {AUDIENCE_LABEL[src.audience]} · at most every {Math.round(src.minIntervalMinutes / 60)} h
      </p>
      <p className="text-sm">
        {src.lastFetchedAt ? (
          <>
            <span className="text-ink-3">Last read {fmt(src.lastFetchedAt, "EEE MMM d, h:mm a", tz)}: </span>
            <span className={src.lastStatus === "error" ? "font-medium text-bad" : "text-ink-2"}>{src.lastResult ?? "no result recorded"}</span>
            {src.backoffUntil && src.backoffUntil > new Date() ? <span className="text-ink-3"> Next try after {fmt(src.backoffUntil, "EEE h:mm a", tz)}.</span> : null}
          </>
        ) : (
          <span className="text-ink-3">Never read yet.</span>
        )}
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <ActionForm action={toggleSourceAction}>
          <input type="hidden" name="sourceId" value={src.id} />
          <input type="hidden" name="enabled" value={src.enabled ? "off" : "on"} />
          <SubmitButton size="sm" variant="secondary">
            {src.enabled ? "Switch off" : "Switch on"}
            <span className="sr-only">: {src.name}</span>
          </SubmitButton>
        </ActionForm>
        <details className="basis-full">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-brand underline">
            Edit or delete<span className="sr-only">: {src.name}</span>
          </summary>
          <SourceForm action={updateSourceAction} src={src} idp={src.id} submit="Save source" />
          <ActionForm action={deleteSourceAction} className="mt-2">
            <input type="hidden" name="sourceId" value={src.id} />
            <SubmitButton size="sm" variant="ghost" confirm={`Delete the source "${src.name}"? Clips already found stay.`}>
              Delete<span className="sr-only">: {src.name}</span>
            </SubmitButton>
          </ActionForm>
        </details>
      </div>
    </li>
  );
}

function SourceForm({ action, src, idp, submit, reset }: { action: typeof addSourceAction; src?: NewsSource; idp: string; submit: string; reset?: boolean }) {
  return (
    <ActionForm action={action} resetOnSuccess={reset} className="space-y-3">
      {src ? <input type="hidden" name="sourceId" value={src.id} /> : null}
      {src ? <input type="hidden" name="enabled" value={src.enabled ? "on" : "off"} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${idp}-n`} required>
          <Input id={`${idp}-n`} name="name" required maxLength={SOURCE_NAME_MAX} defaultValue={src?.name ?? ""} autoComplete="off" />
        </Field>
        <Field label="Kind" htmlFor={`${idp}-k`} required>
          <Select id={`${idp}-k`} name="kind" defaultValue={src?.kind ?? "rss"}>
            {NEWS_SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {SOURCE_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Feed address" htmlFor={`${idp}-u`} required hint="Starts with https://. For a news search feed, put {query} where the search words go.">
        <Input id={`${idp}-u`} name="url" type="text" inputMode="url" required maxLength={SOURCE_URL_MAX} defaultValue={src?.url ?? ""} autoComplete="off" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Publications (news search only)" htmlFor={`${idp}-s`} hint="Plain domains, comma separated, such as example.com">
          <Input id={`${idp}-s`} name="sites" defaultValue={src?.sites.join(", ") ?? ""} autoComplete="off" />
        </Field>
        <Field label="Look for" htmlFor={`${idp}-a`}>
          <Select id={`${idp}-a`} name="audience" defaultValue={src?.audience ?? "all"}>
            {NEWS_AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {AUDIENCE_LABEL[a]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Read at most every (minutes)" htmlFor={`${idp}-i`} hint="60 or more">
          <Input id={`${idp}-i`} name="minIntervalMinutes" type="number" min={60} max={10080} required defaultValue={src?.minIntervalMinutes ?? 720} />
        </Field>
      </div>
      <SubmitButton size="sm">{submit}</SubmitButton>
    </ActionForm>
  );
}
