import Link from "next/link";
import { FamilyStyleHint } from "@/app/(app)/messages/_components/family-style-hint";
import { db } from "@/db";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { athleteCapabilities, can } from "@/lib/authz/policy";
import { listTemplates, renderTemplate } from "@/lib/automation/templates";
import { messagingSettings, routeForAthlete } from "@/lib/messaging/routing";
import { messageableAthletes } from "@/lib/messaging/threads";
import { startFamilyThreadAction, startStaffThreadAction } from "../actions";
import { StableForm, StableSubmit } from "../_components/stable-form";
import { ChannelStatus } from "../_components/shared";

export const metadata = { title: "New message" };

export default async function NewMessagePage({ searchParams }: { searchParams: Promise<{ athlete?: string; template?: string }> }) {
  const v = await requireViewer();
  const sp = await searchParams;
  const athletes = await messageableAthletes(db, v);

  if (!can(v, "messages.inbox")) {
    return (
      <>
        <PageHeader title="Message the team" description="Start a conversation with Teamwork staff about one of your athletes." />
        {athletes.length === 0 ? (
          <EmptyState title="Messaging isn't available on your account">
            {v.role === "athlete" ? "Messages about minors go through a parent or guardian." : "You don't have messaging permission for any athlete. Contact the front desk."}
          </EmptyState>
        ) : (
          <Card className="max-w-2xl">
            <CardBody className="pt-5">
              <StableForm withMutationId action={startFamilyThreadAction} className="space-y-4">
                <Field label="About" htmlFor="athleteId">
                  <Select id="athleteId" name="athleteId" defaultValue={sp.athlete ?? athletes[0].id} required>
                    {athletes.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Subject" htmlFor="subject">
                  <Input id="subject" name="subject" required maxLength={200} />
                </Field>
                <Field label="Message" htmlFor="body">
                  <Textarea id="body" name="body" required maxLength={5000} rows={6} />
                </Field>
                <div className="flex items-center gap-3">
                  <StableSubmit pendingText="Sending…">Send</StableSubmit>
                  <Link href="/messages" className="text-sm text-ink-3 underline">
                    Cancel
                  </Link>
                </div>
              </StableForm>
            </CardBody>
          </Card>
        )}
      </>
    );
  }

  const selected = athletes.find((a) => a.id === sp.athlete) ?? null;
  const settings = await messagingSettings(db, v.orgId);
  const route = selected && (await athleteCapabilities(db, v, selected.id)).has("messages.send") ? await routeForAthlete(db, v.orgId, selected.id, settings) : null;
  const templates = can(v, "crm.manage") ? await listTemplates(db, v.orgId) : [];
  const tpl = templates.find((t) => t.id === sp.template);
  const one = route?.recipients.length === 1 ? route.recipients[0] : null;
  const prefill = tpl && route
    ? {
        subject: renderTemplate(tpl.subject ?? "", { athlete_first_name: route.athleteFirstName, athlete_name: `${route.athleteFirstName} ${route.athleteLastName}`, org_name: settings.orgName, guardian_first_name: one?.firstName ?? "there", recipient_first_name: one?.firstName ?? "there" }).text,
        body: renderTemplate(tpl.body, { athlete_first_name: route.athleteFirstName, athlete_name: `${route.athleteFirstName} ${route.athleteLastName}`, org_name: settings.orgName, guardian_first_name: one?.firstName ?? "there", recipient_first_name: one?.firstName ?? "there" }).text,
      }
    : null;

  return (
    <>
      <PageHeader title="New message" description="Message a family about an athlete. Recipients follow guardian permissions — you can't pick people who aren't allowed to receive it." />
      <ChannelStatus />
      <Card className="mb-5 max-w-3xl">
        <CardBody className="pt-5">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <Field label="Athlete" htmlFor="pick-athlete" className="min-w-60 flex-1">
              <Select id="pick-athlete" name="athlete" defaultValue={selected?.id ?? ""} required>
                <option value="" disabled>
                  Choose an athlete…
                </option>
                {athletes.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            {templates.length ? (
              <Field label="Start from template (optional)" htmlFor="pick-template" className="min-w-52">
                <Select id="pick-template" name="template" defaultValue={sp.template ?? ""}>
                  <option value="">Blank</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <button type="submit" className="h-10 rounded-lg border border-edge px-4 text-sm font-medium">
              Show recipients
            </button>
          </form>
          {athletes.length === 0 ? <p className="mt-3 text-sm text-ink-3">You have no athletes in your scope. Coaches can message families of assigned athletes only.</p> : null}
        </CardBody>
      </Card>

      {selected && !route ? (
        <Callout tone="bad">You can only message families of athletes you are assigned to.</Callout>
      ) : null}

      {route ? (
        <Card className="max-w-3xl">
          <CardHeader title={`To the family of ${route.athleteFirstName} ${route.athleteLastName}`} kicker={route.isMinor ? "Minor — routed to guardians" : "Adult athlete"} />
          <CardBody>
            <ul className="mb-3 flex flex-wrap gap-2">
              {route.recipients.map((r) => (
                <li key={r.personId}>
                  <Badge variant="green">
                    {r.firstName} {r.lastName} · {r.role}
                    {r.userId ? "" : " · no portal login"}
                  </Badge>
                </li>
              ))}
            </ul>
            {route.excluded.length ? (
              <p className="mb-3 text-xs text-ink-3">Not included: {route.excluded.map((e) => `${e.name} (${e.reason})`).join("; ")}</p>
            ) : null}
            {route.recipients.length === 0 ? (
              <Callout tone="warn">No one is permitted to receive messages about this athlete (no active guardian with messaging permission).</Callout>
            ) : (
              <StableForm withMutationId action={startStaffThreadAction} className="space-y-4">
                <input type="hidden" name="athleteId" value={route.athleteId} />
                <Field label="Subject" htmlFor="subject">
                  <Input id="subject" name="subject" required maxLength={200} defaultValue={prefill?.subject ?? ""} />
                </Field>
                <Field label="Message" htmlFor="body" hint={tpl?.isSample ? "Prefilled from a SAMPLE template — edit before sending." : undefined}>
                  <Textarea id="body" name="body" required maxLength={5000} rows={6} defaultValue={prefill?.body ?? ""} />
                </Field>
                <FamilyStyleHint target="body" subjectTarget="subject" />
                {route.recipients.length > 1 ? (
                  <fieldset className="space-y-1 text-sm">
                    <legend className="mb-1 text-sm font-medium text-ink-2">Conversation</legend>
                    <label className="flex min-h-11 items-center gap-2">
                      <input type="radio" name="mode" value="separate" defaultChecked className="size-4" /> Separate conversation per recipient (recommended — replies stay private)
                    </label>
                    <label className="flex min-h-11 items-center gap-2">
                      <input type="radio" name="mode" value="group" className="size-4" /> One group conversation (all recipients see each other&apos;s replies)
                    </label>
                  </fieldset>
                ) : null}
                <fieldset className="flex flex-wrap items-center gap-4 text-sm">
                  <legend className="mb-1 text-sm font-medium text-ink-2">Delivery</legend>
                  <span className="flex min-h-11 items-center gap-2 text-ink-3">
                    <input type="checkbox" checked readOnly disabled className="size-4" aria-label="In-app (always)" /> In-app (always)
                  </span>
                  <label className="flex min-h-11 items-center gap-2">
                    <input type="checkbox" name="channels" value="email" className="size-4" /> Email
                  </label>
                  <label className="flex min-h-11 items-center gap-2">
                    <input type="checkbox" name="channels" value="sms" className="size-4" /> SMS (opt-in required)
                  </label>
                </fieldset>
                <StableSubmit pendingText="Sending…">Send</StableSubmit>
              </StableForm>
            )}
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
