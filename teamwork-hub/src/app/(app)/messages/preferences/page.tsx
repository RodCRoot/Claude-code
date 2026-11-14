import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Callout, Card, CardBody, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { isStaff } from "@/lib/authz/policy";
import { myPreferences } from "@/lib/messaging/preferences";
import { updatePreferencesAction } from "../actions";
import { ConsentBadge, ConsentHistory } from "../_components/consent";

export const metadata = { title: "Communication preferences" };

function Choice({ name, value, current, label, disabled }: { name: string; value: string; current: string | undefined; label: string; disabled?: boolean }) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <input type="radio" name={name} value={value} defaultChecked={current === value} disabled={disabled} className="size-4" /> {label}
    </label>
  );
}

export default async function PreferencesPage() {
  const v = await requireViewer();
  if (isStaff(v) || !v.personId) {
    return (
      <>
        <PageHeader title="Communication preferences" />
        <Callout tone="info">
          Families manage their own email/text preferences here. Staff can see each person&apos;s consent history on their profile (People → person → Communication).
        </Callout>
      </>
    );
  }
  const p = await myPreferences(db, v);
  const q = p.quietHours;
  const off = !p.editable;
  return (
    <>
      <PageHeader
        title="Communication preferences"
        description="Choose how Teamwork may reach you outside the app. Messages always appear here in the app regardless."
        actions={
          <Link href="/messages" className="self-center text-sm text-ink-3 underline">
            Back to messages
          </Link>
        }
      />
      {off ? (
        <Callout tone="info" className="mb-4">
          {p.notEditableReason}
        </Callout>
      ) : null}
      {p.undeliverable.length ? (
        <Callout tone="warn" className="mb-4" title="We can't reach one of your addresses">
          {p.undeliverable.map((u) => (
            <span key={u.id} className="block">
              {u.channel === "email" ? "Email" : "Text"} to {u.address} {u.reason === "spam_complaint" ? "was reported as spam" : "bounced"}, so we&apos;ve stopped sending there. Ask the front desk to update it.
            </span>
          ))}
        </Callout>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader title="Your settings" kicker={p.person.name} />
          <CardBody>
            <ActionForm action={updatePreferencesAction} className="space-y-5">
              <fieldset disabled={off}>
                <legend className="text-sm font-semibold">Email</legend>
                <p className="text-xs text-ink-3">{p.person.email ?? "No email address on file."}</p>
                <div className="mt-1 flex flex-wrap gap-4">
                  <Choice name="email" value="opted_in" current={p.email?.consent} label="Send me email" disabled={!p.person.email} />
                  <Choice name="email" value="opted_out" current={p.email?.consent} label="No email" />
                </div>
                <p className="text-xs text-ink-3">Announcements by email are only sent when you choose “Send me email”.</p>
              </fieldset>
              <fieldset disabled={off}>
                <legend className="text-sm font-semibold">Text messages (SMS)</legend>
                <p className="text-xs text-ink-3">{p.person.phone ?? "No mobile number on file."}</p>
                <div className="mt-1 flex flex-wrap gap-4">
                  <Choice name="sms" value="opted_in" current={p.sms?.consent} label="Text me" disabled={!p.person.phone} />
                  <Choice name="sms" value="opted_out" current={p.sms?.consent} label="No texts" />
                </div>
                <p className="text-xs text-ink-3">You can also reply STOP to any text to turn texts off, or START to turn them back on. Message and data rates may apply.</p>
              </fieldset>
              <fieldset disabled={off}>
                <legend className="text-sm font-semibold">Quiet hours</legend>
                <p className="text-xs text-ink-3">
                  Email and texts that would arrive during quiet hours wait until they end.
                  {p.facilityQuietHours ? ` Facility default: ${p.facilityQuietHours.start}–${p.facilityQuietHours.end}.` : " The facility has no default quiet hours."}
                </p>
                <div className="mt-1 flex flex-wrap gap-4">
                  <Choice name="quietMode" value="facility" current={q ? "custom" : "facility"} label="Use the facility default" />
                  <Choice name="quietMode" value="custom" current={q ? "custom" : "facility"} label="Use my own hours" />
                </div>
                <div className="mt-2 grid max-w-sm grid-cols-2 gap-3">
                  <Field label="From" htmlFor="quietStart">
                    <Input id="quietStart" name="quietStart" type="time" defaultValue={q?.start ?? p.facilityQuietHours?.start ?? "21:00"} />
                  </Field>
                  <Field label="Until" htmlFor="quietEnd">
                    <Input id="quietEnd" name="quietEnd" type="time" defaultValue={q?.end ?? p.facilityQuietHours?.end ?? "07:30"} />
                  </Field>
                </div>
              </fieldset>
              {off ? null : <SubmitButton>Save preferences</SubmitButton>}
            </ActionForm>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="History" kicker="Every change, with where it came from" />
          <CardBody>
            <div className="mb-3 flex flex-wrap gap-1">
              <ConsentBadge label="Email" consent={p.email?.consent} />
              <ConsentBadge label="Texts" consent={p.sms?.consent} />
            </div>
            <ConsentHistory history={p.history} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
