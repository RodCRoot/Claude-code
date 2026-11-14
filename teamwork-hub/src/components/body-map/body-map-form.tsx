"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, type ActionState } from "@/components/forms";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { REGIONS, REGION_BY_KEY, BODY_MAP_DISCLAIMER, type BodyView } from "@/lib/science/body-regions";
import { BodyFigure, HeatLegend, type HeatEntry } from "./body-figure";

/**
 * Body map entry: click a region on the figure OR use the equivalent selects (non-visual path).
 * Both write the same controlled state, so screen-reader and pointer users submit identical data.
 */
export function BodyMapForm({
  action,
  athleteId,
  heat,
  showDisclaimer = true,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  athleteId: string;
  heat: Record<string, HeatEntry>;
  showDisclaimer?: boolean;
}) {
  const [view, setView] = useState<BodyView>("front");
  const [region, setRegion] = useState<string>("");
  const [side, setSide] = useState<string>("");
  const [severity, setSeverity] = useState(3);
  const regionsForView = REGIONS.filter((r) => r.views.includes(view));
  const def = region ? REGION_BY_KEY[region] : null;

  return (
    <ActionForm action={action} resetOnSuccess className="space-y-4">
      <input type="hidden" name="athleteId" value={athleteId} />
      {showDisclaimer ? (
        <p className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-ink-2" role="note">
          {BODY_MAP_DISCLAIMER}
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-[minmax(0,280px)_1fr]">
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
                className={`min-h-11 flex-1 rounded-lg border px-3 text-sm font-medium ${view === v ? "border-brand bg-brand text-brand-ink" : "border-edge"}`}
              >
                {v === "front" ? "Front" : "Back"}
              </button>
            ))}
          </div>
          <BodyFigure
            view={view}
            heat={heat}
            selected={region && side ? { region, side } : null}
            onSelect={(s) => {
              setRegion(s.region);
              setSide(s.side);
            }}
            className="mx-auto w-full max-w-[260px]"
            title="Tap a body region to select it"
          />
          <HeatLegend />
        </div>
        <div className="space-y-3">
          <input type="hidden" name="view" value={view} />
          <Field label="Region" htmlFor="bm-region" required>
            <Select
              id="bm-region"
              name="region"
              required
              value={region}
              onChange={(e) => {
                setRegion(e.target.value);
                const d = REGION_BY_KEY[e.target.value];
                setSide(d && !d.sided ? "center" : "");
              }}
            >
              <option value="">Choose a region…</option>
              {regionsForView.map((r) => (
                <option key={r.region} value={r.region}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Side" htmlFor="bm-side" required hint="Athlete's own left/right.">
            <Select id="bm-side" name="side" required value={side} onChange={(e) => setSide(e.target.value)}>
              <option value="">Choose…</option>
              {def?.sided !== false ? (
                <>
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </>
              ) : null}
              {!def || !def.sided ? <option value="center">Center</option> : null}
            </Select>
          </Field>
          <fieldset>
            <legend className="text-sm font-medium text-ink-2">Type</legend>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {[
                ["soreness", "Soreness", "Normal training soreness"],
                ["pain", "Pain", "Sharp, unusual, or worsening"],
              ].map(([v, l, h]) => (
                <label key={v} className="flex min-h-11 cursor-pointer flex-col rounded-lg border border-edge px-3 py-2 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand/10">
                  <span className="flex items-center gap-2 font-medium">
                    <input type="radio" name="kind" value={v} defaultChecked={v === "soreness"} required /> {l}
                  </span>
                  <span className="text-xs text-ink-3">{h}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="bm-sev-range" className="block text-sm font-medium text-ink-2">
              Severity (0 = none, 10 = worst)
            </label>
            <div className="mt-1 flex items-center gap-3">
              <input id="bm-sev-range" type="range" min={0} max={10} step={1} value={severity} onChange={(e) => setSeverity(Number(e.target.value))} className="h-11 flex-1 accent-[var(--brand)]" aria-describedby="bm-sev-hint" />
              <Input aria-label="Severity number" type="number" name="severity" min={0} max={10} value={severity} onChange={(e) => setSeverity(Math.max(0, Math.min(10, Number(e.target.value) || 0)))} className="w-20" required />
            </div>
            <p id="bm-sev-hint" className="text-xs text-ink-3">
              Pain reports, or soreness at or above the facility threshold, go to a coach for review.
            </p>
          </div>
          <Field label="Note (optional)" htmlFor="bm-note">
            <Textarea id="bm-note" name="note" maxLength={500} placeholder="When does it hurt? What were you doing?" />
          </Field>
          <SubmitButton size="lg" className="w-full">
            Save report
          </SubmitButton>
        </div>
      </div>
    </ActionForm>
  );
}
