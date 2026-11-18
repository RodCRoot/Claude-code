"use client";

import { useState } from "react";
import { BodyFigure } from "@/components/body-map/body-figure";
import { HURT, sorenessWord, type ScaleOption } from "@/lib/checkins/questions";
import { REGIONS, REGION_BY_KEY, type BodyView } from "@/lib/science/body-regions";

const tile =
  "flex min-h-14 cursor-pointer flex-col items-center justify-center rounded-lg border border-edge bg-surface px-1 py-2 text-center hover:bg-surface-2 has-[:checked]:border-brand has-[:checked]:bg-brand/10 has-[:checked]:ring-2 has-[:checked]:ring-brand has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand";

export function Question({ title, hint, optional, children, id }: { title: string; hint?: string; optional?: boolean; children: React.ReactNode; id?: string }) {
  return (
    <fieldset id={id} className="min-w-0">
      <legend className="mb-2 text-base font-semibold text-ink">
        {title} {optional ? <span className="text-sm font-normal text-ink-3">(optional)</span> : null}
      </legend>
      {hint ? <p className="-mt-1 mb-2 text-sm text-ink-3">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

/** One-tap scale: big radio tiles. Nothing is selected until the athlete taps (unanswered stays unanswered). */
export function ScalePick({ name, options, defaultValue, showNumber = true, cols }: { name: string; options: ScaleOption[]; defaultValue?: number | null; showNumber?: boolean; cols?: string }) {
  return (
    <div className={`grid gap-1.5 ${cols ?? "grid-cols-5"}`}>
      {options.map((o) => (
        <label key={o.value} className={tile}>
          <input type="radio" name={name} value={o.value} defaultChecked={defaultValue === o.value} className="sr-only" />
          {o.face ? (
            <span aria-hidden className="text-2xl leading-none">
              {o.face}
            </span>
          ) : showNumber ? (
            <span className="text-lg leading-none font-bold tabular">{o.value}</span>
          ) : null}
          <span className="mt-1 text-[11px] leading-tight font-medium text-ink-2">{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * 0 to 10 slider with word anchors. Until it is moved it submits NOTHING (an untouched slider is
 * an unanswered question, never a 0).
 */
export function SorenessSlider({ name, id, defaultValue, onChange }: { name: string; id: string; defaultValue?: number | null; onChange?: (v: number) => void }) {
  const [value, setValue] = useState<number | null>(defaultValue ?? null);
  const set = (n: number) => {
    setValue(n);
    onChange?.(n);
  };
  return (
    <div>
      {value !== null ? <input type="hidden" name={name} value={value} /> : null}
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={0}
          max={10}
          step={1}
          value={value ?? 0}
          onChange={(e) => set(Number(e.target.value))}
          onPointerDown={() => value === null && set(0)}
          onKeyDown={() => value === null && set(0)}
          aria-label="Soreness from 0 to 10"
          aria-valuetext={value === null ? "Not answered yet" : `${value} of 10, ${sorenessWord(value)}`}
          className={`h-12 min-w-0 flex-1 accent-[var(--brand)] ${value === null ? "opacity-50" : ""}`}
        />
        <output htmlFor={id} className="w-28 shrink-0 text-right">
          <span className="block text-2xl leading-none font-extrabold tabular">{value ?? "?"}</span>
          <span className="block text-xs font-medium text-ink-2">{value === null ? "Slide to answer" : sorenessWord(value)}</span>
        </output>
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-3" aria-hidden>
        <span>0 Not sore</span>
        <span>5 Sore</span>
        <span>10 Worst ever</span>
      </div>
    </div>
  );
}

export type SpotDefault = { view: BodyView; region: string; side: string; type: "ache" | "sharp"; level: number } | null;

/**
 * "Does anything hurt?" No / Yes, and when yes: where (the existing body figure, or the two
 * selects for anyone not using the picture), what it feels like, and how much. A sharp answer
 * shows a plain note to tell the coach and a parent. The app does not diagnose.
 */
export function HurtPicker({ question, phase, defaultHurt, defaultSpot, defaultStarted, nudge }: { question: string; phase: "pre" | "post"; defaultHurt?: boolean | null; defaultSpot?: SpotDefault; defaultStarted?: boolean | null; nudge?: boolean }) {
  const [hurt, setHurt] = useState<boolean | null>(defaultHurt ?? null);
  const [view, setView] = useState<BodyView>(defaultSpot?.view ?? "front");
  const [region, setRegion] = useState(defaultSpot?.region ?? "");
  const [side, setSide] = useState(defaultSpot?.side ?? "");
  const [type, setType] = useState<string>(defaultSpot?.type ?? "");
  const def = region ? REGION_BY_KEY[region] : null;
  const regions = REGIONS.filter((r) => r.views.includes(view));
  const complete = hurt && region && side && type;
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-base font-semibold text-ink">{question}</legend>
      {nudge && hurt === null ? <p className="-mt-1 mb-2 rounded-md bg-info/10 px-3 py-2 text-sm text-ink-2">That is pretty sore. If one spot hurts, tap Yes and show us where.</p> : null}
      <div className="grid grid-cols-2 gap-2">
        {[
          { v: "no", label: "No, all good", on: hurt === false, set: () => setHurt(false) },
          { v: "yes", label: phase === "pre" ? HURT.preToggle : "Yes, something did", on: hurt === true, set: () => setHurt(true) },
        ].map((o) => (
          <label key={o.v} className={`${tile} min-h-12 flex-row gap-2 text-sm font-semibold`}>
            <input type="radio" name="hurt" value={o.v} checked={o.on} onChange={o.set} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
      {hurt ? (
        <div className="mt-3 space-y-3 rounded-lg border border-edge bg-surface-2/50 p-3">
          <p className="text-sm font-semibold">{HURT.where}</p>
          <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
            <div>
              <div className="mb-2 flex gap-1" role="group" aria-label="Body view">
                {(["front", "back"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={view === v}
                    onClick={() => {
                      setView(v);
                      if (region && !REGION_BY_KEY[region].views.includes(v)) {
                        setRegion("");
                        setSide("");
                      }
                    }}
                    className={`min-h-11 flex-1 rounded-lg border px-3 text-sm font-medium ${view === v ? "border-brand bg-brand text-brand-ink" : "border-edge bg-surface"}`}
                  >
                    {v === "front" ? "Front" : "Back"}
                  </button>
                ))}
              </div>
              <BodyFigure
                view={view}
                selected={region && side ? { region, side } : null}
                onSelect={(s) => {
                  setRegion(s.region);
                  setSide(s.side);
                }}
                className="mx-auto w-full max-w-[180px]"
                title="Tap the spot that hurts"
              />
            </div>
            <div className="space-y-3">
              <input type="hidden" name="spotView" value={view} />
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-sm font-medium text-ink-2">
                  Body part
                  <select
                    name="spotRegion"
                    value={region}
                    onChange={(e) => {
                      setRegion(e.target.value);
                      const d = REGION_BY_KEY[e.target.value];
                      setSide(d && !d.sided ? "center" : "");
                    }}
                    className="mt-1 h-11 w-full rounded-lg border border-edge bg-surface px-2 text-sm"
                  >
                    <option value="">Choose…</option>
                    {regions.map((r) => (
                      <option key={r.region} value={r.region}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-medium text-ink-2">
                  Side
                  <select name="spotSide" value={side} onChange={(e) => setSide(e.target.value)} className="mt-1 h-11 w-full rounded-lg border border-edge bg-surface px-2 text-sm">
                    <option value="">Choose…</option>
                    {def?.sided !== false ? (
                      <>
                        <option value="left">Left</option>
                        <option value="right">Right</option>
                      </>
                    ) : null}
                    {!def || !def.sided ? <option value="center">Middle</option> : null}
                  </select>
                </label>
              </div>
              <fieldset>
                <legend className="mb-1 text-sm font-semibold">{HURT.typeQuestion}</legend>
                <div className="grid grid-cols-2 gap-2">
                  {HURT.types.map((t) => (
                    <label key={t.value} className={`${tile} min-h-14`}>
                      <input type="radio" name="spotType" value={t.value} checked={type === t.value} onChange={() => setType(t.value)} className="sr-only" />
                      <span className="text-sm font-semibold">{t.label}</span>
                      <span className="text-[11px] text-ink-3">{t.hint}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-1 text-sm font-semibold">{HURT.levelQuestion}</legend>
                <div className="grid grid-cols-3 gap-2">
                  {HURT.levels.map((l) => (
                    <label key={l.value} className={`${tile} min-h-12 text-sm font-semibold`}>
                      <input type="radio" name="spotLevel" value={l.value} defaultChecked={defaultSpot ? defaultSpot.level === l.value : l.value === 3} className="sr-only" />
                      {l.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              {phase === "post" ? (
                <fieldset>
                  <legend className="mb-1 text-sm font-semibold">{HURT.startedQuestion}</legend>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      ["yes", "Yes"],
                      ["no", "No, it was there before"],
                    ].map(([v, l]) => (
                      <label key={v} className={`${tile} min-h-12 text-sm font-semibold`}>
                        <input type="radio" name="hurtStartedInSession" value={v} defaultChecked={defaultStarted === (v === "yes")} className="sr-only" />
                        {l}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
            </div>
          </div>
          {type === "sharp" ? (
            <p role="alert" className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm font-medium text-ink">
              {HURT.sharpNote}
            </p>
          ) : (
            <p className="text-xs text-ink-3">{complete ? HURT.hurtNote : "No spot picked? That is OK. Your coach will still see that something hurts."}</p>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}

/** Multi-select quick chips (checkboxes styled as pills). */
export function ChipPick({ name, chips, selected, disabled }: { name: string; chips: { key: string; label: string }[]; selected: string[]; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <label
          key={c.key}
          className="inline-flex min-h-11 cursor-pointer items-center rounded-full border border-edge bg-surface px-4 text-sm font-medium hover:bg-surface-2 has-[:checked]:border-brand has-[:checked]:bg-brand has-[:checked]:text-brand-ink has-[:disabled]:opacity-40 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand"
        >
          <input type="checkbox" name={name} value={c.key} defaultChecked={selected.includes(c.key)} disabled={disabled} className="sr-only" />
          {c.label}
        </label>
      ))}
    </div>
  );
}
