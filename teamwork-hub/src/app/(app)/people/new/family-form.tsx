"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input, Select } from "@/components/ui";
import { createFamilyAction } from "../actions";

export function FamilyForm({ guardians, groups }: { guardians: { id: string; name: string; email: string | null }[]; groups: { id: string; name: string }[] }) {
  const [mode, setMode] = useState<"new" | "existing" | "none">("new");
  return (
    <ActionForm action={createFamilyAction} className="space-y-6">
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold">Athlete</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="firstName" required>
            <Input id="firstName" name="firstName" required autoComplete="off" />
          </Field>
          <Field label="Last name" htmlFor="lastName" required>
            <Input id="lastName" name="lastName" required autoComplete="off" />
          </Field>
          <Field label="Date of birth" htmlFor="dateOfBirth" hint="Used for age groups and identity matching. Never used alone to merge records.">
            <Input id="dateOfBirth" name="dateOfBirth" type="date" />
          </Field>
          <Field label="Sport" htmlFor="sport">
            <Input id="sport" name="sport" />
          </Field>
          <Field label="School" htmlFor="school">
            <Input id="school" name="school" />
          </Field>
          <Field label="Graduation year" htmlFor="gradYear">
            <Input id="gradYear" name="gradYear" inputMode="numeric" />
          </Field>
          <Field label="Athlete email (adults)" htmlFor="email">
            <Input id="email" name="email" type="email" />
          </Field>
          <Field label="Athlete phone (adults)" htmlFor="phone">
            <Input id="phone" name="phone" type="tel" />
          </Field>
          <Field label="Training group" htmlFor="groupId">
            <Select id="groupId" name="groupId" defaultValue="">
              <option value="">None yet</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-base font-semibold">Parent / guardian</legend>
        <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Guardian">
          {(
            [
              ["new", "New guardian"],
              ["existing", "Existing person"],
              ["none", "No guardian (adult athlete pays for themselves)"],
            ] as const
          ).map(([val, label]) => (
            <label key={val} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-edge px-3 text-sm">
              <input type="radio" name="guardianMode" value={val} checked={mode === val} onChange={() => setMode(val)} />
              {label}
            </label>
          ))}
        </div>
        {mode === "new" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Guardian first name" htmlFor="gFirstName" required>
              <Input id="gFirstName" name="gFirstName" required />
            </Field>
            <Field label="Guardian last name" htmlFor="gLastName" required>
              <Input id="gLastName" name="gLastName" required />
            </Field>
            <Field label="Guardian email" htmlFor="gEmail">
              <Input id="gEmail" name="gEmail" type="email" />
            </Field>
            <Field label="Guardian phone" htmlFor="gPhone">
              <Input id="gPhone" name="gPhone" type="tel" />
            </Field>
          </div>
        ) : null}
        {mode === "existing" ? (
          <Field label="Existing guardian" htmlFor="existingGuardianId" hint="Linking adds this child to their household and payer account. A second guardian can be added afterwards with separate permissions.">
            <Select id="existingGuardianId" name="existingGuardianId" required defaultValue="">
              <option value="" disabled>
                Choose a person…
              </option>
              {guardians.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                  {g.email ? ` — ${g.email}` : ""}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {mode !== "none" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Relationship" htmlFor="relationship">
              <Input id="relationship" name="relationship" defaultValue="parent" />
            </Field>
            <label className="flex min-h-11 items-center gap-2 self-end text-sm">
              <input type="checkbox" name="canViewHealth" /> Guardian may view wellness &amp; body-map (health) data
            </label>
          </div>
        ) : null}
      </fieldset>

      <label className="flex items-start gap-2 text-sm text-ink-2">
        <input type="checkbox" name="confirmDuplicates" className="mt-1" />
        <span>These are different people from any similar existing records (only tick this after reviewing a duplicate warning — records are never merged automatically).</span>
      </label>
      <SubmitButton size="lg" pendingText="Registering…">
        Register athlete
      </SubmitButton>
    </ActionForm>
  );
}
