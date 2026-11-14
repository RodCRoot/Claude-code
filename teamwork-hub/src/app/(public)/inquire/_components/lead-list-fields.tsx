"use client";

import { useState } from "react";
import { Field, Input, Select } from "@/components/ui";

export type LeadListsProp = { sources: string[]; interests: string[]; priorities: string[] };
/** Must match KEEP and OTHER in src/lib/crm/lead-vocab.ts (that module is server-side). */
const KEEP = "__keep__";
const OTHER = "Other";

export type LeadListValues = {
  source?: string | null;
  sourceOther?: string | null;
  interest?: string | null;
  interestOther?: string | null;
  priority?: string | null;
  /** Older stored values that are not on a list: offered as "keep as is" so editing never loses them. */
  keepSource?: string | null;
  keepInterest?: string | null;
};

/**
 * Source, Interest and (staff only) Priority as lists, each with "Other" plus free text.
 * Field names: leadSource + heardFrom (the free text), leadInterest + interestOther, priority.
 */
export function LeadListFields({ lists, staff = false, values = {}, idPrefix = "" }: { lists: LeadListsProp; staff?: boolean; values?: LeadListValues; idPrefix?: string }) {
  const [source, setSource] = useState(values.keepSource ? KEEP : (values.source ?? ""));
  const [interest, setInterest] = useState(values.keepInterest ? KEEP : (values.interest ?? ""));
  const id = (s: string) => `${idPrefix}${s}`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Field label={staff ? "Source" : "How did you hear about us?"} htmlFor={id("leadSource")}>
          <Select id={id("leadSource")} name="leadSource" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">{staff ? "Not recorded" : "Choose one"}</option>
            {values.keepSource ? <option value={KEEP}>{values.keepSource} (as recorded)</option> : null}
            {lists.sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        {source === OTHER ? (
          <Field label={staff ? "Other source" : "Where did you hear about us?"} htmlFor={id("heardFrom")}>
            <Input id={id("heardFrom")} name="heardFrom" maxLength={120} defaultValue={values.sourceOther ?? ""} />
          </Field>
        ) : null}
      </div>
      <div className="space-y-2">
        <Field label={staff ? "Interest" : "What are you most interested in?"} htmlFor={id("leadInterest")}>
          <Select id={id("leadInterest")} name="leadInterest" value={interest} onChange={(e) => setInterest(e.target.value)}>
            <option value="">{staff ? "Not recorded" : "Choose one"}</option>
            {values.keepInterest ? <option value={KEEP}>{values.keepInterest} (as recorded)</option> : null}
            {lists.interests.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        {interest === OTHER ? (
          <Field label="Other interest" htmlFor={id("interestOther")}>
            <Input id={id("interestOther")} name="interestOther" maxLength={120} defaultValue={values.interestOther ?? ""} />
          </Field>
        ) : null}
      </div>
      {staff ? (
        <Field label="Priority" htmlFor={id("priority")}>
          <Select id={id("priority")} name="priority" defaultValue={values.priority ?? ""}>
            <option value="">Not set</option>
            {lists.priorities.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
    </div>
  );
}
