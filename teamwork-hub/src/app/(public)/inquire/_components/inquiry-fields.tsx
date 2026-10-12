"use client";

import { useState } from "react";
import { Field, Input, Select, Textarea } from "@/components/ui";

export const PREFERRED_TIME_OPTIONS = ["Weekday mornings", "Weekday afternoons", "Weekday evenings", "Weekends"];

/**
 * Shared inquiry fields (public /inquire form and staff "Add lead").
 * Field names match createLeadFromInquiry's schema.
 */
export function InquiryFields({ staff = false }: { staff?: boolean }) {
  const [forWho, setForWho] = useState<"child" | "self">("child");
  const you = staff ? "Contact" : "Your";
  return (
    <div className="space-y-6">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-2">{staff ? "Who is the athlete?" : "Who is this inquiry for?"}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name="inquiringFor" value="child" checked={forWho === "child"} onChange={() => setForWho("child")} className="size-4" />
            {staff ? "A child (contact is the parent/guardian)" : "My child"}
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name="inquiringFor" value="self" checked={forWho === "self"} onChange={() => setForWho("self")} className="size-4" />
            {staff ? "The contact (adult athlete)" : "Myself (adult athlete)"}
          </label>
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={`${you} first name`} htmlFor="contactFirstName" required>
          <Input id="contactFirstName" name="contactFirstName" autoComplete={staff ? "off" : "given-name"} required maxLength={80} />
        </Field>
        <Field label={`${you} last name`} htmlFor="contactLastName" required>
          <Input id="contactLastName" name="contactLastName" autoComplete={staff ? "off" : "family-name"} required maxLength={80} />
        </Field>
        <Field label="Email" htmlFor="email" hint="Email or phone is required">
          <Input id="email" name="email" type="email" autoComplete={staff ? "off" : "email"} maxLength={200} />
        </Field>
        <Field label="Mobile phone" htmlFor="phone">
          <Input id="phone" name="phone" type="tel" autoComplete={staff ? "off" : "tel"} maxLength={20} />
        </Field>
      </div>

      {forWho === "child" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Athlete first name" htmlFor="athleteFirstName" required>
            <Input id="athleteFirstName" name="athleteFirstName" required maxLength={80} />
          </Field>
          <Field label="Athlete last name" htmlFor="athleteLastName" required>
            <Input id="athleteLastName" name="athleteLastName" required maxLength={80} />
          </Field>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Athlete age" htmlFor="athleteAge" required>
          <Input id="athleteAge" name="athleteAge" type="number" inputMode="numeric" min={5} max={99} required />
        </Field>
        <Field label="Primary sport" htmlFor="sport">
          <Input id="sport" name="sport" maxLength={80} placeholder="e.g. Volleyball" />
        </Field>
      </div>

      <Field label="Goals" htmlFor="goals" hint="What would you like training to help with?">
        <Textarea id="goals" name="goals" maxLength={2000} rows={3} />
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-2">Preferred times</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {PREFERRED_TIME_OPTIONS.map((t) => (
            <label key={t} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="preferredTimes" value={t} className="size-4" />
              {t}
            </label>
          ))}
        </div>
      </fieldset>

      <Field label={staff ? "Source" : "How did you hear about us?"} htmlFor="heardFrom">
        {staff ? (
          <Select id="heardFrom" name="source" defaultValue="walk_in">
            <option value="walk_in">Walk-in</option>
            <option value="phone">Phone call</option>
            <option value="referral">Referral</option>
            <option value="event">Event</option>
            <option value="instagram">Instagram</option>
            <option value="google">Google</option>
            <option value="other">Other</option>
          </Select>
        ) : (
          <Input id="heardFrom" name="heardFrom" maxLength={120} />
        )}
      </Field>

      <fieldset className="space-y-2 rounded-lg border border-edge p-4">
        <legend className="px-1 text-sm font-medium text-ink-2">Communication consent</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="consentEmail" className="mt-0.5 size-4" />
          <span>{`${staff ? "Contact agreed to" : "I agree to"} receive emails about this inquiry, scheduling and programs. Unsubscribe anytime.`}</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="consentSms" className="mt-0.5 size-4" />
          <span>
            {`${staff ? "Contact agreed to" : "I agree to"} receive text messages at the mobile number above. Message & data rates may apply. Reply STOP to opt out.`}
          </span>
        </label>
        <p className="text-xs text-ink-3">Consent is optional and recorded with the date and source. We never text without it.</p>
      </fieldset>
    </div>
  );
}
