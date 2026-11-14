"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, type ActionState } from "@/components/forms";
import { Button, Field, Input, Select } from "@/components/ui";
import type { QuestionDef } from "@/db/schema";

type Q = QuestionDef & { flagBelow?: string; flagAbove?: string };
type Init = { id?: string; name: string; frequency: string; groupIds: string[]; active: boolean; questions: QuestionDef[]; flagRules: Record<string, { below?: number | null; above?: number | null }> };

const blank = (): Q => ({ key: "", label: "", kind: "scale", min: 1, max: 5, polarity: "higher_better", required: true, anchors: {} });

/** Questionnaire builder. Serializes to one JSON payload validated server-side (zod). */
export function QuestionnaireBuilder({ init, groups, action }: { init: Init; groups: { id: string; name: string }[]; action: (p: ActionState, fd: FormData) => Promise<ActionState> }) {
  const [name, setName] = useState(init.name);
  const [frequency, setFrequency] = useState(init.frequency);
  const [groupIds, setGroupIds] = useState<string[]>(init.groupIds);
  const [active, setActive] = useState(init.active);
  const [qs, setQs] = useState<Q[]>(
    init.questions.length
      ? init.questions.map((q) => ({ ...q, flagBelow: init.flagRules[q.key]?.below?.toString() ?? "", flagAbove: init.flagRules[q.key]?.above?.toString() ?? "" }))
      : [blank()],
  );
  const update = (i: number, patch: Partial<Q>) => setQs((xs) => xs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const num = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : Number(s));

  const payload = JSON.stringify({
    id: init.id,
    name,
    frequency,
    groupIds,
    active,
    questions: qs.map((q) => {
      const base: QuestionDef = { key: q.key.trim(), label: q.label.trim(), kind: q.kind, required: !!q.required };
      if (q.kind === "scale") Object.assign(base, { min: Number(q.min), max: Number(q.max), polarity: q.polarity ?? "neutral", anchors: Object.fromEntries(Object.entries(q.anchors ?? {}).filter(([, v]) => v)) });
      if (q.kind === "number" && q.unit) base.unit = q.unit;
      return base;
    }),
    flagRules: Object.fromEntries(
      qs
        .filter((q) => (q.kind === "scale" || q.kind === "number") && (num(q.flagBelow) !== undefined || num(q.flagAbove) !== undefined))
        .map((q) => [q.key.trim(), { below: num(q.flagBelow) ?? null, above: num(q.flagAbove) ?? null }]),
    ),
  });

  return (
    <ActionForm action={action} className="space-y-5">
      <input type="hidden" name="payload" value={payload} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" htmlFor="qb-name" required>
          <Input id="qb-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </Field>
        <Field label="Schedule" htmlFor="qb-freq">
          <Select id="qb-freq" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays (Mon–Fri)</option>
            <option value="pre_session">Pre-session (days with a booking)</option>
          </Select>
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
        </label>
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-ink-2">Target groups (none = all athletes)</legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {groups.map((g) => (
            <label key={g.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds((xs) => (e.target.checked ? [...xs, g.id] : xs.filter((x) => x !== g.id)))} />
              {g.name}
            </label>
          ))}
        </div>
      </fieldset>
      <ol className="space-y-3">
        {qs.map((q, i) => (
          <li key={i} className="rounded-xl border border-edge p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-3">Question {i + 1}</span>
              <span className="flex gap-1">
                <Button type="button" variant="ghost" size="sm" disabled={i === 0} onClick={() => setQs((xs) => { const c = [...xs]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; })} aria-label={`Move question ${i + 1} up`}>
                  ↑
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={qs.length === 1} onClick={() => setQs((xs) => xs.filter((_, j) => j !== i))} aria-label={`Remove question ${i + 1}`}>
                  Remove
                </Button>
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-4">
              <Field label="Label" htmlFor={`ql-${i}`} className="sm:col-span-2">
                <Input id={`ql-${i}`} value={q.label} onChange={(e) => update(i, { label: e.target.value, key: q.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) })} />
              </Field>
              <Field label="Key" htmlFor={`qk-${i}`} hint="Stable id across versions">
                <Input id={`qk-${i}`} value={q.key} onChange={(e) => update(i, { key: e.target.value })} pattern="[a-z][a-z0-9_]*" />
              </Field>
              <Field label="Type" htmlFor={`qt-${i}`}>
                <Select id={`qt-${i}`} value={q.kind} onChange={(e) => update(i, { kind: e.target.value as Q["kind"] })}>
                  <option value="scale">Scale</option>
                  <option value="number">Number</option>
                  <option value="text">Text</option>
                  <option value="boolean">Yes / no</option>
                </Select>
              </Field>
              {q.kind === "scale" ? (
                <>
                  <Field label="Min" htmlFor={`qmin-${i}`}>
                    <Input id={`qmin-${i}`} type="number" value={q.min ?? ""} onChange={(e) => update(i, { min: Number(e.target.value) })} />
                  </Field>
                  <Field label="Max" htmlFor={`qmax-${i}`}>
                    <Input id={`qmax-${i}`} type="number" value={q.max ?? ""} onChange={(e) => update(i, { max: Number(e.target.value) })} />
                  </Field>
                  <Field label="Direction" htmlFor={`qp-${i}`} className="sm:col-span-2">
                    <Select id={`qp-${i}`} value={q.polarity ?? "neutral"} onChange={(e) => update(i, { polarity: e.target.value as Q["polarity"] })}>
                      <option value="higher_better">Higher is better (e.g. sleep quality)</option>
                      <option value="lower_better">Lower is better (e.g. soreness)</option>
                      <option value="neutral">Neutral (not in readiness)</option>
                    </Select>
                  </Field>
                  <Field label="Low anchor" htmlFor={`qal-${i}`}>
                    <Input id={`qal-${i}`} value={q.anchors?.[String(q.min)] ?? ""} onChange={(e) => update(i, { anchors: { ...q.anchors, [String(q.min)]: e.target.value } })} />
                  </Field>
                  <Field label="High anchor" htmlFor={`qah-${i}`}>
                    <Input id={`qah-${i}`} value={q.anchors?.[String(q.max)] ?? ""} onChange={(e) => update(i, { anchors: { ...q.anchors, [String(q.max)]: e.target.value } })} />
                  </Field>
                </>
              ) : null}
              {q.kind === "number" ? (
                <Field label="Unit" htmlFor={`qu-${i}`}>
                  <Input id={`qu-${i}`} value={q.unit ?? ""} onChange={(e) => update(i, { unit: e.target.value })} placeholder="h, kg…" />
                </Field>
              ) : null}
              {q.kind === "scale" || q.kind === "number" ? (
                <>
                  <Field label="Flag if below" htmlFor={`qfb-${i}`}>
                    <Input id={`qfb-${i}`} type="number" step="any" value={q.flagBelow ?? ""} onChange={(e) => update(i, { flagBelow: e.target.value })} />
                  </Field>
                  <Field label="Flag if above" htmlFor={`qfa-${i}`}>
                    <Input id={`qfa-${i}`} type="number" step="any" value={q.flagAbove ?? ""} onChange={(e) => update(i, { flagAbove: e.target.value })} />
                  </Field>
                </>
              ) : null}
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" checked={!!q.required} onChange={(e) => update(i, { required: e.target.checked })} /> Required
              </label>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => setQs((xs) => [...xs, blank()])}>
          Add question
        </Button>
        <SubmitButton>{init.id ? "Save (new version if questions changed)" : "Create questionnaire"}</SubmitButton>
      </div>
    </ActionForm>
  );
}
