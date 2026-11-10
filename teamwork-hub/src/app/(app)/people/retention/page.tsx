import Link from "next/link";
import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { formatMoney } from "@/lib/money";
import { fmt, fmtDate } from "@/lib/time";
import { actionLabel, LEVEL_LABEL, LOSS_REASONS, OUTCOME_LABEL, reasonLabel, RETENTION_ACTION_KINDS, SIGNALS, SIGNAL_KEYS, tenureLabel, type RiskLevel, type SignalKey } from "@/lib/retention/common";
import { filterRadar, retentionRadar, type RadarRow } from "@/lib/retention/radar";
import { recentOutcomes } from "@/lib/retention/save-log";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Callout, EmptyState, Field, PageHeader, Select, StatusBadge, Textarea, buttonClass } from "@/components/ui";
import { KpiTile, MemberAvatar, Widget } from "@/components/profile/studio";
import { PeopleTabs } from "@/components/people-tabs";
import { LevelBadge, RetentionNav } from "@/components/retention/parts";
import { createFollowUpTaskAction, logOutcomeAction } from "./actions";

export const metadata = { title: "Retention radar" };

const LEVELS: { key: string; label: string }[] = [
  { key: "", label: "At risk + watch" },
  { key: "at_risk", label: "At risk" },
  { key: "watch", label: "Watch" },
  { key: "low", label: "Low" },
  { key: "all", label: "Everyone" },
];

function Row({ r, tz, showBilling }: { r: RadarRow; tz: string; showBilling: boolean }) {
  const hid = `rr-${r.athleteId}`;
  return (
    <li className="px-4 py-4 sm:px-5" aria-labelledby={hid}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,19.5rem)]">
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            <MemberAvatar name={r.name} />
            <div className="min-w-0">
              <h3 id={hid} className="text-sm font-semibold">
                <Link href={`/people/${r.personId}`} className="hover:underline">
                  {r.name}
                </Link>
              </h3>
              <div className="mt-0.5 text-xs text-ink-3">{r.plan}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <LevelBadge level={r.level} />
                <StatusBadge status={r.planStatus} />
              </div>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs lg:grid-cols-1">
            {showBilling ? (
              <div>
                <dt className="text-ink-3">Est. monthly value at risk</dt>
                <dd className="text-base font-bold tabular text-ink">{r.valueAtRiskMinor == null ? "not known" : formatMoney(r.valueAtRiskMinor, r.currency)}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-ink-3">Member since</dt>
              <dd className="font-medium text-ink-2">
                {fmtDate(r.memberSince)} · {tenureLabel(r.tenureMonths)}
              </dd>
            </div>
            {r.coaches.length ? (
              <div>
                <dt className="text-ink-3">Coach</dt>
                <dd className="font-medium text-ink-2">{r.coaches.map((c) => c.name).join(", ")}</dd>
              </div>
            ) : null}
          </dl>
        </div>

        <div className="min-w-0">
          <div className="kicker mb-1.5">Signals and evidence</div>
          {r.signals.length === 0 ? (
            <p className="text-sm text-ink-3">No signals. Attending, booked and paid up.</p>
          ) : (
            <ul className="space-y-2">
              {r.signals.map((s) => (
                <li key={s.key} className="text-sm">
                  <Badge variant={s.weight === "high" ? "red" : "yellow"} title={s.weight === "high" ? "High weight: at risk on its own" : "Watch weight"}>
                    {s.label}
                  </Badge>
                  <span className="mt-0.5 block text-[13px] leading-snug text-ink-2">
                    {s.evidence}
                    {s.href ? (
                      <>
                        {" "}
                        <Link href={s.href} className="font-medium text-brand underline">
                          Open the response<span className="sr-only"> from {r.name}</span>
                        </Link>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0 space-y-2 text-sm">
          <div>
            <div className="kicker">Recommended next action</div>
            <p className="font-medium">{r.recommendation.label}</p>
          </div>
          <div className="text-xs text-ink-3">
            <span className="font-semibold text-ink-2">Last contact: </span>
            {r.lastContact ? (
              <>
                {r.lastContact.label} · {fmt(r.lastContact.at, "MMM d, yyyy", tz)}
              </>
            ) : (
              "none on record"
            )}
            {r.lastOutcome ? (
              <span className="mt-0.5 block">
                Last outcome: {OUTCOME_LABEL[r.lastOutcome.outcome as keyof typeof OUTCOME_LABEL] ?? r.lastOutcome.outcome} · {fmt(r.lastOutcome.at, "MMM d", tz)}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-start gap-2 pt-1">
            <ActionForm action={createFollowUpTaskAction}>
              <input type="hidden" name="athleteId" value={r.athleteId} />
              <input type="hidden" name="kind" value="follow_up" />
              <SubmitButton size="sm" pendingText="Creating…">
                Create follow-up task<span className="sr-only"> for {r.name}</span>
              </SubmitButton>
            </ActionForm>
            <ButtonLink href={`/messages/new?athlete=${r.athleteId}`} variant="secondary" size="sm">
              Open conversation<span className="sr-only"> about {r.name}</span>
            </ButtonLink>
          </div>
          <details className="group">
            <summary className={buttonClass("ghost", "sm", "cursor-pointer list-none")}>
              Log outcome<span className="sr-only"> for {r.name}</span>
            </summary>
            <ActionForm action={logOutcomeAction} className="mt-2 space-y-2 rounded-md border border-edge bg-surface-2 p-3" resetOnSuccess>
              <input type="hidden" name="athleteId" value={r.athleteId} />
              <Field label="What you did" htmlFor={`ac-${r.athleteId}`}>
                <Select id={`ac-${r.athleteId}`} name="action" defaultValue="called">
                  {RETENTION_ACTION_KINDS.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Outcome" htmlFor={`oc-${r.athleteId}`}>
                <Select id={`oc-${r.athleteId}`} name="outcome" defaultValue="saved">
                  <option value="saved">Saved</option>
                  <option value="still_at_risk">Still at risk</option>
                  <option value="lost">Lost</option>
                </Select>
              </Field>
              <Field label="Reason (required if lost)" htmlFor={`rc-${r.athleteId}`}>
                <Select id={`rc-${r.athleteId}`} name="reasonCode" defaultValue="">
                  <option value="">Not lost</option>
                  {LOSS_REASONS.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Notes (optional)" htmlFor={`nt-${r.athleteId}`}>
                <Textarea id={`nt-${r.athleteId}`} name="notes" rows={2} maxLength={2000} />
              </Field>
              <SubmitButton size="sm">Save outcome</SubmitButton>
            </ActionForm>
          </details>
        </div>
      </div>
    </li>
  );
}

export default async function RetentionRadarPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const v = await requireCap("retention.view");
  const sp = await searchParams;
  const manager = can(v, "retention.manage");
  const [radar, outcomes] = await Promise.all([retentionRadar(db, v), recentOutcomes(db, v, 8)]);
  const { summary, settings, policy, tz, showBilling } = radar;
  const coaches = [...new Map(radar.rows.flatMap((r) => r.coaches).map((c) => [c.id, c])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const plans = [...new Set(radar.rows.map((r) => r.plan))].sort();
  const level = (["at_risk", "watch", "low", "all"] as const).find((l) => l === sp.level) as RiskLevel | "all" | undefined;
  const signal = SIGNAL_KEYS.find((k) => k === sp.signal) as SignalKey | undefined;
  const coach = coaches.find((c) => c.id === sp.coach)?.id;
  const plan = plans.find((p) => p === sp.plan);
  const sort = (["value", "level", "name"] as const).find((s) => s === sp.sort) ?? (showBilling ? "value" : "level");
  const rows = filterRadar(radar.rows, { level, coach, plan, signal, sort });
  const filtered = !!(level || coach || plan || signal);

  return (
    <>
      <PageHeader
        kicker="People"
        title="Retention radar"
        description={
          v.role === "coach"
            ? "Your assigned athletes who may need a personal touch. Every flag is a plain rule with its evidence. Billing details are not shown to coaches."
            : "Active members who may need a personal touch, most valuable first. Every flag is a plain rule with its evidence: no hidden score. Nothing here contacts a family."
        }
        actions={
          can(v, "settings.manage") ? (
            <ButtonLink href="/settings#retention" variant="secondary">
              Thresholds
            </ButtonLink>
          ) : null
        }
      />
      <PeopleTabs current="retention" showLeads={can(v, "crm.manage")} showRequests={can(v, "people.manage") || can(v, "crm.manage")} />
      <div className="mb-4">
        <RetentionNav current="radar" manager={manager} />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-4">
        <KpiTile icon="people" label="Members at risk" value={summary.atRisk} tone={summary.atRisk ? "bad" : "ok"} hint={`${summary.watch} on watch · ${summary.members} active members`} />
        {showBilling ? (
          <KpiTile icon="billing" label="Monthly revenue at risk (estimate)" value={formatMoney(summary.revenueAtRiskMinor, summary.currency)} tone={summary.revenueAtRiskMinor ? "warn" : "ok"} hint="Plan prices of at-risk members" />
        ) : (
          <KpiTile icon="schedule" label="On watch" value={summary.watch} tone={summary.watch ? "warn" : "ok"} hint="One signal" />
        )}
        <KpiTile icon="shield" label="Saves this month" value={summary.savesThisMonth} tone="ok" hint="Outcomes logged as saved" href={manager ? "/reports/retention-saves" : undefined} />
        <KpiTile icon="clock" label="Average tenure" value={summary.avgTenureMonths == null ? "n/a" : `${summary.avgTenureMonths} mo`} hint="Active members, since first membership" />
      </div>

      <form action="/people/retention" className="mb-4 grid grid-cols-2 items-end gap-3 rounded-md border border-edge bg-surface p-3 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="Level" htmlFor="f-level">
          <Select id="f-level" name="level" defaultValue={level ?? ""}>
            {LEVELS.map((l) => (
              <option key={l.key} value={l.key}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Coach" htmlFor="f-coach">
          <Select id="f-coach" name="coach" defaultValue={coach ?? ""}>
            <option value="">Any coach</option>
            {coaches.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Plan" htmlFor="f-plan">
          <Select id="f-plan" name="plan" defaultValue={plan ?? ""}>
            <option value="">Any plan</option>
            {plans.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Signal" htmlFor="f-signal">
          <Select id="f-signal" name="signal" defaultValue={signal ?? ""}>
            <option value="">Any signal</option>
            {SIGNAL_KEYS.filter((k) => showBilling || (k !== "payment_failed" && k !== "card_expiring")).map((k) => (
              <option key={k} value={k}>
                {SIGNALS[k].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Sort by" htmlFor="f-sort">
          <Select id="f-sort" name="sort" defaultValue={sort}>
            {showBilling ? <option value="value">Value at risk</option> : null}
            <option value="level">Risk level</option>
            <option value="name">Name</option>
          </Select>
        </Field>
        <div className="flex gap-2">
          <button type="submit" className={buttonClass("primary", "md")}>
            Apply
          </button>
          {filtered ? (
            <ButtonLink href="/people/retention" variant="ghost">
              Clear
            </ButtonLink>
          ) : null}
        </div>
      </form>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Widget title={level === "all" ? "All active members" : level ? LEVEL_LABEL[level] : "At risk and watch"} count={rows.length} icon="people" flush>
          {rows.length === 0 ? (
            <div className="p-4">
              <EmptyState title={filtered ? "No members match these filters" : "No members are flagged right now"}>
                {filtered ? "Try clearing a filter." : "Everyone active is attending, booked and paid up by the current thresholds."}
              </EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-edge">
              {rows.map((r) => (
                <Row key={r.athleteId} r={r} tz={tz} showBilling={showBilling} />
              ))}
            </ul>
          )}
        </Widget>

        <div className="grid min-w-0 content-start gap-4">
          <Widget title="Save log" icon="shield" count={outcomes.length} href={manager ? "/reports/retention-saves" : null} linkLabel="Report">
            {outcomes.length === 0 ? (
              <p className="py-2 text-sm text-ink-3">No outcomes logged yet. Use “Log outcome” on a member after you follow up.</p>
            ) : (
              <ul className="divide-y divide-edge text-sm">
                {outcomes.map((o) => (
                  <li key={o.id} className="py-2">
                    <div className="flex items-start justify-between gap-2">
                      <Link href={`/people/${o.personId}`} className="font-medium hover:underline">
                        {o.name}
                      </Link>
                      <Badge variant={o.outcome === "saved" ? "green" : o.outcome === "lost" ? "red" : "yellow"}>{OUTCOME_LABEL[o.outcome]}</Badge>
                    </div>
                    <div className="text-xs text-ink-3">
                      {actionLabel(o.action)}
                      {o.reasonCode ? ` · ${reasonLabel(o.reasonCode)}` : ""} · {o.staff} · {fmt(o.createdAt, "MMM d", tz)}
                    </div>
                    {o.notes ? <p className="mt-0.5 text-xs text-ink-2">{o.notes}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Widget>
          <Callout tone="info" title="How the level is decided">
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
              <li>
                <strong>At risk:</strong> any high-weight signal (no visit in {policy.attendanceGapDays} days{showBilling ? ", failed or past-due payment" : ""}, cancel requested), or {settings.signalsForAtRisk} or more signals together.
              </li>
              <li>
                <strong>Watch:</strong> one watch-weight signal. <strong>Low:</strong> none.
              </li>
              <li>Members on hold are not judged on attendance. Health and wellness answers are never used.</li>
              {showBilling ? <li>Value at risk is an estimate: the primary plan&apos;s monthly price after discounts, not a forecast.</li> : null}
              <li>Thresholds are starting points, not norms. {can(v, "settings.manage") ? "Tune them in Settings." : "An owner or admin can tune them in Settings."}</li>
            </ul>
          </Callout>
        </div>
      </div>
    </>
  );
}
