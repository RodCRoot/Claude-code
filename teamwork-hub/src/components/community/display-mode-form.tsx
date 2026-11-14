import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input } from "@/components/ui";
import { DISPLAY_NAME_MODES } from "@/db/schema";
import type { DisplayModeAccess } from "@/lib/community/display-name";
import { DISPLAY_MODE_HINT, DISPLAY_MODE_LABEL } from "@/lib/community/shared";
import { setDisplayModeAction } from "@/app/(app)/leaderboards/actions";

/**
 * How one athlete is named on the gym TV, leaderboards and shoutouts. The form is only rendered
 * for someone who may change it (a guardian for a minor, an adult athlete, or staff on the
 * family's request with a note); the server action checks again.
 */
export function DisplayModeForm({ access, isSelf }: { access: DisplayModeAccess; isSelf: boolean }) {
  const who = isSelf ? "you" : access.firstName;
  const id = `dm-${access.athleteId}`;
  return (
    <div>
      <p className="text-sm">
        Other families see {who} as: <span className="font-bold">{access.preview ?? "not shown at all"}</span>
        {access.chosen === null ? <span className="text-ink-3"> (gym default)</span> : null}
      </p>
      {access.canChange ? (
        <ActionForm action={setDisplayModeAction} className="mt-3 space-y-3">
          <input type="hidden" name="athleteId" value={access.athleteId} />
          <fieldset>
            <legend className="text-sm font-medium text-ink-2">Name on the gym TV and leaderboards</legend>
            <div className="mt-1.5 space-y-1.5">
              {DISPLAY_NAME_MODES.map((m) => (
                <label key={m} className="flex min-h-11 items-start gap-2 rounded-md border border-edge px-3 py-2 text-sm has-checked:border-brand has-checked:bg-brand/5">
                  <input type="radio" name="mode" value={m} defaultChecked={access.effective === m} className="mt-1" required />
                  <span>
                    <span className="font-semibold">{DISPLAY_MODE_LABEL[m]}</span>
                    <span className="block text-xs text-ink-3">{DISPLAY_MODE_HINT[m]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {access.staffOnRequest ? (
            <Field label="Who in the family asked for this?" htmlFor={`${id}-by`} hint="Staff change this only on the family's request. The note is kept in the audit log." required>
              <Input id={`${id}-by`} name="requestedBy" maxLength={200} required />
            </Field>
          ) : null}
          <SubmitButton variant="secondary">Save name setting</SubmitButton>
        </ActionForm>
      ) : access.blockedReason ? (
        <p className="mt-2 text-xs text-ink-3">{access.blockedReason}</p>
      ) : null}
    </div>
  );
}
