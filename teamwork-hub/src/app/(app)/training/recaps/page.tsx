import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, EmptyState, Textarea } from "@/components/ui";
import { getOrg, requireCap } from "@/lib/auth/viewer";
import { prettyDate } from "@/lib/showcase/compose";
import { MAX_COACH_NOTE, coachRecapQueue, isMonth, monthLabel, monthOf, shiftMonth } from "@/lib/showcase/recap";
import { showcaseSettingsOf } from "@/lib/showcase/settings";
import { fmt, todayLocal } from "@/lib/time";
import { HeroStat, ModuleHero } from "../_components/tb";
import { TrainingNav } from "../_components/training-nav";
import { finalizeRecapAction, saveCoachNoteAction } from "./actions";

export const metadata = { title: "Monthly recaps" };

export default async function CoachRecapQueuePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const v = await requireCap("training.manage");
  const sp = await searchParams;
  const org = await getOrg(v.orgId);
  const tz = org?.timezone;
  const current = monthOf(todayLocal(tz));
  const month = isMonth(sp.month) && sp.month <= current ? sp.month : current;
  const queue = await coachRecapQueue(db, v, month);
  const open = queue.rows.filter((r) => r.state === "open");
  const withNote = queue.rows.filter((r) => r.note).length;
  const trained = queue.rows.filter((r) => r.attended + r.workouts > 0).length;
  const months = [current, shiftMonth(current, -1), shiftMonth(current, -2)];

  return (
    <>
      <ModuleHero
        kicker="Training"
        title={`Monthly recaps: ${queue.label}`}
        description={`Each family gets a one-page recap of the month. Add a short note for your athletes, or leave it blank. Notes lock when the month is finalized on ${prettyDate(queue.finalOn)}.`}
      >
        <div className="grid grid-cols-3 gap-2.5 sm:max-w-xl">
          <HeroStat label="Athletes" value={queue.rows.length} hint={v.role === "coach" ? "assigned to you" : "active"} />
          <HeroStat label="Trained this month" value={trained} />
          <HeroStat label="Notes written" value={withNote} hint={`of ${trained || queue.rows.length}`} />
        </div>
      </ModuleHero>
      <TrainingNav viewer={v} current="recaps" />

      <nav aria-label="Choose month" className="mb-4 flex flex-wrap gap-2">
        {months.map((m) => (
          <Link
            key={m}
            href={`/training/recaps?month=${m}`}
            aria-current={m === month ? "true" : undefined}
            className={`inline-flex min-h-10 items-center rounded-full border px-4 text-sm font-semibold ${m === month ? "border-brand bg-brand text-brand-ink" : "border-edge bg-surface text-ink hover:bg-surface-2"}`}
          >
            {monthLabel(m)}
          </Link>
        ))}
      </nav>

      {!showcaseSettingsOf(org?.settings).recapEnabled ? (
        <Callout tone="warn" title="Monthly recaps are turned off" className="mb-4">
          Families do not see recaps while this is off. An owner or admin can turn it on in Settings.
        </Callout>
      ) : null}

      {queue.rows.length === 0 ? (
        <EmptyState title="No athletes in your coaching scope">Recaps appear for athletes assigned to you.</EmptyState>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {queue.rows.map((r) => {
            const id = `note-${r.athleteId}`;
            return (
              <li key={r.athleteId} className="rounded-md border border-edge bg-surface p-4 shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-[15px] font-semibold">{r.name}</h2>
                    <p className="text-xs text-ink-3">
                      {r.attended} session{r.attended === 1 ? "" : "s"} attended · {r.workouts} workout{r.workouts === 1 ? "" : "s"} logged
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {r.state === "final" ? <Badge variant="green">Final</Badge> : r.note ? <Badge variant="blue">Note saved</Badge> : <Badge variant="neutral">No note</Badge>}
                    <Link href={`/recap/${month}?athlete=${r.athleteId}`} className="text-sm font-semibold text-brand underline">
                      Preview<span className="sr-only"> recap for {r.name}</span>
                    </Link>
                  </div>
                </div>
                {r.state === "final" ? (
                  <p className="mt-3 text-sm whitespace-pre-line text-ink-2">{r.note ?? "Finalized without a coach note."}</p>
                ) : (
                  <>
                    <ActionForm action={saveCoachNoteAction} className="mt-3">
                      <input type="hidden" name="athleteId" value={r.athleteId} />
                      <input type="hidden" name="month" value={month} />
                      <label htmlFor={id} className="sr-only">
                        Coach note for {r.name}, {queue.label}
                      </label>
                      <Textarea id={id} name="note" rows={3} maxLength={MAX_COACH_NOTE} defaultValue={r.note ?? ""} placeholder="What went well this month, and one thing to work on next. Keep health details out of it." />
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-ink-3">{r.noteAt ? `Saved ${fmt(r.noteAt, "MMM d, h:mm a", tz)}` : "Optional. Families with training access see it."}</span>
                        <SubmitButton variant="secondary" size="sm">
                          Save note<span className="sr-only"> for {r.name}</span>
                        </SubmitButton>
                      </div>
                    </ActionForm>
                    {queue.ended ? (
                      <ActionForm action={finalizeRecapAction} className="mt-2 border-t border-edge pt-2">
                        <input type="hidden" name="athleteId" value={r.athleteId} />
                        <input type="hidden" name="month" value={month} />
                        <SubmitButton variant="ghost" size="sm" pendingText="Finalizing…" confirm={`Finalize ${queue.label} for ${r.name}? The numbers and note are frozen and the family is told it is ready.`}>
                          Finalize now<span className="sr-only"> for {r.name}</span>
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open.length ? <p className="mt-4 text-xs text-ink-3">Recaps never include wellness or health information. No email or text is sent: families see the recap in the Hub.</p> : null}
    </>
  );
}
