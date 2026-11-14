import Link from "next/link";
import { db } from "@/db";
import { ButtonLink, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { ANYWHERE_CATEGORIES, ANYWHERE_EQUIPMENT, type AnywhereCategory, type AnywhereEquipment } from "@/db/schema";
import { assignmentsForAthlete } from "@/lib/anywhere/assignments";
import { anywhereAccess, CATEGORY_LABEL, EQUIPMENT_LABEL, SAFETY_COPY } from "@/lib/anywhere/common";
import { completionsForAthlete, libraryForAthlete } from "@/lib/anywhere/sessions";
import { fmtDate } from "@/lib/time";
import { ModuleHero, ProgressBar } from "../training/_components/tb";
import { AnywherePending } from "./_components/session-player";
import { AnywhereTabs, AthletePills, familyContext, SessionMeta } from "./_shared";

export const metadata = { title: "On Your Own" };

const TIMES = [10, 15, 20];

function Chip({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} aria-current={on ? "true" : undefined} className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold ${on ? "border-brand bg-brand text-brand-ink" : "border-edge bg-surface text-ink hover:bg-surface-2"}`}>
      {children}
    </Link>
  );
}

export default async function AnywherePage({ searchParams }: { searchParams: Promise<{ athlete?: string; time?: string; eq?: string; cat?: string }> }) {
  const sp = await searchParams;
  const { v, children, child, isAthlete } = await familyContext(sp.athlete);
  const first = child?.name.split(" ")[0];
  const hero = (
    <ModuleHero kicker="On Your Own" title={isAthlete || !first ? "Train anywhere" : `On Your Own for ${first}`} description="Short sessions from your coaches for the days you are not in the gym. At home, at a field, or in a hotel room.">
      <AthletePills base="/anywhere" items={children} current={child?.athleteId} />
    </ModuleHero>
  );
  if (!child) {
    return (
      <div className="mx-auto max-w-5xl">
        {hero}
        <EmptyState title="No athletes linked to your account yet">Ask the front desk to link your athlete to your account.</EmptyState>
      </div>
    );
  }
  const access = await anywhereAccess(db, v, child.athleteId);
  const multi = children.length > 1;
  if (!access?.canSeeTraining) {
    return (
      <div className="mx-auto max-w-5xl">
        {hero}
        <AnywhereTabs current="sessions" athleteId={child.athleteId} multi={multi} />
        <EmptyState title="Training is not shared with this account">Your account does not include training access for {first}. You can still keep the season calendar under My Season.</EmptyState>
      </div>
    );
  }

  // A parent who may log for an athlete under 13 gets the same "Start" buttons the athlete does.
  const canStart = isAthlete || access.canFinishSession;
  const time = TIMES.includes(Number(sp.time)) ? Number(sp.time) : null;
  const eq = (ANYWHERE_EQUIPMENT as readonly string[]).includes(sp.eq ?? "") ? (sp.eq as AnywhereEquipment) : null;
  const cat = (ANYWHERE_CATEGORIES as readonly string[]).includes(sp.cat ?? "") ? (sp.cat as AnywhereCategory) : null;
  const [sessions, assignments, recent] = await Promise.all([
    libraryForAthlete(db, v, child.athleteId, { maxMinutes: time, equipment: eq, category: cat }),
    assignmentsForAthlete(db, v, child.athleteId),
    completionsForAthlete(db, v, child.athleteId, 5),
  ]);
  const href = (next: { time?: number | null; eq?: string | null; cat?: string | null }) => {
    const q = new URLSearchParams();
    if (multi) q.set("athlete", child.athleteId);
    const t = next.time === undefined ? time : next.time;
    const e = next.eq === undefined ? eq : next.eq;
    const c = next.cat === undefined ? cat : next.cat;
    if (t) q.set("time", String(t));
    if (e) q.set("eq", e);
    if (c) q.set("cat", c);
    const s = q.toString();
    return s ? `/anywhere?${s}` : "/anywhere";
  };
  const sessionHref = (id: string) => `/anywhere/sessions/${id}${multi ? `?athlete=${child.athleteId}` : ""}`;

  return (
    <div className="mx-auto max-w-5xl">
      {hero}
      <AnywhereTabs current="sessions" athleteId={child.athleteId} multi={multi} />
      {access.canFinishSession ? <AnywherePending /> : null}

      {assignments.length ? (
        <Card className="mb-4 border-l-4 border-l-brand">
          <CardHeader title="From your coach" kicker={`${assignments.filter((a) => a.complete).length} of ${assignments.length} done`} />
          <CardBody>
            <ul className="divide-y divide-edge">
              {assignments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1 basis-52">
                    <p className="font-bold leading-snug">{a.title}</p>
                    <p className="text-sm text-ink-2">
                      <span className="sr-only">{a.complete ? "Done: " : "To do: "}</span>
                      {a.done} of {a.target} done · by {fmtDate(a.endDate)}
                    </p>
                    {a.note ? <p className="text-sm text-ink-3">{a.note}</p> : null}
                    <ProgressBar done={a.done} total={a.target} complete={a.complete} className="mt-1.5 max-w-xs" />
                  </div>
                  {a.complete ? (
                    <span className="text-sm font-bold text-ok">Done</span>
                  ) : (
                    <ButtonLink href={a.sessionId ? sessionHref(a.sessionId) : href({ cat: a.category, time: null, eq: null })} variant={canStart ? "primary" : "secondary"} className="h-11! w-full sm:w-auto">
                      {a.sessionId ? (canStart ? "Start" : "View") : "Pick a session"}
                    </ButtonLink>
                  )}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <section aria-labelledby="filters-h" className="mb-4 rounded-md border border-edge bg-surface px-4 py-3">
        <h2 id="filters-h" className="sr-only">
          Filter sessions
        </h2>
        <div className="space-y-3">
          <div>
            <p className="kicker mb-1.5" id="f-time">
              Time I have
            </p>
            <nav aria-labelledby="f-time" className="flex flex-wrap gap-2">
              <Chip href={href({ time: null })} on={!time}>
                Any
              </Chip>
              {TIMES.map((t) => (
                <Chip key={t} href={href({ time: t })} on={time === t}>
                  {t} min
                </Chip>
              ))}
            </nav>
          </div>
          <div>
            <p className="kicker mb-1.5" id="f-eq">
              What I have with me
            </p>
            <nav aria-labelledby="f-eq" className="flex flex-wrap gap-2">
              <Chip href={href({ eq: null })} on={!eq}>
                Anything
              </Chip>
              {ANYWHERE_EQUIPMENT.map((e) => (
                <Chip key={e} href={href({ eq: e })} on={eq === e}>
                  {e === "none" ? "Nothing" : EQUIPMENT_LABEL[e]}
                </Chip>
              ))}
            </nav>
          </div>
          {cat ? (
            <p className="text-sm text-ink-2">
              Showing {CATEGORY_LABEL[cat].toLowerCase()} only.{" "}
              <Link href={href({ cat: null })} className="inline-flex min-h-11 items-center font-semibold text-brand underline">
                Show every type
              </Link>
            </p>
          ) : null}
        </div>
      </section>

      {sessions.length === 0 ? (
        <EmptyState title="No sessions match">{time || eq || cat ? "Try a longer time or different equipment." : "Your coaches have not published any On Your Own sessions yet."}</EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {sessions.map((s) => (
            <li key={s.id} className="flex min-w-0 flex-col rounded-md border border-edge bg-surface p-4 shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
              <h3 className="text-lg leading-tight font-extrabold">{s.title}</h3>
              <div className="mt-1.5">
                <SessionMeta s={s} />
              </div>
              {s.description ? <p className="mt-2 text-sm text-ink-2">{s.description}</p> : null}
              <p className="mt-2 text-xs text-ink-3">
                {s.stepCount} step{s.stepCount === 1 ? "" : "s"}. {SAFETY_COPY}
              </p>
              <ButtonLink href={sessionHref(s.id)} variant={canStart ? "primary" : "secondary"} size="lg" className="mt-3 w-full">
                {canStart ? "Start" : "View"}
                <span className="sr-only">: {s.title}</span>
              </ButtonLink>
            </li>
          ))}
        </ul>
      )}

      {recent.length ? (
        <Card className="mt-4">
          <CardHeader title="Done recently" />
          <CardBody>
            <ul className="divide-y divide-edge text-sm">
              {recent.map((c) => (
                <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 first:pt-0 last:pb-0">
                  <span className="font-semibold">{c.sessionTitle}</span>
                  <span className="text-ink-2 tabular">
                    {fmtDate(c.localDate)} · {c.stepsDone} of {c.stepsTotal} steps
                    {c.durationMinutes != null ? ` · ${c.durationMinutes} min` : ""}
                    {c.rpe != null ? ` · effort ${c.rpe}` : ""}
                    {c.loggedAs === "guardian" ? " · logged by a parent" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
