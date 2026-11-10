import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, Field, Input } from "@/components/ui";
import { DEFAULT_RETENTION_SETTINGS, RETENTION_FIELDS, retentionSettingsFrom } from "@/lib/retention/common";
import { saveRetentionSettingsAction } from "@/app/(app)/people/retention/actions";

/** Settings → Retention radar thresholds (owner/admin; the page enforces `settings.manage`). */
export function RetentionSettingsPanel({ settings }: { settings: Record<string, unknown> | null }) {
  const s = retentionSettingsFrom(settings);
  const groups = [...new Set(RETENTION_FIELDS.map((f) => f.group))];
  return (
    <Card className="mt-6" id="retention">
      <CardHeader title="Retention radar thresholds" kicker="Owner / admin" action={<Badge variant="yellow">Defaults are starting points, not norms</Badge>} />
      <CardBody className="space-y-4">
        <p className="text-sm text-ink-3">
          These numbers decide when a member is flagged on People → Retention and when session feedback creates a follow-up task. Each default is only a starting point to tune against what you see at Teamwork; none is an
          industry norm or a policy. The “days since last visit” threshold is “Attendance gap reported after (days)” in the membership policy above. Changes are audited.
        </p>
        <ActionForm action={saveRetentionSettingsAction} className="space-y-5">
          {groups.map((g) => (
            <fieldset key={g}>
              <legend className="mb-2 text-sm font-semibold">{g}</legend>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0">
                {RETENTION_FIELDS.filter((f) => f.group === g).map((f) => (
                  <Field key={f.key} label={f.label} htmlFor={`rt-${f.key}`} hint={`${f.hint ? `${f.hint} ` : ""}Starting point: ${DEFAULT_RETENTION_SETTINGS[f.key]}.`}>
                    <Input id={`rt-${f.key}`} name={f.key} type="number" min={f.min} max={f.max} defaultValue={String(s[f.key])} required />
                  </Field>
                ))}
              </div>
            </fieldset>
          ))}
          <SubmitButton>Save retention thresholds</SubmitButton>
        </ActionForm>
      </CardBody>
    </Card>
  );
}
