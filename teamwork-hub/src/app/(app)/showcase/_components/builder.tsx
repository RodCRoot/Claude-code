"use client";

import { startTransition, useActionState, useMemo, useState } from "react";
import { FormMessage, SubmitButton, type ActionState } from "@/components/forms";
import { ShowcaseSheet } from "@/components/showcase/sheet";
import { Card, CardBody, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";
import type { ShowcaseConfig } from "@/db/schema";
import { MAX_BIO, MAX_LIFTS, MAX_METRICS, SHOW_LABEL, describeConfig, type ShowcaseShowKey } from "@/lib/showcase/allowlist";
import { composeShowcase, formatValue, prettyDate, type ShowcaseCatalog, type ShowcaseOrg } from "@/lib/showcase/compose";

type ServerAction = (prev: ActionState, fd: FormData) => Promise<ActionState>;

export type BuilderProps = {
  athleteId: string;
  firstName: string;
  catalog: ShowcaseCatalog;
  initial: ShowcaseConfig;
  org: ShowcaseOrg;
  asOf: string;
  canDraft: boolean;
  canPublish: boolean;
  canSeeTraining: boolean;
  publishBlockedReason: string | null;
  published: boolean;
  defaultExpiryDays: number;
  expiryChoices: number[];
  policyText: string;
  saveAction: ServerAction;
};

/** The link is shown once (only its hash is stored), so make copying it hard to miss. */
export function ShareLinkBox({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? path : `${window.location.origin}${path}`;
  return (
    <div className="mt-3 rounded-lg border border-ok/30 bg-ok/5 p-3">
      <label htmlFor="share-link" className="block text-sm font-semibold">
        Your Showcase link
      </label>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <input id="share-link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="h-10 min-w-0 flex-1 rounded-md border border-edge bg-surface px-3 font-mono text-xs text-ink" />
        <button
          type="button"
          className="h-10 rounded-md bg-brand px-4 text-sm font-semibold text-brand-ink"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <p className="mt-1.5 text-xs text-ink-2" role="status">
        Save this link now. It is not shown again. If you lose it, make a new link and the old one stops working.
      </p>
    </div>
  );
}

function Check({ name, value, checked, onChange, disabled, children, hint }: { name: string; value?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <label className={`flex min-h-11 items-start gap-2.5 rounded-md px-1 py-1.5 text-sm ${disabled ? "opacity-60" : "hover:bg-surface-2"}`}>
      <input type="checkbox" name={name} value={value ?? "on"} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">
        <span className="font-medium">{children}</span>
        {hint ? <span className="block text-xs text-ink-3">{hint}</span> : null}
      </span>
    </label>
  );
}

export function ShowcaseBuilder(p: BuilderProps) {
  const [cfg, setCfg] = useState<ShowcaseConfig>(p.initial);
  const [state, formAction, pending] = useActionState(p.saveAction, {} as ActionState);
  const data = useMemo(() => composeShowcase(p.catalog, cfg, p.org, p.asOf), [p.catalog, cfg, p.org, p.asOf]);
  const a = p.catalog.athlete;
  const locked = !p.canDraft;
  const setShow = (k: ShowcaseShowKey, v: boolean) => setCfg((c) => ({ ...c, show: { ...c.show, [k]: v } }));
  const toggle = (key: "metricIds" | "exerciseIds", id: string, on: boolean, max: number) =>
    setCfg((c) => ({ ...c, [key]: on ? (c[key].includes(id) || c[key].length >= max ? c[key] : [...c[key], id]) : c[key].filter((x) => x !== id) }));

  const profile: [ShowcaseShowKey, string | null][] = [
    ["sport", a.sport],
    ["position", a.position],
    ["gradYear", a.gradYear ? `Class of ${a.gradYear}` : null],
    ["school", a.school],
    ["ageBand", a.ageBand],
    ["weight", a.weightLb !== null ? `${Math.round(a.weightLb)} lb` : null],
  ];
  const hasWeight = a.weightLb !== null;
  // What would actually be shared: an item that is not on file cannot be shown, whatever the saved choice says.
  const available: Record<ShowcaseShowKey, boolean> = {
    sport: !!a.sport, position: !!a.position, gradYear: !!a.gradYear, school: !!a.school, ageBand: !!a.ageBand, weight: hasWeight,
    sessions: !!p.catalog.consistency, streak: !!p.catalog.consistency, memberSince: !!p.catalog.consistency?.memberSince, relativeStrength: hasWeight && data.lifts.length > 0,
  };
  const effective: ShowcaseConfig = { ...cfg, show: Object.fromEntries(Object.entries(cfg.show).map(([k, on]) => [k, on && available[k as ShowcaseShowKey]])) as ShowcaseConfig["show"] };
  const sharing = describeConfig(effective, { metrics: data.tiles.length, lifts: data.lifts.length });

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <form
        aria-busy={pending}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
          startTransition(() => formAction(fd));
        }}
      >
        <input type="hidden" name="athleteId" value={p.athleteId} />
        <fieldset disabled={locked} className="space-y-4">
          <legend className="sr-only">Choose what the Showcase shows</legend>
          <Card>
            <CardHeader title="Name and profile" kicker="Step 1" />
            <CardBody className="space-y-3">
              <Field label="Name shown" htmlFor="sc-name" hint="The link itself never contains a name.">
                <Select id="sc-name" name="nameDisplay" value={cfg.nameDisplay} onChange={(e) => setCfg((c) => ({ ...c, nameDisplay: e.target.value as ShowcaseConfig["nameDisplay"] }))}>
                  <option value="first">First name only ({a.firstName})</option>
                  <option value="first_initial">
                    First name and last initial ({a.firstName} {a.lastName.slice(0, 1)}.)
                  </option>
                  <option value="full">
                    Full name ({a.firstName} {a.lastName})
                  </option>
                </Select>
              </Field>
              <div>
                {profile.map(([k, value]) => (
                  <Check key={k} name={`show.${k}`} checked={cfg.show[k] && value !== null} disabled={value === null} onChange={(v) => setShow(k, v)} hint={value ?? "Not on file. Ask the front desk to add it."}>
                    {SHOW_LABEL[k]}
                  </Check>
                ))}
              </div>
              <Field label="Short bio" htmlFor="sc-bio" hint={`${cfg.bio.length} of ${MAX_BIO} characters. Plain text.`}>
                <Textarea id="sc-bio" name="bio" rows={4} maxLength={MAX_BIO} value={cfg.bio} onChange={(e) => setCfg((c) => ({ ...c, bio: e.target.value }))} placeholder="Two or three sentences about who you are as an athlete and what you are working toward." />
              </Field>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Test results" kicker={`Step 2 · ${cfg.metricIds.length} of ${MAX_METRICS} chosen`} />
            <CardBody>
              {!p.canSeeTraining ? (
                <p className="text-sm text-ink-2">Your account does not have training access for {p.firstName}, so test results, lifts and training numbers are not shown here and cannot be changed from this account.</p>
              ) : p.catalog.metrics?.length ? (
                <div>
                  {p.catalog.metrics.map((m) => (
                    <Check
                      key={m.id}
                      name="metricIds"
                      value={m.id}
                      checked={cfg.metricIds.includes(m.id)}
                      disabled={!cfg.metricIds.includes(m.id) && cfg.metricIds.length >= MAX_METRICS}
                      onChange={(v) => toggle("metricIds", m.id, v, MAX_METRICS)}
                      hint={
                        <>
                          Latest {formatValue(m.latest.value, m.precision)} {m.unit} on {prettyDate(m.latest.date)}
                          {m.latest.verified ? " · verified" : " · not verified"}
                          {m.trend.length >= 3 ? ` · trend from ${m.trend.length} tests` : ""}
                        </>
                      }
                    >
                      {m.name}
                    </Check>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-ink-3">No test results on file yet. They appear here after your first testing day.</p>
              )}
            </CardBody>
          </Card>

          {p.canSeeTraining ? (
            <Card>
              <CardHeader title="Strength and consistency" kicker={`Step 3 · ${cfg.exerciseIds.length} of ${MAX_LIFTS} lifts`} />
              <CardBody className="space-y-3">
                {p.catalog.lifts?.length ? (
                  <div>
                    {p.catalog.lifts.map((l) => (
                      <Check
                        key={l.exerciseId}
                        name="exerciseIds"
                        value={l.exerciseId}
                        checked={cfg.exerciseIds.includes(l.exerciseId)}
                        disabled={!cfg.exerciseIds.includes(l.exerciseId) && cfg.exerciseIds.length >= MAX_LIFTS}
                        onChange={(v) => toggle("exerciseIds", l.exerciseId, v, MAX_LIFTS)}
                        hint={`${l.value} ${l.unit} · ${l.basis === "measured" ? "measured" : "estimated"} · ${prettyDate(l.date)}`}
                      >
                        {l.name}
                      </Check>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-ink-3">No lift maxes on file yet.</p>
                )}
                <div className="border-t border-edge pt-2">
                  <Check name="show.relativeStrength" checked={cfg.show.relativeStrength && hasWeight} disabled={!hasWeight} onChange={(v) => setShow("relativeStrength", v)} hint={hasWeight ? "Shows each lift as a multiple of body weight." : "Needs a body weight on file."}>
                    {SHOW_LABEL.relativeStrength}
                  </Check>
                  <Check name="show.sessions" checked={cfg.show.sessions} onChange={(v) => setShow("sessions", v)} hint={`${p.catalog.consistency?.sessions12mo ?? 0} sessions. A count only, never dates or times.`}>
                    {SHOW_LABEL.sessions}
                  </Check>
                  <Check name="show.streak" checked={cfg.show.streak} onChange={(v) => setShow("streak", v)} hint={`${p.catalog.consistency?.streakWeeks ?? 0} weeks in a row`}>
                    {SHOW_LABEL.streak}
                  </Check>
                  <Check name="show.memberSince" checked={cfg.show.memberSince && !!p.catalog.consistency?.memberSince} disabled={!p.catalog.consistency?.memberSince} onChange={(v) => setShow("memberSince", v)} hint={p.catalog.consistency?.memberSince ? "Month and year only" : "No membership start on file"}>
                    {SHOW_LABEL.memberSince}
                  </Check>
                </div>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Film and contact" kicker="Optional" />
            <CardBody className="space-y-3">
              <Field label="Highlight video link" htmlFor="sc-video" hint="Must start with https://. Shown as a link, never played on the page.">
                <Input id="sc-video" name="videoUrl" type="url" inputMode="url" placeholder="https://" value={cfg.videoUrl ?? ""} onChange={(e) => setCfg((c) => ({ ...c, videoUrl: e.target.value || null }))} />
              </Field>
              <Field label="Contact email to show" htmlFor="sc-contact" hint="Leave blank to show no contact. We never show the emails or phone numbers on your account.">
                <Input id="sc-contact" name="contactEmail" type="email" autoComplete="off" value={cfg.contactEmail ?? ""} onChange={(e) => setCfg((c) => ({ ...c, contactEmail: e.target.value || null }))} />
              </Field>
            </CardBody>
          </Card>
        </fieldset>

        <Card>
          <CardHeader title={p.canPublish ? "Save or publish" : "Save your draft"} />
          <CardBody className="space-y-3">
            {p.canDraft ? (
              <div>
                <SubmitButton name="intent" value="save" variant="secondary">
                  Save draft
                </SubmitButton>
                {p.published ? <p className="mt-1.5 text-xs text-ink-3">Saving a change pauses the shared link until it is published again, so the page never shows something nobody agreed to.</p> : null}
              </div>
            ) : null}
            {p.canPublish ? (
              <div className="space-y-3 border-t border-edge pt-3">
                <div>
                  <p className="text-sm font-semibold">This Showcase will share:</p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-ink-2">
                    {sharing.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
                <Field label="Link works for" htmlFor="sc-expiry">
                  <Select id="sc-expiry" name="expiryDays" defaultValue={String(p.defaultExpiryDays)}>
                    {p.expiryChoices.map((d) => (
                      <option key={d} value={d}>
                        {d === 0 ? "Until I turn it off" : `${d} days`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <label className="flex items-start gap-2.5 text-sm">
                  <input type="checkbox" name="consent" className="mt-0.5 size-4 shrink-0" />
                  <span className="text-ink-2">{p.policyText}</span>
                </label>
                <SubmitButton name="intent" value="publish" size="lg" pendingText="Publishing…">
                  {p.published ? "Publish changes" : "Publish Showcase"}
                </SubmitButton>
              </div>
            ) : p.publishBlockedReason ? (
              <p className="rounded-md border border-info/30 bg-info/5 px-3 py-2 text-sm text-ink-2">{p.publishBlockedReason}</p>
            ) : null}
            <FormMessage state={state} />
            {state.ok && typeof state.data?.sharePath === "string" ? <ShareLinkBox path={state.data.sharePath} /> : null}
          </CardBody>
        </Card>
      </form>

      <section aria-labelledby="sc-preview-h" className="min-w-0">
        <div className="sticky top-20">
          <h2 id="sc-preview-h" className="kicker mb-2">
            Live preview · what a coach will see
          </h2>
          <ShowcaseSheet data={data} preview />
        </div>
      </section>
    </div>
  );
}

