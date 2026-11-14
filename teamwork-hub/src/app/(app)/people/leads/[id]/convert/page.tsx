import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { StableForm, StableSubmit } from "@/app/(app)/messages/_components/stable-form";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { conversionPreview, type Candidate } from "@/lib/crm/convert";
import { DomainError } from "@/lib/messaging/errors";
import { fmtDate } from "@/lib/time";
import { convertLeadAction } from "../../actions";

export const metadata = { title: "Convert lead" };

export default async function ConvertLeadPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireCap("crm.manage");
  const { id } = await params;
  let pv: Awaited<ReturnType<typeof conversionPreview>>;
  try {
    pv = await conversionPreview(db, v, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  if (pv.lead.convertedAt) redirect(`/people/leads/${id}`);
  const { athletePerson: ap, contactPerson: cp } = pv;
  const allowed = can(v, "people.manage");
  const linkedHouseholds = [...new Map([...pv.guardianCandidates, ...(cp ? [] : pv.athleteCandidates)].flatMap((c) => c.households.map((h) => [h.id, { ...h, owner: c.name }]))).values()];
  const linkedPayers = [...new Map([...pv.guardianCandidates, ...(cp ? [] : pv.athleteCandidates)].flatMap((c) => c.payerAccounts.map((p) => [p.id, { ...p, owner: c.name }]))).values()];

  return (
    <>
      <PageHeader
        kicker="Lead conversion"
        title={`Convert ${ap.firstName} ${ap.lastName} to an athlete`}
        description="Review exactly what will be created. Possible duplicates must be resolved explicitly — records are never merged."
      />
      {!allowed ? (
        <Callout tone="warn" title="Requires people management">
          Converting creates athlete, guardian and payer records, which needs the people.manage permission (owner, admin or operations).
        </Callout>
      ) : null}
      <StableForm action={convertLeadAction} className="space-y-5">
        <input type="hidden" name="leadId" value={pv.lead.id} />

        <Card>
          <CardHeader title="Athlete" kicker={pv.isMinor ? "Minor" : "Adult"} />
          <CardBody className="space-y-3">
            <p className="text-sm">
              From the inquiry: <strong>{ap.firstName} {ap.lastName}</strong>
              {pv.age != null ? ` · ${pv.age} yrs` : ""}
              {pv.lead.interest ? ` · ${pv.lead.interest}` : ""}
              {ap.email ? ` · ${ap.email}` : ""}
            </p>
            <ChoiceGroup name="athleteChoice" label="athlete" candidates={pv.athleteCandidates} newLabel={`Create a new athlete record for ${ap.firstName} ${ap.lastName}`} />
            <div className="grid gap-3 sm:grid-cols-2">
              {!ap.dateOfBirth ? (
                <Field label="Date of birth (optional)" htmlFor="dob" hint="Used for age-based messaging rules">
                  <Input id="dob" name="dateOfBirth" type="date" />
                </Field>
              ) : (
                <p className="text-sm text-ink-3">Date of birth on file: {fmtDate(ap.dateOfBirth)}</p>
              )}
              <Field label="Primary sport" htmlFor="sport">
                <Input id="sport" name="sport" defaultValue={pv.lead.interest ?? ""} maxLength={80} />
              </Field>
            </div>
          </CardBody>
        </Card>

        {cp ? (
          <Card>
            <CardHeader title="Parent / guardian" />
            <CardBody className="space-y-3">
              <p className="text-sm">
                From the inquiry: <strong>{cp.firstName} {cp.lastName}</strong>
                {cp.email ? ` · ${cp.email}` : ""}
                {cp.phone ? ` · ${cp.phone}` : ""}
              </p>
              <ChoiceGroup name="guardianChoice" label="guardian" candidates={pv.guardianCandidates} newLabel={`Create a new person for ${cp.firstName} ${cp.lastName}`} />
              <Field label="Relationship" htmlFor="relationship">
                <Input id="relationship" name="relationship" defaultValue="parent" maxLength={40} />
              </Field>
              <p className="text-xs text-ink-3">The guardian link is created active with default permissions (training view, booking, forms, messaging; health view off). Adjust them on the athlete profile.</p>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Household & payer" />
          <CardBody className="grid gap-5 sm:grid-cols-2">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink-2">Household</legend>
              <Radio name="household" value="new" defaultChecked label={`New household (“${(cp ?? ap).lastName} Household”)`} />
              {!cp ? <Radio name="household" value="none" label="No household (adult)" /> : null}
              {linkedHouseholds.map((h) => (
                <Radio key={h.id} name="household" value={h.id} label={`${h.name}`} hint={`Only valid when linking ${h.owner}`} />
              ))}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink-2">Payer account</legend>
              <Radio name="payer" value="new" defaultChecked label={`New payer account for ${(cp ?? ap).firstName} ${(cp ?? ap).lastName} (can view, pay, manage methods)`} />
              {linkedPayers.map((p) => (
                <Radio key={p.id} name="payer" value={p.id} label={`Add to existing: ${p.name}`} hint={`Only valid when linking ${p.owner}`} />
              ))}
            </fieldset>
          </CardBody>
        </Card>

        <Callout tone="info" title="On convert">
          The lead moves to Won, <code>converted_at</code> is recorded, the follow-up task is closed, and a <code>crm.lead_converted</code> job queues the onboarding task. Every decision is written to the audit log.
        </Callout>
        <div className="flex flex-wrap items-center gap-3">
          <StableSubmit pendingText="Converting…" size="lg">
            Convert to athlete
          </StableSubmit>
          <Link href={`/people/leads/${pv.lead.id}`} className="text-sm text-ink-3 underline">
            Cancel
          </Link>
        </div>
      </StableForm>
    </>
  );
}

function Radio({ name, value, label, hint, defaultChecked, required }: { name: string; value: string; label: React.ReactNode; hint?: string; defaultChecked?: boolean; required?: boolean }) {
  return (
    <label className="flex items-start gap-2 rounded-lg border border-edge p-3 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand/5">
      <input type="radio" name={name} value={value} defaultChecked={defaultChecked} required={required} className="mt-0.5 size-4" />
      <span>
        {label}
        {hint ? <span className="block text-xs text-ink-3">{hint}</span> : null}
      </span>
    </label>
  );
}

function ChoiceGroup({ name, label, candidates, newLabel }: { name: string; label: string; candidates: Candidate[]; newLabel: string }) {
  if (!candidates.length) {
    return (
      <>
        <input type="hidden" name={name} value="new" />
        <p className="text-sm text-ink-3">No existing people match — a new record will be created.</p>
      </>
    );
  }
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1">
        <Badge variant="yellow">Possible duplicate</Badge> <span className="text-sm font-medium">Choose how to handle the {label} — required</span>
      </legend>
      {candidates.map((c) => (
        <Radio
          key={c.personId}
          name={name}
          value={`link:${c.personId}`}
          required
          label={
            <>
              Link existing person: <strong>{c.name}</strong> <span className="text-xs text-ink-3">(matched on {c.matchedOn.join(", ")})</span>
            </>
          }
          hint={[
            c.email,
            c.phone,
            c.dateOfBirth ? `born ${fmtDate(c.dateOfBirth)}` : null,
            c.athleteId ? "already an athlete" : null,
            c.guardianOf.length ? `guardian of ${c.guardianOf.join(", ")}` : null,
            c.households.length ? `household: ${c.households.map((h) => h.name).join(", ")}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ))}
      <Radio name={name} value="new" required label={newLabel} hint="Keeps both records separate (e.g. a different person sharing a family email)." />
    </fieldset>
  );
}
