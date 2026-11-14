"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input, Select } from "@/components/ui";
import { addGuardianAction, revokeGuardianshipAction, updateGuardianshipAction } from "../actions";

type Flags = {
  relationship: string;
  canViewTraining: boolean;
  canViewHealth: boolean;
  canBook: boolean;
  canSignForms: boolean;
  canMessageStaff: boolean;
  isEmergencyContact: boolean;
};

const FLAG_LABELS: [keyof Flags, string][] = [
  ["canViewTraining", "View training & performance"],
  ["canViewHealth", "View health (wellness, body map)"],
  ["canBook", "Book & cancel sessions"],
  ["canSignForms", "Sign forms"],
  ["canMessageStaff", "Message staff"],
  ["isEmergencyContact", "Emergency contact"],
];

function FlagInputs({ flags, idPrefix }: { flags: Flags; idPrefix: string }) {
  return (
    <>
      <Field label="Relationship" htmlFor={`${idPrefix}-rel`}>
        <Input id={`${idPrefix}-rel`} name="relationship" defaultValue={flags.relationship} />
      </Field>
      <fieldset className="grid gap-1 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-medium text-ink-2">Permissions (independent per guardian)</legend>
        {FLAG_LABELS.map(([k, label]) => (
          <label key={k} className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" name={k} defaultChecked={flags[k] as boolean} />
            {label}
          </label>
        ))}
      </fieldset>
    </>
  );
}

export function GuardianEditor({ guardianshipId, personId, flags }: { guardianshipId: string; personId: string; flags: Flags }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="min-h-10 text-sm font-medium text-brand underline-offset-2 hover:underline">
        {open ? "Close" : "Edit permissions"}
      </button>
      {open ? (
        <div className="mt-3 space-y-4 rounded-lg border border-edge p-4">
          <ActionForm action={updateGuardianshipAction} className="space-y-3">
            <input type="hidden" name="guardianshipId" value={guardianshipId} />
            <input type="hidden" name="personId" value={personId} />
            <FlagInputs flags={flags} idPrefix={guardianshipId} />
            <SubmitButton size="sm">Save permissions</SubmitButton>
          </ActionForm>
          <ActionForm action={revokeGuardianshipAction} className="space-y-2 border-t border-edge pt-3">
            <input type="hidden" name="guardianshipId" value={guardianshipId} />
            <input type="hidden" name="personId" value={personId} />
            <Field label="Reason for removing access" htmlFor={`${guardianshipId}-reason`}>
              <Input id={`${guardianshipId}-reason`} name="reason" required />
            </Field>
            <SubmitButton size="sm" variant="danger" confirm="Remove this guardian's access to the athlete? This is audited.">
              Remove guardian access
            </SubmitButton>
          </ActionForm>
        </div>
      ) : null}
    </div>
  );
}

export function AddGuardianForm({ athleteId, personId, candidates }: { athleteId: string; personId: string; candidates: { id: string; name: string }[] }) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  return (
    <ActionForm action={addGuardianAction} className="space-y-3" resetOnSuccess>
      <input type="hidden" name="athleteId" value={athleteId} />
      <input type="hidden" name="personId" value={personId} />
      <input type="hidden" name="mode" value={mode} />
      <div className="flex gap-3 text-sm">
        <label className="flex min-h-10 items-center gap-2">
          <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} /> New person
        </label>
        <label className="flex min-h-10 items-center gap-2">
          <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} /> Existing person
        </label>
      </div>
      {mode === "new" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" htmlFor="ag-first">
            <Input id="ag-first" name="gFirstName" required />
          </Field>
          <Field label="Last name" htmlFor="ag-last">
            <Input id="ag-last" name="gLastName" required />
          </Field>
          <Field label="Email" htmlFor="ag-email">
            <Input id="ag-email" name="gEmail" type="email" />
          </Field>
          <Field label="Phone" htmlFor="ag-phone">
            <Input id="ag-phone" name="gPhone" type="tel" />
          </Field>
        </div>
      ) : (
        <Field label="Person" htmlFor="ag-existing">
          <Select id="ag-existing" name="existingPersonId" defaultValue="" required>
            <option value="" disabled>
              Choose…
            </option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <FlagInputs
        idPrefix="new-guardian"
        flags={{ relationship: "parent", canViewTraining: true, canViewHealth: false, canBook: true, canSignForms: true, canMessageStaff: true, isEmergencyContact: true }}
      />
      <SubmitButton size="sm">Add guardian</SubmitButton>
    </ActionForm>
  );
}
