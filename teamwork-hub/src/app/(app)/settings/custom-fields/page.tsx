import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { listFieldDefs, type CustomFieldDef } from "@/lib/people/custom-fields";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { archiveCustomFieldAction, createCustomFieldAction, updateCustomFieldAction } from "../actions";

export const metadata = { title: "Custom fields" };

const TYPE_LABEL: Record<CustomFieldDef["fieldType"], string> = { text: "Text", number: "Number", date: "Date", select: "Choice list", boolean: "Yes / no" };
const APPLIES_LABEL: Record<CustomFieldDef["appliesTo"], string> = { person: "Everyone", athlete: "Athletes", lead: "Leads" };

function Flags({ d, idp, span = false }: { d?: CustomFieldDef; idp: string; span?: boolean }) {
  return (
    <fieldset className={span ? "space-y-1 sm:col-span-2" : "space-y-1"}>
      <legend className="sr-only">Options</legend>
      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input type="checkbox" name="required" defaultChecked={d?.required ?? false} id={`${idp}-req`} /> Required when staff save the person
      </label>
      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input type="checkbox" name="showInList" defaultChecked={d?.showInList ?? false} id={`${idp}-list`} /> Show as a column (and filter, for choice / yes-no fields) in the People list
      </label>
    </fieldset>
  );
}

export default async function CustomFieldsPage() {
  const v = await requireCap("settings.manage");
  const defs = await listFieldDefs(db, v.orgId, { includeArchived: true });
  return (
    <>
      <PageHeader
        kicker="Settings"
        title="Custom fields"
        description="Extra fields staff fill in on a person's page. Staff-only fields are never shown to families; family-visible fields are shown read-only to the athlete and their guardians. Every change is audited."
      />
      <SettingsTabs current="custom-fields" />
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {defs.length === 0 ? (
            <Card>
              <CardBody className="pt-5">
                <EmptyState title="No custom fields yet">Add one on the right — for example &ldquo;T-shirt size&rdquo; (choice list) or &ldquo;Medical clearance date&rdquo; (date).</EmptyState>
              </CardBody>
            </Card>
          ) : null}
          {defs.map((d) => (
            <Card key={d.id} className={d.archivedAt ? "opacity-80" : undefined}>
              <CardHeader
                title={d.label}
                kicker={`${TYPE_LABEL[d.fieldType]} · ${APPLIES_LABEL[d.appliesTo]} · key ${d.key}`}
                action={
                  <div className="flex flex-wrap gap-1">
                    {d.archivedAt ? <Badge>archived</Badge> : null}
                    <Badge variant={d.visibility === "family" ? "blue" : "neutral"}>{d.visibility === "family" ? "family-visible" : "staff only"}</Badge>
                    {d.required ? <Badge variant="yellow">required</Badge> : null}
                  </div>
                }
              />
              <CardBody>
                <ActionForm action={updateCustomFieldAction} className="grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="id" value={d.id} />
                  <Field label="Label" htmlFor={`cf-${d.id}-label`}>
                    <Input id={`cf-${d.id}-label`} name="label" defaultValue={d.label} required maxLength={80} />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Visible to" htmlFor={`cf-${d.id}-vis`}>
                      <Select id={`cf-${d.id}-vis`} name="visibility" defaultValue={d.visibility}>
                        <option value="staff">Staff only</option>
                        <option value="family">Staff & family</option>
                      </Select>
                    </Field>
                    <Field label="Order" htmlFor={`cf-${d.id}-order`}>
                      <Input id={`cf-${d.id}-order`} name="sortOrder" type="number" min={0} max={999} defaultValue={d.sortOrder} />
                    </Field>
                  </div>
                  {d.fieldType === "select" ? (
                    <Field label="Options (one per line)" htmlFor={`cf-${d.id}-opts`} className="sm:col-span-2" hint="Removing an option does not change values already saved.">
                      <Textarea id={`cf-${d.id}-opts`} name="options" defaultValue={(d.options ?? []).join("\n")} rows={3} />
                    </Field>
                  ) : null}
                  <Flags d={d} idp={`cf-${d.id}`} span />
                  <div className="sm:col-span-2">
                    <SubmitButton size="sm">Save field</SubmitButton>
                  </div>
                </ActionForm>
                <form action={archiveCustomFieldAction} className="mt-3 border-t border-edge pt-3">
                  <input type="hidden" name="id" value={d.id} />
                  <input type="hidden" name="archive" value={d.archivedAt ? "false" : "true"} />
                  <button type="submit" className="min-h-9 text-xs font-medium text-ink-2 underline">
                    {d.archivedAt ? `Restore ${d.label}` : `Archive ${d.label}`}
                  </button>
                  <span className="ml-2 text-xs text-ink-3">{d.archivedAt ? "Restoring shows saved values again." : "Archiving hides the field; saved values are kept."}</span>
                </form>
              </CardBody>
            </Card>
          ))}
        </div>
        <Card className="self-start">
          <CardHeader title="New field" />
          <CardBody>
            <ActionForm action={createCustomFieldAction} className="grid gap-3" resetOnSuccess>
              <Field label="Label" htmlFor="new-label">
                <Input id="new-label" name="label" required maxLength={80} />
              </Field>
              <Field label="Key (optional)" htmlFor="new-key" hint="Used in exports. Lowercase letters, digits, underscores. Generated from the label if blank; can't be changed later.">
                <Input id="new-key" name="key" pattern="[a-z][a-z0-9_]{0,39}" aria-describedby="new-key-hint" />
              </Field>
              <Field label="Type" htmlFor="new-type" hint="Can't be changed later.">
                <Select id="new-type" name="fieldType" defaultValue="text" aria-describedby="new-type-hint">
                  {Object.entries(TYPE_LABEL).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Options for a choice list (one per line)" htmlFor="new-opts">
                <Textarea id="new-opts" name="options" rows={3} />
              </Field>
              <Field label="Applies to" htmlFor="new-applies">
                <Select id="new-applies" name="appliesTo" defaultValue="athlete">
                  {Object.entries(APPLIES_LABEL).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Visible to" htmlFor="new-vis">
                <Select id="new-vis" name="visibility" defaultValue="staff">
                  <option value="staff">Staff only</option>
                  <option value="family">Staff & family (read-only for families)</option>
                </Select>
              </Field>
              <input type="hidden" name="sortOrder" value={defs.length * 10} />
              <Flags idp="new" />
              <SubmitButton size="sm">Create field</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
