import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Stat, Table, Td, Th } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { DomainError } from "@/lib/messaging/errors";
import {
  filterOptions,
  filtersFromFields,
  getSegment,
  healthReason,
  MEMBERSHIP_STATUSES,
  parseFilters,
  previewSegment,
  type Segment,
  type SegmentFilters,
  type SegmentResult,
} from "@/lib/messaging/segments";
import { archiveSegmentAction, saveSegmentAction } from "../../actions";

export const metadata = { title: "Segment" };

/** Flat field values for a filter set (used for the GET builder form and the hidden save fields). */
function fields(f: SegmentFilters): Record<string, string> {
  return {
    audience: f.audience,
    recipientRole: f.recipientRole ?? "",
    groupId: f.groupId ?? "",
    sport: f.sport ?? "",
    membershipStatus: f.membershipStatus ?? "",
    productId: f.productId ?? "",
    athleteActive: f.athleteActive ?? "",
    attendanceMode: f.attendance?.mode ?? "",
    attendanceDays: f.attendance ? String(f.attendance.days) : "",
    missingForm: f.missingForm ?? "",
    leadStage: f.leadStage ?? "",
    tagId: f.tagId ?? "",
  };
}

export default async function SegmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const v = await requireCap("crm.manage");
  const { id } = await params;
  const sp = await searchParams;
  const isNew = id === "new";
  let segment: Segment | null = null;
  if (!isNew) {
    try {
      segment = await getSegment(db, v, id);
    } catch (e) {
      if (e instanceof DomainError) notFound();
      throw e;
    }
  }
  const opts = await filterOptions(db, v);

  // Working filters: what's in the URL (after "Update count"), else what's saved.
  let filters: SegmentFilters = segment?.filters ?? { audience: "athletes", athleteActive: "active" };
  let filterError: string | null = null;
  if (sp.preview) {
    try {
      filters = parseFilters(filtersFromFields((k) => sp[k] || undefined));
    } catch (e) {
      filterError = e instanceof Error ? e.message : "Check the filters.";
    }
  }
  let result: SegmentResult | null = null;
  let restricted: string | null = null;
  if (!filterError) {
    try {
      result = await previewSegment(db, v, filters);
    } catch (e) {
      if (e instanceof AuthzError) restricted = e.message;
      else if (e instanceof DomainError) filterError = e.message;
      else throw e;
    }
  }
  const health = await healthReason(db, v.orgId, filters);
  const f = fields(filters);
  const leads = filters.audience === "leads";

  return (
    <>
      <PageHeader kicker="Segment" title={isNew ? "New segment" : segment!.name} description="Adjust filters, update the count, then save exactly what you see." />
      <div className="grid gap-5 lg:grid-cols-[2fr_3fr]">
        <Card>
          <CardHeader title="Filters" />
          <CardBody>
            <form method="get" className="space-y-3">
              <input type="hidden" name="preview" value="1" />
              <Field label="Audience" htmlFor="audience">
                <Select id="audience" name="audience" defaultValue={f.audience}>
                  <option value="athletes">Athletes → their families (guardian routing)</option>
                  <option value="leads">Open leads → lead contact</option>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Sport" htmlFor="sport" hint={leads ? "Lead's interest" : undefined}>
                  <Input id="sport" name="sport" list="sports" defaultValue={f.sport} placeholder="Any" />
                  <datalist id="sports">
                    {opts.sports.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Tag" htmlFor="tagId">
                  <Select id="tagId" name="tagId" defaultValue={f.tagId}>
                    <option value="">Any</option>
                    {opts.tags.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <fieldset className="space-y-3 rounded-lg border border-edge p-3">
                <legend className="px-1 text-xs font-semibold text-ink-3">Athlete filters</legend>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Recipient role" htmlFor="recipientRole">
                    <Select id="recipientRole" name="recipientRole" defaultValue={f.recipientRole}>
                      <option value="">Everyone routed</option>
                      <option value="guardian">Guardians only</option>
                      <option value="athlete">Adult athletes only</option>
                    </Select>
                  </Field>
                  <Field label="Status" htmlFor="athleteActive">
                    <Select id="athleteActive" name="athleteActive" defaultValue={f.athleteActive}>
                      <option value="">Active or inactive</option>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </Select>
                  </Field>
                  <Field label="Group" htmlFor="groupId">
                    <Select id="groupId" name="groupId" defaultValue={f.groupId}>
                      <option value="">Any</option>
                      {opts.groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Membership status" htmlFor="membershipStatus">
                    <Select id="membershipStatus" name="membershipStatus" defaultValue={f.membershipStatus}>
                      <option value="">Any</option>
                      {MEMBERSHIP_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s === "none" ? "No current membership" : s.replace("_", " ")}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Membership product" htmlFor="productId">
                    <Select id="productId" name="productId" defaultValue={f.productId}>
                      <option value="">Any</option>
                      {opts.products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Missing form" htmlFor="missingForm" hint={opts.healthAccess ? undefined : "Medical forms need health-data access"}>
                    <Select id="missingForm" name="missingForm" defaultValue={f.missingForm}>
                      <option value="">—</option>
                      <option value="any">Any outstanding (non-medical) form</option>
                      {opts.forms.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                          {x.kind === "medical" ? " (medical)" : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Attendance" htmlFor="attendanceMode">
                    <Select id="attendanceMode" name="attendanceMode" defaultValue={f.attendanceMode}>
                      <option value="">Any</option>
                      <option value="attended">Attended in the last…</option>
                      <option value="not_attended">Not attended in the last…</option>
                    </Select>
                  </Field>
                  <Field label="Days" htmlFor="attendanceDays">
                    <Input id="attendanceDays" name="attendanceDays" type="number" min={1} max={365} defaultValue={f.attendanceDays} placeholder="30" />
                  </Field>
                </div>
              </fieldset>
              <Field label="Lead stage (leads audience)" htmlFor="leadStage">
                <Select id="leadStage" name="leadStage" defaultValue={f.leadStage}>
                  <option value="">Any open stage</option>
                  {opts.stages.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <button type="submit" className="h-10 rounded-lg border border-edge px-4 text-sm font-medium">
                Update count
              </button>
            </form>
          </CardBody>
        </Card>

        <div className="min-w-0 space-y-5">
          {filterError ? <Callout tone="bad">{filterError}</Callout> : null}
          {restricted ? <Callout tone="warn" title="Restricted">{restricted}</Callout> : null}
          {result ? (
            <Card>
              <CardHeader title="Who this reaches right now" kicker="Live" />
              <CardBody>
                <div className="mb-4 grid grid-cols-2 gap-3">
                  <Stat label={result.audience === "leads" ? "Leads matched" : "Athletes matched"} value={result.matched} />
                  <Stat label="Recipients (after routing)" value={result.recipients.length} />
                </div>
                {health ? <p className="mb-2 text-xs text-warn">This segment {health} — health data; only staff with health access can use it.</p> : null}
                <Table caption="Recipients">
                  <thead>
                    <tr>
                      <Th>Recipient</Th>
                      <Th>Role</Th>
                      <Th>About</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.recipients.slice(0, 100).map((r) => (
                      <tr key={r.recipient.personId}>
                        <Td>
                          {r.recipient.firstName} {r.recipient.lastName}
                        </Td>
                        <Td>{r.recipient.role.replace("_", " ")}</Td>
                        <Td className="text-xs">{r.athleteNames.join(", ") || (r.leadFirstName ? `Lead: ${r.leadFirstName}` : "")}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {result.recipients.length > 100 ? <p className="mt-2 text-xs text-ink-3">Showing 100 of {result.recipients.length}.</p> : null}
                {result.excluded.length ? (
                  <details className="mt-3 text-xs text-ink-3">
                    <summary>{result.excluded.length} not messaged (guardian routing)</summary>
                    <ul className="mt-1 list-disc pl-5">
                      {result.excluded.slice(0, 100).map((e, i) => (
                        <li key={i}>
                          {e.name} ({e.about}): {e.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {!restricted && !filterError ? (
            <Card>
              <CardHeader title={isNew ? "Save segment" : "Save changes"} />
              <CardBody>
                <ActionForm action={saveSegmentAction} className="space-y-3">
                  {segment ? <input type="hidden" name="segmentId" value={segment.id} /> : null}
                  {Object.entries(f).map(([k, val]) => (val ? <input key={k} type="hidden" name={k} value={val} /> : null))}
                  <Field label="Name" htmlFor="name" required>
                    <Input id="name" name="name" required maxLength={120} defaultValue={segment?.name} />
                  </Field>
                  <Field label="Description" htmlFor="description">
                    <Input id="description" name="description" maxLength={500} defaultValue={segment?.description ?? ""} />
                  </Field>
                  <div className="flex flex-wrap gap-3">
                    <SubmitButton>{isNew ? "Save segment" : "Save these filters"}</SubmitButton>
                    <Link href="/messages/segments" className="self-center text-sm text-ink-3 underline">
                      Back
                    </Link>
                  </div>
                </ActionForm>
                {segment ? (
                  <ActionForm action={archiveSegmentAction} className="mt-6 border-t border-edge pt-4">
                    <input type="hidden" name="segmentId" value={segment.id} />
                    <SubmitButton variant="ghost" confirm="Archive this segment?">
                      Archive segment
                    </SubmitButton>
                  </ActionForm>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
