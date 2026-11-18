"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { buttonClass } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import {
  blocksOf,
  changedDays,
  dropOnDayEnd,
  dropOnItem,
  groupsFromLabels,
  joinPrevious,
  moveStep,
  moveToDay,
  normalizeDay,
  separate,
  type BlockType,
  type DayLayout,
} from "@/lib/training/program-layout";
import { bulkEditSchemeAction, saveProgramLayoutAction } from "../actions";

export type BuilderItem = { id: string; blockLabel: string; blockType: BlockType; exerciseName: string; summary: string };
export type BuilderDay = { id: string; week: number; dayIndex: number; title: string; phaseName: string | null; items: BuilderItem[] };

type FocusTarget = { id: string; action: "up" | "down" | "join" | "separate" | "move" | "drag" };

const toLayout = (days: BuilderDay[]): DayLayout[] => days.map((d) => ({ dayId: d.id, items: groupsFromLabels(d.id, d.items) }));

/**
 * Week view of the program builder. Reorder items within a day, move them between days, and build
 * or split supersets — by native HTML drag-and-drop or with the per-item buttons (keyboard).
 * Every change is saved right away through `saveProgramLayoutAction` (atomic, version-checked);
 * labels shown are the same normalization the server applies.
 */
export function ProgramWeekBuilder({
  programId,
  version,
  days,
  itemEditors,
  dayTools,
  dayFooters,
}: {
  programId: string;
  version: number;
  days: BuilderDay[];
  itemEditors: Record<string, React.ReactNode>;
  dayTools: Record<string, React.ReactNode>;
  dayFooters: Record<string, React.ReactNode>;
}) {
  const router = useRouter();
  const serverLayout = useMemo(() => toLayout(days), [days]);
  const [layout, setLayout] = useState<DayLayout[]>(serverLayout);
  const [synced, setSynced] = useState({ days, version });
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(0);
  const [drag, setDrag] = useState<{ id: string; over: { targetId: string; position: "before" | "after" } | { dayId: string } | null } | null>(null);
  // Where keyboard focus goes after the next layout change (consumed once; refreshes don't move focus).
  const pendingFocus = useRef<FocusTarget | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [moveTarget, setMoveTarget] = useState<Record<string, string>>({});
  const versionRef = useRef(version);
  const savedRef = useRef<DayLayout[]>(serverLayout);
  const queue = useRef<Promise<void>>(Promise.resolve());

  // New server data (after a save, a form edit elsewhere on the page, or a refresh) resets local state.
  if (synced.days !== days || synced.version !== version) {
    setSynced({ days, version });
    if (saving === 0) setLayout(serverLayout);
  }
  useEffect(() => {
    if (saving === 0) {
      versionRef.current = Math.max(versionRef.current, version);
      savedRef.current = serverLayout;
    }
  }, [serverLayout, version, saving]);

  useEffect(() => {
    const focus = pendingFocus.current;
    if (!focus) return;
    pendingFocus.current = null;
    const el =
      document.querySelector<HTMLElement>(`[data-focus-key="${focus.id}:${focus.action}"]:not([disabled])`) ??
      document.querySelector<HTMLElement>(`[data-focus-key^="${focus.id}:"]:not([disabled])`);
    el?.focus();
  }, [layout]);

  const info = useMemo(() => new Map(days.flatMap((d) => d.items.map((i) => [i.id, i] as const))), [days]);
  const dayById = useMemo(() => new Map(days.map((d) => [d.id, d])), [days]);
  const dayName = (id: string) => {
    const d = dayById.get(id);
    return d ? `Day ${d.dayIndex} (${d.title})` : "day";
  };

  function commit(next: DayLayout[], describe: (labelOf: (id: string) => string) => string, focusTarget?: FocusTarget) {
    const touched = changedDays(layout, next);
    if (!touched.length) {
      setStatus({ ok: true, text: "Already there — nothing to change." });
      return;
    }
    setLayout(next);
    pendingFocus.current = focusTarget ?? null;
    const labels = new Map(next.flatMap((d) => normalizeDay(d.items).map((n) => [n.id, n.blockLabel] as const)));
    const text = describe((id) => labels.get(id) ?? "");
    setStatus({ ok: true, text: `${text} Saving…` });
    setSaving((n) => n + 1);
    const payload = touched.map((d) => ({ dayId: d.dayId, items: d.items.map((i) => ({ id: i.id, group: i.group })) }));
    queue.current = queue.current.then(async () => {
      try {
        const res = await saveProgramLayoutAction(programId, { expectedVersion: versionRef.current, days: payload });
        if (res.ok) {
          const v = Number(res.data?.version);
          if (Number.isFinite(v)) versionRef.current = v;
          savedRef.current = next;
          setStatus({ ok: true, text: `${text} Saved (v${versionRef.current}).` });
        } else {
          setLayout(savedRef.current);
          setStatus({ ok: false, text: res.error ?? "Could not save the new order." });
        }
      } catch {
        setLayout(savedRef.current);
        setStatus({ ok: false, text: "Could not reach the server. The order was not saved." });
      } finally {
        setSaving((n) => n - 1);
        router.refresh();
      }
    });
  }

  const name = (id: string) => info.get(id)?.exerciseName ?? "Exercise";
  const position = (next: DayLayout[], id: string) => {
    const d = next.find((x) => x.items.some((i) => i.id === id))!;
    return { day: d.dayId, index: d.items.findIndex((i) => i.id === id) + 1, of: d.items.length };
  };
  const moved = (next: DayLayout[], id: string) => (labelOf: (id: string) => string) => {
    const p = position(next, id);
    return `${name(id)} is now ${labelOf(id)}, position ${p.index} of ${p.of} in ${dayName(p.day)}.`;
  };

  function onDrop(e: React.DragEvent, target: { targetId: string; position: "before" | "after" } | { dayId: string }) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/x-program-item") || drag?.id;
    setDrag(null);
    if (!id || !info.has(id)) return;
    const next = "dayId" in target ? dropOnDayEnd(layout, id, target.dayId) : dropOnItem(layout, id, target.targetId, target.position);
    commit(next, moved(next, id), { id, action: "drag" });
  }

  const allIds = layout.flatMap((d) => d.items.map((i) => i.id));
  const selectedHere = selected.filter((id) => allIds.includes(id));

  return (
    <div>
      <p role="status" aria-live="polite" className={cn("mb-3 min-h-5 text-sm", status ? (status.ok ? "text-ink-2" : "text-bad") : "text-ink-3")} data-testid="builder-status">
        {status?.text ?? "Drag exercises by the ⠿ handle, or use the buttons on each exercise to reorder with the keyboard. Changes save immediately."}
      </p>
      {/* Day columns (side by side on wide screens, scrolling sideways when a week has many days). */}
      <div className="space-y-4 lg:flex lg:items-start lg:gap-3 lg:space-y-0 lg:overflow-x-auto lg:pb-3" tabIndex={0} role="region" aria-label="Days this week">
        {layout.map((dl) => {
          const day = dayById.get(dl.dayId);
          if (!day) return null;
          const normalized = new Map(normalizeDay(dl.items).map((n) => [n.id, n] as const));
          const blocks = blocksOf(dl.items);
          const otherDays = layout.filter((x) => x.dayId !== dl.dayId);
          return (
            <section
              key={dl.dayId}
              className="overflow-hidden rounded-xl border border-edge bg-surface-2 lg:min-w-[19rem] lg:flex-1 lg:basis-0"
              aria-labelledby={`day-${dl.dayId}`}
              data-testid={`builder-day-${day.dayIndex}`}
            >
              <header className="mb-2 flex flex-wrap items-center justify-between gap-2 border-t-4 border-t-brand bg-surface px-3 pt-2 pb-1">
                <h3 id={`day-${dl.dayId}`} className="min-w-0">
                  <span className="block text-[11px] font-bold uppercase tracking-wider text-ink-3">
                    Week {day.week} · Day {day.dayIndex}
                    <span className="sr-only">:</span>
                  </span>
                  <span className="block text-base leading-tight font-extrabold">{day.title}</span>
                  {day.phaseName ? <span className="mt-0.5 inline-block rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2">{day.phaseName}</span> : null}
                </h3>
                <div className="w-full">{dayTools[dl.dayId]}</div>
              </header>
              <ol className="space-y-2 px-2" aria-label={`Exercises, ${dayName(dl.dayId)}`}>
                {dl.items.map((it, idx) => {
                  const meta = info.get(it.id);
                  const n = normalized.get(it.id)!;
                  const bi = blocks.findIndex((b) => b.includes(it));
                  const block = blocks[bi];
                  const multi = block.length > 1;
                  const over = drag?.over && "targetId" in drag.over && drag.over.targetId === it.id ? drag.over.position : null;
                  const ename = meta?.exerciseName ?? "Exercise";
                  return (
                    <li
                      key={it.id}
                      data-testid={`builder-item-${n.blockLabel}`}
                      data-item-id={it.id}
                      className={cn(
                        "rounded-lg border border-edge border-l-4 bg-surface p-2 shadow-[0_1px_2px_rgb(16_24_40/0.06)]",
                        multi ? "border-l-brand" : "border-l-ink-3/40",
                        over === "before" && "border-t-4 border-t-brand",
                        over === "after" && "border-b-4 border-b-brand",
                        drag?.id === it.id && "opacity-50",
                      )}
                      onDragOver={(e) => {
                        if (!drag) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        const r = e.currentTarget.getBoundingClientRect();
                        const position = e.clientY < r.top + r.height / 2 ? "before" : "after";
                        if (!over || over !== position) setDrag((d) => (d ? { ...d, over: { targetId: it.id, position } } : d));
                      }}
                      onDrop={(e) => onDrop(e, { targetId: it.id, position: over ?? "before" })}
                    >
                      <div
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/x-program-item", it.id);
                          e.dataTransfer.effectAllowed = "move";
                          const li = e.currentTarget.closest("li");
                          if (li) e.dataTransfer.setDragImage(li, 16, 16);
                          setDrag({ id: it.id, over: null });
                        }}
                        onDragEnd={() => setDrag(null)}
                        className="flex cursor-grab flex-col gap-0.5 active:cursor-grabbing"
                        data-focus-key={`${it.id}:drag`}
                        tabIndex={-1}
                      >
                        <span className="flex items-center font-bold">
                          <span aria-hidden className="mr-1.5 select-none text-lg leading-none text-ink-3" title="Drag to move">
                            ⠿
                          </span>
                          <span className="mr-2 inline-flex min-w-8 justify-center rounded-md bg-ink px-1.5 py-0.5 text-xs font-extrabold text-surface">{n.blockLabel}</span>
                          <span className="min-w-0 flex-1">{ename}</span>
                          <span className="ml-2 shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-2">{n.blockType}</span>
                        </span>
                        <span className="pl-6 text-xs font-medium text-ink-2 tabular">{meta?.summary}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-0.5 border-t border-edge/70 pt-1">
                        <label className="mr-1 flex min-h-11 items-center gap-1.5 text-xs text-ink-2">
                          <input
                            type="checkbox"
                            className="size-4"
                            checked={selected.includes(it.id)}
                            onChange={(e) => setSelected((s) => (e.target.checked ? [...s, it.id] : s.filter((x) => x !== it.id)))}
                            aria-label={`Select ${ename} (${n.blockLabel}) for bulk edit`}
                          />
                          Select
                        </label>
                        <button
                          type="button"
                          className={buttonClass("ghost", "sm", "min-h-11 min-w-11")}
                          disabled={idx === 0}
                          data-focus-key={`${it.id}:up`}
                          aria-label={`Move ${ename} up`}
                          onClick={() => {
                            const next = moveStep(layout, it.id, -1);
                            commit(next, moved(next, it.id), { id: it.id, action: "up" });
                          }}
                        >
                          ↑ Up
                        </button>
                        <button
                          type="button"
                          className={buttonClass("ghost", "sm", "min-h-11 min-w-11")}
                          disabled={idx === dl.items.length - 1}
                          data-focus-key={`${it.id}:down`}
                          aria-label={`Move ${ename} down`}
                          onClick={() => {
                            const next = moveStep(layout, it.id, 1);
                            commit(next, moved(next, it.id), { id: it.id, action: "down" });
                          }}
                        >
                          ↓ Down
                        </button>
                        {bi > 0 ? (
                          <button
                            type="button"
                            className={buttonClass("ghost", "sm", "min-h-11")}
                            data-focus-key={`${it.id}:join`}
                            aria-label={`Join ${ename} to block ${String.fromCharCode(64 + bi)} above`}
                            onClick={() => {
                              const next = joinPrevious(layout, it.id);
                              commit(next, moved(next, it.id), { id: it.id, action: "separate" });
                            }}
                          >
                            Join block above
                          </button>
                        ) : null}
                        {multi ? (
                          <button
                            type="button"
                            className={buttonClass("ghost", "sm", "min-h-11")}
                            data-focus-key={`${it.id}:separate`}
                            aria-label={`Separate ${ename} from block ${n.blockLabel.charAt(0)}`}
                            onClick={() => {
                              const next = separate(layout, it.id);
                              commit(next, moved(next, it.id), { id: it.id, action: "join" });
                            }}
                          >
                            Separate
                          </button>
                        ) : null}
                        {otherDays.length ? (
                          <span className="flex items-center gap-1">
                            <label className="sr-only" htmlFor={`mv-${it.id}`}>
                              Move {ename} to day
                            </label>
                            <select
                              id={`mv-${it.id}`}
                              className="h-11 rounded-lg border border-edge bg-surface px-2 text-sm"
                              value={moveTarget[it.id] ?? otherDays[0].dayId}
                              onChange={(e) => setMoveTarget((m) => ({ ...m, [it.id]: e.target.value }))}
                            >
                              {otherDays.map((o) => (
                                <option key={o.dayId} value={o.dayId}>
                                  {dayName(o.dayId)}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className={buttonClass("ghost", "sm", "min-h-11")}
                              data-focus-key={`${it.id}:move`}
                              aria-label={`Move ${ename} to the selected day`}
                              onClick={() => {
                                const next = moveToDay(layout, it.id, moveTarget[it.id] ?? otherDays[0].dayId);
                                commit(next, moved(next, it.id), { id: it.id, action: "move" });
                              }}
                            >
                              Move
                            </button>
                          </span>
                        ) : null}
                      </div>
                      {itemEditors[it.id]}
                    </li>
                  );
                })}
              </ol>
              <div
                className={cn(
                  "mx-2 mt-2 rounded-lg border-2 border-dashed px-3 py-2 text-xs text-ink-3",
                  drag ? "border-brand/50" : "border-transparent",
                  drag?.over && "dayId" in drag.over && drag.over.dayId === dl.dayId && "border-brand bg-brand/5",
                  !drag && "sr-only",
                )}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  if (!(drag.over && "dayId" in drag.over && drag.over.dayId === dl.dayId)) setDrag((d) => (d ? { ...d, over: { dayId: dl.dayId } } : d));
                }}
                onDrop={(e) => onDrop(e, { dayId: dl.dayId })}
                aria-hidden
              >
                Drop here to put it at the end of {dayName(dl.dayId)}
              </div>
              <div className="px-3 pb-2">{dayFooters[dl.dayId]}</div>
            </section>
          );
        })}
      </div>

      <section className="mt-6 rounded-xl border border-edge bg-surface-2 p-3" aria-labelledby="bulk-h">
        <h3 id="bulk-h" className="font-semibold">
          Bulk edit set scheme <span className="text-sm font-normal text-ink-3">({selectedHere.length} selected)</span>
        </h3>
        <p className="mb-2 text-xs text-ink-3">Tick exercises above, then change any of these. Blank fields stay as they are. Existing workouts are not changed.</p>
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" className={buttonClass("secondary", "sm", "min-h-11")} onClick={() => setSelected(allIds)}>
            Select all this week
          </button>
          <button type="button" className={buttonClass("ghost", "sm", "min-h-11")} onClick={() => setSelected([])} disabled={!selectedHere.length}>
            Clear selection
          </button>
        </div>
        <ActionForm action={bulkEditSchemeAction} className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8 lg:items-end">
          <input type="hidden" name="programId" value={programId} />
          {selectedHere.map((id) => (
            <input key={id} type="hidden" name="itemIds" value={id} />
          ))}
          <BulkField id="bulk_sets" label="Sets" type="number" min={1} max={20} />
          <BulkField id="bulk_reps" label="Reps" type="number" min={1} max={200} />
          <BulkField id="bulk_repsText" label="Rep text" placeholder="e.g. AMRAP" />
          <label htmlFor="bulk_loadType" className="text-xs font-medium text-ink-2">
            Load
            <select id="bulk_loadType" name="bulk_loadType" className="mt-1 h-11 w-full rounded-lg border border-edge bg-surface px-2 text-sm" defaultValue="">
              <option value="">Unchanged</option>
              <option value="percent_max">% of max</option>
              <option value="absolute">Weight</option>
              <option value="rpe">RPE</option>
              <option value="rir">RIR</option>
              <option value="bodyweight">Bodyweight</option>
              <option value="none">None</option>
            </select>
          </label>
          <BulkField id="bulk_loadValue" label="Load value" type="number" step="0.5" min={0} />
          <label htmlFor="bulk_loadUnit" className="text-xs font-medium text-ink-2">
            Unit
            <select id="bulk_loadUnit" name="bulk_loadUnit" className="mt-1 h-11 w-full rounded-lg border border-edge bg-surface px-2 text-sm" defaultValue="lb">
              <option value="lb">lb</option>
              <option value="kg">kg</option>
            </select>
          </label>
          <BulkField id="bulk_restS" label="Rest (s)" type="number" min={0} max={3600} />
          <BulkField id="bulk_tempo" label="Tempo" placeholder="30X1" />
          <label htmlFor="bulk_applyTo" className="col-span-2 text-xs font-medium text-ink-2">
            Apply to
            <select id="bulk_applyTo" name="bulk_applyTo" className="mt-1 h-11 w-full rounded-lg border border-edge bg-surface px-2 text-sm" defaultValue="working">
              <option value="working">Working sets (skip warm-ups)</option>
              <option value="all">All set groups</option>
            </select>
          </label>
          <div className="col-span-2 sm:col-span-2">
            <SubmitButton size="sm">Apply to {selectedHere.length} selected</SubmitButton>
          </div>
        </ActionForm>
      </section>
    </div>
  );
}

function BulkField({ id, label, ...rest }: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label htmlFor={id} className="text-xs font-medium text-ink-2">
      {label}
      <input id={id} name={id} {...rest} className="mt-1 h-11 w-full rounded-lg border border-edge bg-surface px-2 text-sm" />
    </label>
  );
}
