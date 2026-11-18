import { db } from "@/db";
import { JOURNEY_KINDS, OPS_SECTIONS, type JourneyKind } from "@/db/schema";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SettingsTabs } from "@/components/settings-tabs";
import { Badge, Callout, Card, CardBody, CardHeader, Input, PageHeader, Select } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { listLocations } from "@/lib/locations";
import { OPS_SECTION_LABEL, opsItemsForSettings } from "@/lib/journey/ops";
import { journeyContext } from "@/lib/journey/sync";
import {
  ANCHORS,
  AUTO_RULES,
  AUTO_RULE_KEYS,
  JOURNEY_KIND_HELP,
  JOURNEY_KIND_LABEL,
  NUMBER_FIELDS,
  OFFSET_UNITS,
  OWNER_ROLES,
  OWNER_ROLE_LABEL,
  TARGET_FIELDS,
  DEFAULT_JOURNEY_NUMBERS,
  DEFAULT_TARGETS,
  isDefaultStep,
  type TemplateStep,
} from "@/lib/journey/templates";
import { addOpsItemAction, addSampleOpsItemsAction, saveJourneyNumbersAction, saveJourneyTemplateAction, updateOpsItemAction } from "@/app/(app)/follow-ups/actions";

export const metadata = { title: "Member journey" };

const lbl = "mb-1 block text-xs font-semibold text-ink-2";

function StepFields({ kind, i, step }: { kind: JourneyKind; i: number; step: TemplateStep | null }) {
  const id = (f: string) => `${kind}-${f}-${i}`;
  const isNew = !step;
  const isDefault = step ? isDefaultStep(kind, step) : false;
  return (
    <fieldset className="rounded-md border border-edge p-3">
      <legend className="flex items-center gap-2 px-1 text-xs font-semibold text-ink-2">
        {isNew ? "Add a step" : `Step ${i + 1}`}
        {isNew ? null : isDefault ? <Badge>Default</Badge> : <Badge variant="blue">Edited</Badge>}
      </legend>
      {step ? <input type="hidden" name={`key.${i}`} value={step.key} /> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="sm:col-span-2 lg:col-span-2">
          <label htmlFor={id("name")} className={lbl}>
            Step name
          </label>
          <Input id={id("name")} name={`name.${i}`} defaultValue={step?.name ?? ""} maxLength={120} required={!isNew} />
        </div>
        {kind === "visit_milestones" ? (
          <div>
            <label htmlFor={id("visits")} className={lbl}>
              Visits
            </label>
            <Input id={id("visits")} name={`visits.${i}`} type="number" min={1} defaultValue={step?.visits ?? ""} readOnly={!isNew} />
          </div>
        ) : null}
        <div>
          <label htmlFor={id("owner")} className={lbl}>
            Owner
          </label>
          <Select id={id("owner")} name={`ownerRole.${i}`} defaultValue={step?.ownerRole ?? "operations"}>
            {OWNER_ROLES.map((r) => (
              <option key={r} value={r}>
                {OWNER_ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor={id("offset")} className={lbl}>
            Due after
          </label>
          <Input id={id("offset")} name={`offset.${i}`} type="number" step={1} defaultValue={step?.offset ?? 0} />
        </div>
        <div>
          <label htmlFor={id("unit")} className={lbl}>
            Unit
          </label>
          <Select id={id("unit")} name={`unit.${i}`} defaultValue={step?.unit ?? "days"}>
            {OFFSET_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </div>
        {kind === "hold" ? (
          <div>
            <label htmlFor={id("anchor")} className={lbl}>
              Counted from
            </label>
            <Select id={id("anchor")} name={`anchor.${i}`} defaultValue={step?.anchor ?? "start"}>
              {ANCHORS.map((a) => (
                <option key={a} value={a}>
                  Hold {a}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="sm:col-span-2 lg:col-span-3">
          <label htmlFor={id("rule")} className={lbl}>
            Auto-complete when
          </label>
          <Select id={id("rule")} name={`autoRule.${i}`} defaultValue={step?.autoRule ?? ""}>
            <option value="">Only when staff tick it</option>
            {AUTO_RULE_KEYS.map((r) => (
              <option key={r} value={r}>
                {AUTO_RULES[r].label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 sm:col-span-2 lg:col-span-3">
          <label className="inline-flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" name={`enabled.${i}`} defaultChecked={step ? step.enabled : true} className="size-4" />
            In use
          </label>
          <label className="inline-flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" name={`billing.${i}`} defaultChecked={step?.billing ?? false} className="size-4" />
            Billing step (hidden from coaches)
          </label>
        </div>
      </div>
    </fieldset>
  );
}

export default async function JourneySettingsPage() {
  const v = await requireCap("settings.manage");
  const { settings } = await journeyContext(db, v.orgId);
  const [items, locations] = await Promise.all([opsItemsForSettings(db, v), listLocations(db, v.orgId, { activeOnly: true })]);
  const numbers = settings as unknown as Record<string, number>;

  return (
    <>
      <PageHeader
        kicker="Settings"
        title="Member journey"
        description="The checklists the Hub starts on its own: onboarding, touchpoints, visit milestones, review and referral asks, holds and offboarding. Every step, owner and offset below can be changed. Nothing here sends a message; a step is finished by staff logging it or by something the system can see."
      />
      <SettingsTabs current="journey" />
      <Callout className="mb-4" title="About the defaults">
        Steps marked Default are starting points so the checklists are useful on day one. They are not a Teamwork policy. Changes apply to journeys that start afterwards; journeys already under way keep the steps they began with.
      </Callout>

      <div className="space-y-4">
        {JOURNEY_KINDS.map((kind) => {
          const steps = settings.templates[kind];
          return (
            <Card key={kind} id={`template-${kind}`}>
              <CardHeader title={JOURNEY_KIND_LABEL[kind]} kicker={`${steps.filter((s) => s.enabled).length} of ${steps.length} steps in use`} />
              <CardBody>
                <p className="mb-3 text-sm text-ink-3">{JOURNEY_KIND_HELP[kind]}</p>
                <ActionForm action={saveJourneyTemplateAction} className="space-y-3">
                  <input type="hidden" name="kind" value={kind} />
                  <input type="hidden" name="rows" value={steps.length + 1} />
                  {steps.map((s, i) => (
                    <StepFields key={s.key} kind={kind} i={i} step={s} />
                  ))}
                  <StepFields kind={kind} i={steps.length} step={null} />
                  <div className="flex flex-wrap gap-2">
                    <SubmitButton name="intent" value="save">
                      Save {JOURNEY_KIND_LABEL[kind].toLowerCase()}
                    </SubmitButton>
                    <SubmitButton name="intent" value="reset" variant="secondary" confirm="Put this checklist back to the defaults?">
                      Reset to defaults<span className="sr-only">: {JOURNEY_KIND_LABEL[kind]}</span>
                    </SubmitButton>
                  </div>
                </ActionForm>
              </CardBody>
            </Card>
          );
        })}

        <Card id="numbers">
          <CardHeader title="Timing and scorecard targets" />
          <CardBody>
            <ActionForm action={saveJourneyNumbersAction} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {NUMBER_FIELDS.map((f) => (
                  <div key={f.key}>
                    <label htmlFor={`n-${f.key}`} className={lbl}>
                      {f.label}
                    </label>
                    <Input id={`n-${f.key}`} name={f.key} type="number" min={f.min} max={f.max} defaultValue={numbers[f.key]} required />
                    <p className="mt-1 text-xs text-ink-3">
                      {f.hint ? `${f.hint} ` : ""}Default {DEFAULT_JOURNEY_NUMBERS[f.key]}.
                    </p>
                  </div>
                ))}
              </div>
              <h3 className="text-sm font-bold">Coach weekly scorecard targets</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {TARGET_FIELDS.map((f) => (
                  <div key={f.key}>
                    <label htmlFor={`t-${f.key}`} className={lbl}>
                      {f.label}
                    </label>
                    <Input id={`t-${f.key}`} name={f.key} type="number" min={f.min} max={f.max} defaultValue={settings.targets[f.key]} required />
                    <p className="mt-1 text-xs text-ink-3">Default {DEFAULT_TARGETS[f.key]} (a starting point, not a standard).</p>
                  </div>
                ))}
              </div>
              <SubmitButton>Save timing and targets</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>

        <Card id="ops-checklist">
          <CardHeader title="Operations checklist" kicker={`${items.filter((r) => r.i.active).length} items in use`} />
          <CardBody>
            <p className="mb-3 text-sm text-ink-3">Opening, closing, cleaning and weekly tasks per location. Staff tick them on the Operations checklist page.</p>
            {items.length === 0 ? (
              <ActionForm action={addSampleOpsItemsAction} className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-edge bg-surface-2/50 p-3">
                <div>
                  <label htmlFor="sample-loc" className={lbl}>
                    Start from a sample list for
                  </label>
                  <Select id="sample-loc" name="locationId" defaultValue="">
                    <option value="">Every location</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <SubmitButton variant="secondary">Add the sample list</SubmitButton>
                <p className="basis-full text-xs text-ink-3">The sample wording is invented. Edit it to match how you run the floor.</p>
              </ActionForm>
            ) : null}
            <ul className="space-y-2">
              {items.map(({ i }) => (
                <li key={i.id}>
                  <ActionForm action={updateOpsItemAction} className="grid gap-2 rounded-md border border-edge p-3 sm:grid-cols-2 lg:grid-cols-6">
                    <input type="hidden" name="id" value={i.id} />
                    <div className="sm:col-span-2 lg:col-span-2">
                      <label htmlFor={`oi-label-${i.id}`} className={lbl}>
                        Task
                      </label>
                      <Input id={`oi-label-${i.id}`} name="label" defaultValue={i.label} required maxLength={160} />
                    </div>
                    <div>
                      <label htmlFor={`oi-sec-${i.id}`} className={lbl}>
                        Section
                      </label>
                      <Select id={`oi-sec-${i.id}`} name="section" defaultValue={i.section}>
                        {OPS_SECTIONS.map((sec) => (
                          <option key={sec} value={sec}>
                            {OPS_SECTION_LABEL[sec]}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <label htmlFor={`oi-loc-${i.id}`} className={lbl}>
                        Location
                      </label>
                      <Select id={`oi-loc-${i.id}`} name="locationId" defaultValue={i.locationId ?? ""}>
                        <option value="">Every location</option>
                        {locations.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <label htmlFor={`oi-sort-${i.id}`} className={lbl}>
                        Order
                      </label>
                      <Input id={`oi-sort-${i.id}`} name="sortOrder" type="number" min={0} max={999} defaultValue={i.sortOrder} />
                    </div>
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="inline-flex min-h-10 items-center gap-2 text-sm">
                        <input type="checkbox" name="active" defaultChecked={i.active} className="size-4" />
                        In use
                      </label>
                      <SubmitButton size="sm" variant="secondary">
                        Save<span className="sr-only">: {i.label}</span>
                      </SubmitButton>
                    </div>
                  </ActionForm>
                </li>
              ))}
            </ul>
            <ActionForm action={addOpsItemAction} resetOnSuccess className="mt-4 grid gap-2 rounded-md border border-edge bg-surface-2/50 p-3 sm:grid-cols-2 lg:grid-cols-6">
              <div className="sm:col-span-2 lg:col-span-3">
                <label htmlFor="oi-new-label" className={lbl}>
                  New task
                </label>
                <Input id="oi-new-label" name="label" required maxLength={160} />
              </div>
              <div>
                <label htmlFor="oi-new-sec" className={lbl}>
                  Section
                </label>
                <Select id="oi-new-sec" name="section" defaultValue="opening">
                  {OPS_SECTIONS.map((sec) => (
                    <option key={sec} value={sec}>
                      {OPS_SECTION_LABEL[sec]}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label htmlFor="oi-new-loc" className={lbl}>
                  Location
                </label>
                <Select id="oi-new-loc" name="locationId" defaultValue="">
                  <option value="">Every location</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex items-end">
                <SubmitButton size="sm">Add task</SubmitButton>
              </div>
            </ActionForm>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
