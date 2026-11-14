import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { ChallengeCard, LeaderboardCard } from "@/components/community/cards";
import { DisplayModeForm } from "@/components/community/display-mode-form";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, Select } from "@/components/ui";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { accessibleAthleteIds, can, isStaff } from "@/lib/authz/policy";
import { challengeViews, listChallengesForStaff, syncChallengeCompletions } from "@/lib/community/challenges";
import { displayModeAccess, type DisplayModeAccess } from "@/lib/community/display-name";
import { leaderboardsFor } from "@/lib/community/leaderboards";
import { CHALLENGE_METRIC_LABEL, CHALLENGE_MODE_LABEL } from "@/lib/community/shared";
import { addDaysYmd, fmtDate, todayLocal } from "@/lib/time";
import { ModuleHero } from "../training/_components/tb";
import { archiveChallengeAction, createChallengeAction } from "./actions";

export const metadata = { title: "Leaderboards" };

const pill = (current: boolean) =>
  `inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold ${current ? "bg-[#4fc3f7] text-[#0b1a2e]" : "bg-white/10 text-white ring-1 ring-white/25 hover:bg-white/20"}`;

export default async function LeaderboardsPage({ searchParams }: { searchParams: Promise<{ band?: string; group?: string }> }) {
  const v = await requireViewer();
  if (!isStaff(v) && v.role !== "guardian" && v.role !== "athlete") redirect("/denied");
  const sp = await searchParams;
  const tz = (await getOrg(v.orgId))?.timezone;
  const staff = isStaff(v);
  const isAthlete = v.role === "athlete";

  const { view, challenges } = await db.transaction(async (tx) => {
    const view = await leaderboardsFor(tx, v, { band: sp.band, groupId: sp.group });
    if (!view.enabled) return { view, challenges: [] };
    await syncChallengeCompletions(tx, v.orgId);
    const own = staff ? [] : await accessibleAthleteIds(tx, v, "training.read");
    return { view, challenges: await challengeViews(tx, v.orgId, { ownIds: new Set(own === "all" ? [] : own) }) };
  });

  if (!view.enabled) {
    return (
      <div className="mx-auto max-w-5xl">
        <ModuleHero kicker="Community" title="Leaderboards" />
        <EmptyState title="Community features are turned off">{can(v, "settings.manage") ? <Link href="/settings/community" className="font-semibold text-brand underline">Turn them on in Settings, Community</Link> : "Leaderboards, challenges and shoutouts are not in use at this gym right now."}</EmptyState>
      </div>
    );
  }

  // How each of the viewer's own athletes is named (families only).
  const linked = staff ? [] : await accessibleAthleteIds(db, v, "profile.read");
  const names: DisplayModeAccess[] = [];
  for (const id of linked === "all" ? [] : linked) names.push(await displayModeAccess(db, v, id));
  const manage = staff ? await listChallengesForStaff(db, v) : null;
  const today = todayLocal(tz);
  const href = (band: string, group?: string | null) => `/leaderboards?band=${band}${group ? `&group=${group}` : ""}`;
  // Families only see challenges their athletes are part of, or gym-wide ones.
  const shownChallenges = staff ? challenges : challenges.filter((c) => c.you.length || !c.groupName);

  return (
    <div className="mx-auto max-w-6xl">
      <ModuleHero
        kicker="Community"
        title="Leaderboards"
        description={
          staff
            ? "This is what families see. Athletes are ranked inside their own age group, with measured maxes only. Hidden athletes are not listed here either."
            : "Ranked inside your own age group, with measured maxes only. Every board has room for effort: showing up, streaks and most improved count as much as the biggest lift."
        }
      >
        {view.bands.length > 1 ? (
          <nav aria-label="Age group" className="flex flex-wrap gap-2">
            {view.bands.map((b) => (
              <Link key={b} href={href(b)} aria-current={b === view.band ? "true" : undefined} className={pill(b === view.band)}>
                {b === "Adult" ? "Adults" : b}
              </Link>
            ))}
          </nav>
        ) : null}
      </ModuleHero>

      {view.unbanded.length ? (
        <Callout tone="info" className="mb-4">
          {view.unbanded.join(" and ")} {view.unbanded.length === 1 ? "is" : "are"} not on the boards yet: we need a birthday on file to pick the right age group. Message the front desk to add it.
        </Callout>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {shownChallenges.length ? (
            <section aria-labelledby="lb-challenges" className="space-y-3">
              <h2 id="lb-challenges" className="kicker">
                Team challenges
              </h2>
              <div className={`grid gap-4 ${shownChallenges.length > 1 ? "sm:grid-cols-2" : ""}`}>
                {shownChallenges.map((c) => (
                  <ChallengeCard key={c.id} c={c} isAthlete={isAthlete} />
                ))}
              </div>
            </section>
          ) : null}

          <section aria-labelledby="lb-boards" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="lb-boards" className="kicker">
                {view.band === "Adult" ? "Adults" : view.band} boards
              </h2>
              {view.band && view.groups.length ? (
                <nav aria-label="Training group" className="flex flex-wrap gap-1.5">
                  <Link href={href(view.band)} aria-current={!view.groupId ? "true" : undefined} className={`inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-semibold ${!view.groupId ? "border-brand bg-brand text-brand-ink" : "border-edge bg-surface text-ink-2 hover:bg-surface-2"}`}>
                    Whole age group
                  </Link>
                  {view.groups.map((g) => (
                    <Link key={g.id} href={href(view.band!, g.id)} aria-current={view.groupId === g.id ? "true" : undefined} className={`inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-semibold ${view.groupId === g.id ? "border-brand bg-brand text-brand-ink" : "border-edge bg-surface text-ink-2 hover:bg-surface-2"}`}>
                      {g.name}
                    </Link>
                  ))}
                </nav>
              ) : null}
            </div>
            {view.boards.length === 0 ? (
              <EmptyState title="No boards yet">{view.band ? "Boards fill in as sessions are attended and maxes are tested. The first name up sets the mark." : "Boards appear once an athlete with a birthday on file is linked to your account."}</EmptyState>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {view.boards.map((b) => (
                  <LeaderboardCard key={b.key} board={b} isAthlete={isAthlete} />
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="space-y-4">
          {names.length ? (
            <Card id="display-names">
              <CardHeader title="How names appear" kicker="Your choice" />
              <CardBody className="space-y-5 divide-y divide-edge *:pt-5 *:first:pt-0">
                {names.map((a) => (
                  <div key={a.athleteId}>
                    {names.length > 1 || !isAthlete ? <h3 className="mb-1 text-sm font-bold">{a.firstName}</h3> : null}
                    <DisplayModeForm access={a} isSelf={isAthlete} />
                  </div>
                ))}
                <p className="text-xs text-ink-3">Boards never show last names, ages, body weight, health or billing details. Hidden athletes still see their own rank here.</p>
              </CardBody>
            </Card>
          ) : null}

          {manage ? (
            <Card id="manage-challenges">
              <CardHeader title="Challenges" kicker="Staff" />
              <CardBody className="space-y-4">
                <details open={manage.challenges.filter((c) => c.status === "active").length === 0}>
                  <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-brand underline">Start a challenge</summary>
                  {manage.groups.length === 0 && !manage.canGymWide ? (
                    <p className="text-sm text-ink-3">You can start a challenge for a group you coach. No group is assigned to you yet.</p>
                  ) : (
                    <ActionForm action={createChallengeAction} resetOnSuccess className="mt-2 space-y-3">
                      <Field label="Name" htmlFor="ch-title" hint='For example "November: 12 sessions each".' required>
                        <Input id="ch-title" name="title" maxLength={80} required />
                      </Field>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Type" htmlFor="ch-mode">
                          <Select id="ch-mode" name="mode" defaultValue="individual">
                            {(["individual", "group_total"] as const).map((m) => (
                              <option key={m} value={m}>
                                {CHALLENGE_MODE_LABEL[m]}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Counts" htmlFor="ch-metric">
                          <Select id="ch-metric" name="metric" defaultValue="attendance">
                            {(["attendance", "workouts", "streak_weeks"] as const).map((m) => (
                              <option key={m} value={m}>
                                {CHALLENGE_METRIC_LABEL[m]}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      </div>
                      <Field label="Target" htmlFor="ch-target" hint="Per athlete, or the combined total for a team challenge." required>
                        <Input id="ch-target" name="target" type="number" min={1} max={100000} step={1} required />
                      </Field>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Starts" htmlFor="ch-start" required>
                          <Input id="ch-start" name="startsOn" type="date" defaultValue={today} required />
                        </Field>
                        <Field label="Ends" htmlFor="ch-end" required>
                          <Input id="ch-end" name="endsOn" type="date" defaultValue={addDaysYmd(today, 27)} required />
                        </Field>
                      </div>
                      <Field label="Who" htmlFor="ch-group">
                        <Select id="ch-group" name="groupId" defaultValue={manage.canGymWide ? "" : manage.groups[0]?.id}>
                          {manage.canGymWide ? <option value="">Everyone at the gym</option> : null}
                          {manage.groups.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <SubmitButton>Start challenge</SubmitButton>
                      <p className="text-xs text-ink-3">Progress is counted from check-ins and logged workouts. Finishing earns a badge. No prizes or money.</p>
                    </ActionForm>
                  )}
                </details>
                {manage.challenges.length ? (
                  <ul className="divide-y divide-edge">
                    {manage.challenges.slice(0, 8).map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <span className="min-w-0">
                          <span className="block font-semibold">{c.title}</span>
                          <span className="block text-xs text-ink-3">
                            {fmtDate(c.startsOn)} to {fmtDate(c.endsOn)} · {c.groupName ?? "Everyone"}
                          </span>
                        </span>
                        {c.status === "archived" ? (
                          <Badge>Archived</Badge>
                        ) : c.canArchive ? (
                          <ActionForm action={archiveChallengeAction}>
                            <input type="hidden" name="challengeId" value={c.id} />
                            <SubmitButton variant="secondary" size="sm" pendingText="Archiving…" confirm="Archive this challenge? It comes off Athlete Home, the leaderboards and the gym TV. Badges already earned stay.">
                              Archive<span className="sr-only">: {c.title}</span>
                            </SubmitButton>
                          </ActionForm>
                        ) : (
                          <Badge variant={c.endsOn < today ? "neutral" : "green"}>{c.endsOn < today ? "Ended" : "Running"}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {staff ? (
            <Card>
              <CardBody className="space-y-2 text-sm">
                <p className="text-ink-2">Shoutouts are posted from an athlete&apos;s profile. Families choose how each athlete is named, or hide them, from this page.</p>
                {can(v, "settings.manage") ? (
                  <p className="flex flex-wrap gap-x-4 gap-y-1">
                    <Link href="/settings/community" className="font-semibold text-brand underline">
                      Community settings
                    </Link>
                    <Link href="/display" className="font-semibold text-brand underline">
                      Preview the gym TV board
                    </Link>
                  </p>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
