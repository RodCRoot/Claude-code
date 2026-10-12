"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { buttonClass } from "@/components/ui";
import type { WorkoutDetail } from "@/lib/training/logging";
import { purgeTrainingOffline } from "@/components/training-offline";
import { clearQueue, flush, pendingCount, setQueueVia } from "./set-queue";
import { ItemCard, SyncBanner, useRefreshOnSync } from "./workout-logger";

type RosterAthlete = { athleteId: string; name: string; canLog: boolean; workout: { id: string; title: string; status: string; progress: { done: number; total: number } } | null };

/**
 * Shared-tablet logging. Only names + workout data are shown. Nothing but pending
 * set mutations (ids + numbers) touches localStorage; "Exit" wipes client state.
 */
export function WeightRoom({ athletes, groupName, date }: { athletes: RosterAthlete[]; groupName: string; date: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<RosterAthlete | null>(null);
  const [workout, setWorkout] = useState<WorkoutDetail | null>(null);
  const [canLog, setCanLog] = useState(false);
  const [itemIdx, setItemIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Shared tablet: never keep workout data in service-worker caches (none is written here;
    // this also clears anything an athlete may have left on the device).
    void purgeTrainingOffline();
    setQueueVia("weight_room");
    return () => setQueueVia("athlete_app");
  }, []);

  const load = useCallback(async (workoutId: string, keepItem = false) => {
    setError(null);
    try {
      const res = await fetch(`/api/training/workouts/${workoutId}`, { cache: "no-store" });
      const body = (await res.json()) as { workout?: WorkoutDetail; canLog?: boolean; error?: string };
      if (!res.ok || !body.workout) throw new Error(body.error ?? `Error ${res.status}`);
      setWorkout(body.workout);
      setCanLog(!!body.canLog);
      if (!keepItem) {
        const first = body.workout.items.findIndex((it) => it.logs.filter((l) => l.completed).length < it.sets.length * (it.performed.isUnilateral ? 2 : 1));
        setItemIdx(first >= 0 ? first : 0);
      }
    } catch (e) {
      setError(e instanceof TypeError ? "Can't reach the server. Logged sets are kept and will sync." : (e as Error).message);
    }
  }, []);

  useRefreshOnSync(
    useCallback(() => {
      router.refresh();
      if (selected?.workout) void load(selected.workout.id, true);
    }, [router, selected, load]),
  );

  async function exit() {
    if (pendingCount()) await flush();
    const left = pendingCount();
    if (left && !window.confirm(`${left} entries have not synced yet. Exit anyway and discard them from this tablet?`)) return;
    clearQueue();
    await purgeTrainingOffline();
    setSelected(null);
    setWorkout(null);
    router.push("/training");
  }

  const item = workout?.items[itemIdx];
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SyncBanner className="flex-1" />
        <button type="button" onClick={exit} className={buttonClass("danger", "lg")}>
          Exit weight room
        </button>
      </div>

      {!selected ? (
        <section aria-label={`${groupName} athletes`}>
          {athletes.length === 0 ? <p className="text-sm text-ink-3">No athletes in your scope for this group.</p> : null}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {athletes.map((a) => {
              const p = a.workout?.progress;
              const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
              return (
                <li key={a.athleteId}>
                  <button
                    type="button"
                    disabled={!a.workout}
                    onClick={() => {
                      setSelected(a);
                      setWorkout(null);
                      if (a.workout) void load(a.workout.id);
                    }}
                    className="flex min-h-28 w-full flex-col justify-between rounded-xl border border-edge bg-surface p-3 text-left hover:border-brand disabled:opacity-60"
                    aria-label={`${a.name}: ${a.workout ? `${p?.done ?? 0} of ${p?.total ?? 0} sets` : "no workout"}`}
                  >
                    <span className="text-lg font-semibold leading-tight">{a.name}</span>
                    <span className="text-xs text-ink-3">{a.workout ? a.workout.title : "No workout on this date"}</span>
                    {a.workout ? (
                      <span className="mt-2 block">
                        <span className="block h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                          <span className={cn("block h-full rounded-full", a.workout.status === "completed" ? "bg-ok" : "bg-brand")} style={{ width: `${pct}%` }} />
                        </span>
                        <span className="mt-1 block text-xs tabular text-ink-2">
                          {p?.done}/{p?.total} sets{a.workout.status === "completed" ? " · done" : ""}
                        </span>
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <section aria-label={`Logging for ${selected.name}`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => (setSelected(null), setWorkout(null))} className={buttonClass("secondary", "lg")}>
              ← All athletes
            </button>
            <h2 className="text-xl font-bold">{selected.name}</h2>
          </div>
          {error ? <p role="alert" className="mb-3 text-sm text-bad">{error}</p> : null}
          {!workout ? (
            <p className="text-sm text-ink-3">Loading workout…</p>
          ) : !canLog ? (
            <p className="text-sm text-ink-3">View only — your role can&apos;t log sets for this athlete.</p>
          ) : null}
          {workout && item ? (
            <>
              <nav aria-label="Exercises" className="mb-3 flex gap-2 overflow-x-auto pb-1">
                {workout.items.map((it, i) => {
                  const done = it.logs.filter((l) => l.completed).length >= it.sets.length * (it.performed.isUnilateral ? 2 : 1);
                  return (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => setItemIdx(i)}
                      aria-current={i === itemIdx ? "step" : undefined}
                      className={cn("min-h-11 shrink-0 rounded-lg border px-3 text-sm font-medium", i === itemIdx ? "border-brand bg-brand text-brand-ink" : done ? "border-ok/40 text-ok" : "border-edge")}
                    >
                      {it.blockLabel} {it.performed.name}
                      {done ? " ✓" : ""}
                    </button>
                  );
                })}
              </nav>
              <ItemCard key={item.id} item={item} canLog={canLog && workout.status !== "skipped"} big workoutId={workout.id} showLinks={false} />
              <div className="mt-3 flex justify-between gap-2">
                <button type="button" disabled={itemIdx === 0} onClick={() => setItemIdx((i) => i - 1)} className={buttonClass("secondary", "lg")}>
                  ← Previous
                </button>
                <button type="button" disabled={itemIdx >= workout.items.length - 1} onClick={() => setItemIdx((i) => i + 1)} className={buttonClass("primary", "lg")}>
                  Next exercise →
                </button>
              </div>
            </>
          ) : null}
        </section>
      )}
      <p className="mt-6 text-xs text-ink-3">Date: {date}. Session RPE and completion are entered by the athlete on their own device or by a coach on the workout page.</p>
    </div>
  );
}
