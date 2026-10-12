"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { buttonClass } from "@/components/ui";
import type { WorkoutDetail } from "@/lib/training/logging";
import { describePrescription, type ExpandedSet } from "@/lib/training/formulas";
import { enqueue, flush, retryNow, useSetQueue, type QueuedSet } from "./set-queue";

type FullItem = WorkoutDetail["items"][number];
/** What the logger needs from an item (the offline copy carries only this). */
export type LoggerItem = Pick<FullItem, "id" | "blockLabel" | "notes" | "athleteModification" | "performed" | "substituted" | "groups" | "sets" | "logs"> & {
  exercise: Pick<FullItem["exercise"], "name" | "videoUrl" | "coachingNotes">;
};
type Item = LoggerItem;
type Side = "both" | "left" | "right";
const slotKey = (itemId: string, setIndex: number, side: Side) => `${itemId}:${setIndex}:${side}`;
const toNum = (s: string) => (s.trim() === "" ? null : Number.isFinite(Number(s)) ? Number(s) : null);

/** "N unsynced entries" status + retry. Shown wherever sets can be logged. */
export function SyncBanner({ className }: { className?: string }) {
  const q = useSetQueue();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!q.nextRetryAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [q.nextRetryAt]);
  const n = q.items.length;
  if (!n && !q.rejected.length) {
    return (
      <p role="status" aria-live="polite" className={cn("text-xs text-ink-3", className)} data-testid="sync-status">
        All entries synced{q.lastSyncedAt ? "" : " (nothing pending)"}.
      </p>
    );
  }
  const secs = q.nextRetryAt ? Math.max(0, Math.ceil((q.nextRetryAt - now) / 1000)) : null;
  return (
    <div role="status" aria-live="polite" className={cn("rounded-lg border px-3 py-2 text-sm", n ? "border-warn/40 bg-warn/5" : "border-bad/30 bg-bad/5", className)} data-testid="sync-status">
      {n ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            <strong data-testid="unsynced-count">{n}</strong> unsynced {n === 1 ? "entry" : "entries"} saved on this device
            {q.syncing ? " · syncing…" : secs != null && secs > 0 ? ` · retrying in ${secs}s` : ""}
            {q.lastError ? <span className="block text-xs text-ink-3">{q.lastError}</span> : null}
          </span>
          <button type="button" onClick={() => void retryNow()} className={buttonClass("secondary", "sm", "min-h-11")}>
            Retry now
          </button>
        </div>
      ) : null}
      {q.rejected.length ? (
        <ul className="mt-1 text-xs text-bad">
          {q.rejected.map((r, i) => (
            <li key={i}>
              Set {r.setIndex + 1} was not saved: {r.error}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function prescribedLabel(s: ExpandedSet, item: Item) {
  const g = item.groups[s.groupIndex];
  const reps = s.repsText ?? (s.reps != null ? `${s.reps} reps` : s.durationS != null ? `${s.durationS}s` : s.distanceM != null ? `${s.distanceM} m` : "");
  let load = "";
  if (s.targetLoad != null) load = `${s.targetLoad} ${s.targetUnit}`;
  else if (g?.loadType === "rpe") load = `RPE ${g.rpe}`;
  else if (g?.loadType === "rir") load = `${g.rir} RIR`;
  else if (g?.loadType === "bodyweight") load = "BW";
  else if (g?.loadType === "percent_max") load = `${g.percent}% (no max)`;
  return [reps, load].filter(Boolean).join(" · ");
}

function SetRow({
  item,
  s,
  side,
  logged: serverLogged,
  pending,
  confirmed,
  canLog,
  big,
}: {
  item: Item;
  s: ExpandedSet;
  side: Side;
  logged: Item["logs"][number] | undefined;
  pending: QueuedSet | undefined;
  confirmed: QueuedSet | undefined;
  canLog: boolean;
  big: boolean;
}) {
  // A server-confirmed entry from this session wins over older page data (until the refresh lands).
  const logged = confirmed && (!serverLogged || confirmed.loggedAt >= Date.parse(serverLogged.loggedAt)) ? confirmed : serverLogged;
  const src = pending ?? logged;
  const tracking = item.performed.trackingType;
  const showLoad = tracking === "weight_reps";
  const showReps = tracking !== "time" && tracking !== "distance" && tracking !== "time_distance";
  const showTime = tracking === "time" || tracking === "time_distance";
  const showDist = tracking === "distance" || tracking === "time_distance";
  const unit: "lb" | "kg" = (src?.loadUnit as "lb" | "kg" | null) ?? s.targetUnit ?? (item.performed.defaultUnit === "kg" ? "kg" : "lb");
  const [reps, setReps] = useState(String(src?.reps ?? s.reps ?? ""));
  const [load, setLoad] = useState(String(src?.load ?? s.targetLoad ?? ""));
  const [rpe, setRpe] = useState(src?.rpe != null ? String(src.rpe) : "");
  const [dur, setDur] = useState(String(src?.durationS ?? s.durationS ?? ""));
  const [dist, setDist] = useState(String(src?.distanceM ?? s.distanceM ?? ""));
  const id = `${item.id}-${s.setIndex}-${side}`;
  const status = pending ? "pending" : logged?.completed ? "logged" : "open";
  const label = `Set ${s.setIndex + 1}${side !== "both" ? ` ${side === "left" ? "L" : "R"}` : ""}`;
  const input = cn("w-full rounded-lg border border-edge bg-surface px-2 text-center tabular", big ? "h-12 text-lg" : "h-11 text-base");

  function log() {
    enqueue({
      workoutItemId: item.id,
      setIndex: s.setIndex,
      side,
      reps: showReps ? toNum(reps) : null,
      load: showLoad ? toNum(load) : null,
      loadUnit: showLoad && toNum(load) != null ? unit : null,
      rpe: toNum(rpe),
      durationS: showTime ? toNum(dur) : null,
      distanceM: showDist ? toNum(dist) : null,
      completed: true,
    });
  }

  return (
    <li className={cn("rounded-lg border px-3 py-2", status === "logged" ? "border-ok/40 bg-ok/5" : status === "pending" ? "border-warn/40 bg-warn/5" : "border-edge")} data-testid={`set-${s.setIndex}-${side}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">
          {label}
          {s.isWarmup ? <span className="ml-1 text-xs font-normal text-ink-3">warm-up</span> : null}
        </span>
        <span className="text-xs text-ink-3">
          Target: {prescribedLabel(s, item)}
          {status === "logged" ? <span className="ml-2 font-semibold text-ok">✓ saved</span> : status === "pending" ? <span className="ml-2 font-semibold text-warn">● unsynced</span> : null}
        </span>
      </div>
      {canLog ? (
        <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] items-end gap-2">
          {showReps ? (
            <label className="text-xs text-ink-3" htmlFor={`${id}-reps`}>
              Reps
              <input id={`${id}-reps`} inputMode="numeric" type="number" min={0} max={500} value={reps} onChange={(e) => setReps(e.target.value)} className={input} />
            </label>
          ) : null}
          {showLoad ? (
            <label className="text-xs text-ink-3" htmlFor={`${id}-load`}>
              Load ({unit})
              <input id={`${id}-load`} inputMode="decimal" type="number" step="0.5" min={0} max={5000} value={load} onChange={(e) => setLoad(e.target.value)} className={input} />
            </label>
          ) : null}
          {showTime ? (
            <label className="text-xs text-ink-3" htmlFor={`${id}-dur`}>
              Time (s)
              <input id={`${id}-dur`} inputMode="decimal" type="number" step="0.01" min={0} value={dur} onChange={(e) => setDur(e.target.value)} className={input} />
            </label>
          ) : null}
          {showDist ? (
            <label className="text-xs text-ink-3" htmlFor={`${id}-dist`}>
              Distance (m)
              <input id={`${id}-dist`} inputMode="decimal" type="number" step="0.1" min={0} value={dist} onChange={(e) => setDist(e.target.value)} className={input} />
            </label>
          ) : null}
          <label className="text-xs text-ink-3" htmlFor={`${id}-rpe`}>
            RPE
            <input id={`${id}-rpe`} inputMode="decimal" type="number" step="0.5" min={0} max={10} placeholder="–" value={rpe} onChange={(e) => setRpe(e.target.value)} className={input} />
          </label>
          <button type="button" onClick={log} className={buttonClass(status === "open" ? "primary" : "secondary", big ? "lg" : "md", "min-h-11 w-full")} aria-label={`${status === "open" ? "Log" : "Update"} ${item.performed.name} ${label}`}>
            {status === "open" ? "Log" : "Update"}
          </button>
        </div>
      ) : logged ? (
        <p className="mt-1 text-sm tabular">
          Actual: {logged.reps ?? "—"} reps{logged.load != null ? ` @ ${logged.load} ${logged.loadUnit}` : ""}
          {logged.durationS != null ? ` · ${logged.durationS}s` : ""}
          {logged.distanceM != null ? ` · ${logged.distanceM} m` : ""}
          {logged.rpe != null ? ` · RPE ${logged.rpe}` : ""}
        </p>
      ) : (
        <p className="mt-1 text-xs text-ink-3">Not logged</p>
      )}
    </li>
  );
}

export function ItemCard({ item, canLog, big = false, workoutId, showLinks = true }: { item: Item; canLog: boolean; big?: boolean; workoutId: string; showLinks?: boolean }) {
  const q = useSetQueue();
  const sides: Side[] = item.performed.isUnilateral ? ["left", "right"] : ["both"];
  const pendingMap = useMemo(() => new Map(q.items.filter((p) => p.workoutItemId === item.id).map((p) => [slotKey(p.workoutItemId, p.setIndex, p.side), p])), [q.items, item.id]);
  const confirmedMap = useMemo(() => new Map(q.confirmed.filter((p) => p.workoutItemId === item.id).map((p) => [slotKey(p.workoutItemId, p.setIndex, p.side), p])), [q.confirmed, item.id]);
  const loggedMap = useMemo(() => new Map(item.logs.map((l) => [slotKey(item.id, l.setIndex, l.side as Side), l])), [item.logs, item.id]);
  const open = item.sets.flatMap((s) =>
    sides
      .filter((side) => {
        const k = slotKey(item.id, s.setIndex, side);
        return !pendingMap.has(k) && !loggedMap.has(k) && !confirmedMap.has(k);
      })
      .map((side) => ({ s, side })),
  );

  function doneAsPrescribed() {
    for (const { s, side } of open) {
      enqueue({
        workoutItemId: item.id,
        setIndex: s.setIndex,
        side,
        reps: s.reps,
        load: item.performed.trackingType === "weight_reps" ? s.targetLoad : null,
        loadUnit: item.performed.trackingType === "weight_reps" && s.targetLoad != null ? s.targetUnit : null,
        rpe: null,
        durationS: s.durationS,
        distanceM: s.distanceM,
        completed: true,
      });
    }
  }
  const warnings = item.groups.filter((g) => g.loadWarning).map((g) => g.loadWarning!);
  return (
    <section className="rounded-xl border border-edge bg-surface p-3 sm:p-4" aria-labelledby={`item-${item.id}`} data-testid={`item-${item.blockLabel}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`item-${item.id}`} className="text-base font-semibold">
            <span className="mr-2 rounded bg-brand/10 px-1.5 py-0.5 text-xs font-bold text-brand">{item.blockLabel}</span>
            {item.performed.name}
            {item.performed.isUnilateral ? <span className="ml-1 text-xs font-normal text-ink-3">(each side)</span> : null}
          </h3>
          {item.substituted ? <p className="text-xs text-warn">Substituted for {item.exercise.name}</p> : null}
          <ul className="mt-1 space-y-0.5 text-xs text-ink-3">
            {item.groups.map((g, i) => (
              <li key={i}>
                {describePrescription(g)}
                {g.loadMethod && g.targetLoad != null ? <span className="block pl-2">↳ {g.loadMethod}</span> : null}
              </li>
            ))}
          </ul>
          {warnings.map((w) => (
            <p key={w} className="mt-1 text-xs font-medium text-warn">
              {w} Ask your coach to record a max.
            </p>
          ))}
          {item.notes ? <p className="mt-1 text-sm">{item.notes}</p> : null}
          {item.athleteModification ? <p className="mt-1 text-xs text-ink-2">Modification: {item.athleteModification}</p> : null}
          {item.exercise.coachingNotes ? <p className="mt-1 text-xs text-ink-2">Cue: {item.exercise.coachingNotes}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {canLog && open.length ? (
            <button type="button" onClick={doneAsPrescribed} className={buttonClass("outline", big ? "lg" : "md", "min-h-11")}>
              Done as prescribed ({open.length})
            </button>
          ) : null}
          {showLinks && item.exercise.videoUrl ? (
            <a href={item.exercise.videoUrl} target="_blank" rel="noopener noreferrer" className={buttonClass("ghost", "md", "min-h-11")}>
              Video ↗
            </a>
          ) : null}
          {showLinks && canLog ? (
            <Link href={`/training/workouts/${workoutId}#mod-${item.id}`} className={buttonClass("ghost", "md", "min-h-11")}>
              Swap / modify
            </Link>
          ) : null}
        </div>
      </header>
      <ol className="mt-3 space-y-2">
        {item.sets.flatMap((s) =>
          sides.map((side) => (
            <SetRow
              key={slotKey(item.id, s.setIndex, side)}
              item={item}
              s={s}
              side={side}
              logged={loggedMap.get(slotKey(item.id, s.setIndex, side))}
              pending={pendingMap.get(slotKey(item.id, s.setIndex, side))}
              confirmed={confirmedMap.get(slotKey(item.id, s.setIndex, side))}
              canLog={canLog}
              big={big}
            />
          )),
        )}
      </ol>
    </section>
  );
}

const RPE_HINT = ["Rest", "Very, very easy", "Easy", "Moderate", "Somewhat hard", "Hard", "Hard+", "Very hard", "Very hard+", "Near max", "Maximal"];

export function CompleteWorkoutForm({ workout }: { workout: Pick<WorkoutDetail, "id" | "status" | "sessionRpe" | "durationMinutes" | "athleteComment"> }) {
  const router = useRouter();
  const q = useSetQueue();
  const [rpe, setRpe] = useState(workout.sessionRpe != null ? String(workout.sessionRpe) : "");
  const [dur, setDur] = useState(workout.durationMinutes != null ? String(workout.durationMinutes) : "");
  const [comment, setComment] = useState(workout.athleteComment ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fid = `complete-${workout.id}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (rpe === "" || dur === "") return setMsg({ ok: false, text: "Enter session RPE and duration." });
    setBusy(true);
    try {
      await flush();
      const res = await fetch(`/api/training/workouts/${workout.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionRpe: Number(rpe), durationMinutes: Number(dur), comment }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
      setMsg({ ok: true, text: "Workout complete. Session load recorded for your coach." });
      router.refresh();
    } catch (err) {
      const offline = err instanceof TypeError;
      setMsg({ ok: false, text: offline ? "You're offline. Your sets are saved on this device; complete the workout once you're back online." : (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-edge bg-surface p-4" aria-labelledby={`${fid}-h`}>
      <h3 id={`${fid}-h`} className="font-semibold">
        {workout.status === "completed" ? "Update completion" : "Finish workout"}
      </h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label htmlFor={`${fid}-rpe`} className="text-sm font-medium text-ink-2">
          Session RPE (0–10)
          <select id={`${fid}-rpe`} value={rpe} onChange={(e) => setRpe(e.target.value)} className="mt-1 h-12 w-full rounded-lg border border-edge bg-surface px-3 text-base" required>
            <option value="">Choose…</option>
            {RPE_HINT.map((h, i) => (
              <option key={i} value={i}>
                {i} — {h}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${fid}-dur`} className="text-sm font-medium text-ink-2">
          Duration (minutes)
          <input id={`${fid}-dur`} type="number" inputMode="numeric" min={1} max={600} value={dur} onChange={(e) => setDur(e.target.value)} className="mt-1 h-12 w-full rounded-lg border border-edge bg-surface px-3 text-base" required />
        </label>
      </div>
      <label htmlFor={`${fid}-c`} className="mt-3 block text-sm font-medium text-ink-2">
        Note for your coach (optional)
        <textarea id={`${fid}-c`} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} className="mt-1 min-h-20 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-base" />
      </label>
      {q.items.length ? <p className="mt-2 text-xs text-warn">{q.items.length} set entries will sync first.</p> : null}
      <button type="submit" disabled={busy} className={buttonClass("primary", "lg", "mt-3 w-full sm:w-auto")}>
        {busy ? "Saving…" : workout.status === "completed" ? "Update" : "Complete workout"}
      </button>
      {msg ? (
        <p role={msg.ok ? "status" : "alert"} className={cn("mt-2 text-sm", msg.ok ? "text-ok" : "text-bad")}>
          {msg.text}
        </p>
      ) : null}
    </form>
  );
}

/** Full workout logger (athlete "today" and workout detail). */
export function WorkoutLogger({ workout, canLog }: { workout: WorkoutDetail; canLog: boolean }) {
  useRefreshOnSync();
  return <WorkoutItems workout={workout} canLog={canLog} />;
}

/** Items only, without server refresh (the offline copy reloads its own data after a sync). */
export function WorkoutItemsList({ workout, canLog, showLinks = true }: { workout: { id: string; status: string; items: LoggerItem[] }; canLog: boolean; showLinks?: boolean }) {
  return <WorkoutItems workout={workout} canLog={canLog} showLinks={showLinks} />;
}

/** Re-render server data after the queue confirms entries, so "saved" reflects the database. */
export function useRefreshOnSync(onSynced?: () => void) {
  const router = useRouter();
  const { lastSyncedAt } = useSetQueue();
  useEffect(() => {
    void flush();
  }, []);
  useEffect(() => {
    if (!lastSyncedAt) return;
    if (onSynced) onSynced();
    else router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSyncedAt]);
}

function WorkoutItems({ workout, canLog, showLinks = true }: { workout: { id: string; status: string; items: LoggerItem[] }; canLog: boolean; showLinks?: boolean }) {
  return (
    <div className="space-y-3">
      {workout.items.map((it) => (
        <ItemCard key={it.id} item={it} canLog={canLog && workout.status !== "skipped"} big workoutId={workout.id} showLinks={showLinks} />
      ))}
      {workout.items.length === 0 ? <p className="text-sm text-ink-3">This workout has no exercises.</p> : null}
    </div>
  );
}
