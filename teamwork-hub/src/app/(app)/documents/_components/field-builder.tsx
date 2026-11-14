"use client";

import { useState } from "react";
import type { FormField, SignerRequirement } from "@/db/schema";
import { Button, Input, Select } from "@/components/ui";

const TYPES: FormField["type"][] = ["text", "textarea", "date", "checkbox", "select", "phone", "email"];
const ROLES: { role: SignerRequirement["role"]; label: string; hint: string }[] = [
  { role: "guardian", label: "Parent / guardian", hint: "Guardian with signing permission for the athlete (minors)." },
  { role: "second_guardian", label: "Second parent / guardian", hint: "A different guardian signs independently. If required, only enforced when a second signing guardian exists." },
  { role: "adult_athlete", label: "Adult athlete (18+)", hint: "Adults sign for themselves. Replaces guardian roles for athletes 18+." },
  { role: "athlete_assent", label: "Athlete assent (minor)", hint: "The minor athlete adds assent after a guardian signs." },
  { role: "staff_witness", label: "Staff witness", hint: "A staff member with forms permission witnesses." },
];

type Row = FormField & { optionsText: string; uid: number };

/** Field list + signer requirement builder. Serializes to hidden JSON inputs for the server action. */
export function FieldBuilder({ initialFields, initialSigners }: { initialFields: FormField[]; initialSigners: SignerRequirement[] }) {
  const [seq, setSeq] = useState(initialFields.length);
  const [rows, setRows] = useState<Row[]>(initialFields.map((f, i) => ({ ...f, optionsText: (f.options ?? []).join(", "), uid: i })));
  const [signers, setSigners] = useState<Record<string, "off" | "optional" | "required">>(() => {
    const m: Record<string, "off" | "optional" | "required"> = {};
    for (const r of ROLES) {
      const s = initialSigners.find((x) => x.role === r.role);
      m[r.role] = s ? (s.required ? "required" : "optional") : "off";
    }
    return m;
  });

  const update = (uid: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const j = i + d;
      if (j < 0 || j >= rs.length) return rs;
      const copy = [...rs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  const fieldsJson = JSON.stringify(
    rows.map((r) => ({
      key: r.key.trim(),
      label: r.label.trim(),
      type: r.type,
      required: r.required,
      ...(r.type === "select"
        ? {
            options: r.optionsText
              .split(",")
              .map((o) => o.trim())
              .filter(Boolean),
          }
        : {}),
    })),
  );
  const signersJson = JSON.stringify(
    ROLES.filter((r) => signers[r.role] !== "off").map((r) => ({ role: r.role, required: signers[r.role] === "required" })),
  );

  return (
    <div className="space-y-6">
      <input type="hidden" name="fieldsJson" value={fieldsJson} />
      <input type="hidden" name="signersJson" value={signersJson} />

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Fields the signer fills in</legend>
        {rows.length === 0 ? <p className="text-sm text-ink-3">No fields — signers only read and sign.</p> : null}
        <ol className="space-y-3">
          {rows.map((r, i) => (
            <li key={r.uid} className="rounded-lg border border-edge p-3">
              <div className="grid gap-3 sm:grid-cols-12">
                <div className="sm:col-span-3">
                  <label htmlFor={`fk-${r.uid}`} className="block text-xs font-medium text-ink-2">
                    Key
                  </label>
                  <Input id={`fk-${r.uid}`} value={r.key} onChange={(e) => update(r.uid, { key: e.target.value })} placeholder="emergency_phone" />
                </div>
                <div className="sm:col-span-5">
                  <label htmlFor={`fl-${r.uid}`} className="block text-xs font-medium text-ink-2">
                    Label
                  </label>
                  <Input id={`fl-${r.uid}`} value={r.label} onChange={(e) => update(r.uid, { label: e.target.value })} placeholder="Emergency phone" />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor={`ft-${r.uid}`} className="block text-xs font-medium text-ink-2">
                    Type
                  </label>
                  <Select id={`ft-${r.uid}`} value={r.type} onChange={(e) => update(r.uid, { type: e.target.value as FormField["type"] })}>
                    {TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex items-end gap-2 sm:col-span-2">
                  <label className="flex h-10 items-center gap-2 text-sm">
                    <input type="checkbox" checked={r.required} onChange={(e) => update(r.uid, { required: e.target.checked })} className="size-4" />
                    Required
                  </label>
                </div>
                {r.type === "select" ? (
                  <div className="sm:col-span-12">
                    <label htmlFor={`fo-${r.uid}`} className="block text-xs font-medium text-ink-2">
                      Options (comma-separated)
                    </label>
                    <Input id={`fo-${r.uid}`} value={r.optionsText} onChange={(e) => update(r.uid, { optionsText: e.target.value })} placeholder="Yes, No" />
                  </div>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move field ${r.label || r.key || i + 1} up`}>
                  ↑ Up
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={`Move field ${r.label || r.key || i + 1} down`}>
                  ↓ Down
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setRows((rs) => rs.filter((x) => x.uid !== r.uid))} aria-label={`Remove field ${r.label || r.key || i + 1}`}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ol>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setRows((rs) => [...rs, { key: `field_${seq + 1}`, label: "", type: "text", required: false, optionsText: "", uid: seq + 1000 }]);
            setSeq((s) => s + 1);
          }}
        >
          + Add field
        </Button>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Who signs</legend>
        <ul className="divide-y divide-edge rounded-lg border border-edge">
          {ROLES.map((r) => (
            <li key={r.role} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <label htmlFor={`sr-${r.role}`} className="text-sm font-medium">
                  {r.label}
                </label>
                <p className="text-xs text-ink-3">{r.hint}</p>
              </div>
              <Select
                id={`sr-${r.role}`}
                className="w-36"
                value={signers[r.role]}
                onChange={(e) => setSigners((s) => ({ ...s, [r.role]: e.target.value as "off" | "optional" | "required" }))}
              >
                <option value="off">Not used</option>
                <option value="optional">Optional</option>
                <option value="required">Required</option>
              </Select>
            </li>
          ))}
        </ul>
      </fieldset>
    </div>
  );
}
