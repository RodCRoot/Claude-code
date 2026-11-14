import Link from "next/link";
import { cfName, formatCustomValue, type CustomFieldDef, type CustomValue } from "@/lib/people/custom-fields";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, Field, Input, Select } from "@/components/ui";
import { updateCustomFieldsAction } from "../actions";

type Item = { def: CustomFieldDef; value: CustomValue | null };

function Control({ def, value }: Item) {
  const id = `cfv-${def.key}`;
  const name = cfName(def.key);
  const common = { id, name, required: def.required, "aria-required": def.required || undefined };
  switch (def.fieldType) {
    case "number":
      return <Input {...common} type="number" step="any" inputMode="decimal" defaultValue={value == null ? "" : String(value)} />;
    case "date":
      return <Input {...common} type="date" defaultValue={value == null ? "" : String(value)} />;
    case "select":
      return (
        <Select {...common} defaultValue={value == null ? "" : String(value)}>
          <option value="">—</option>
          {/* Keep a saved value visible even if the option was later removed. */}
          {value != null && !(def.options ?? []).includes(String(value)) ? <option value={String(value)}>{String(value)} (retired option)</option> : null}
          {(def.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    case "boolean":
      return (
        <Select {...common} defaultValue={value === true ? "true" : value === false ? "false" : ""}>
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      );
    default:
      return <Input {...common} maxLength={500} defaultValue={value == null ? "" : String(value)} />;
  }
}

export function CustomFieldsCard({ personId, items, editable, settingsLink }: { personId: string; items: Item[]; editable: boolean; settingsLink: boolean }) {
  if (!items.length) return null;
  return (
    <Card>
      <CardHeader
        title="Additional details"
        kicker="Custom fields"
        action={
          settingsLink ? (
            <Link href="/settings/custom-fields" className="text-xs text-ink-2 underline">
              Manage fields
            </Link>
          ) : null
        }
      />
      <CardBody>
        {editable ? (
          <ActionForm action={updateCustomFieldsAction} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="personId" value={personId} />
            {items.map((it) => (
              <Field key={it.def.id} label={it.def.label} htmlFor={`cfv-${it.def.key}`} required={it.def.required} hint={it.def.visibility === "family" ? "Visible to family" : undefined}>
                <Control {...it} />
              </Field>
            ))}
            <div className="sm:col-span-2">
              <SubmitButton size="sm">Save details</SubmitButton>
            </div>
          </ActionForm>
        ) : (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {items.map(({ def, value }) => (
              <div key={def.id}>
                <dt className="text-ink-3">
                  {def.label} {def.visibility === "family" ? null : <Badge>staff only</Badge>}
                </dt>
                <dd>{formatCustomValue(def, value) ?? "—"}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardBody>
    </Card>
  );
}
