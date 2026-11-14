import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardBody, CardHeader, Field, Input, Select } from "@/components/ui";
import type { Viewer } from "@/lib/authz/policy";
import { staffConsentView } from "@/lib/messaging/preferences";
import { fmt } from "@/lib/time";
import { clearUndeliverableAction, staffRecordConsentAction } from "../actions";
import { ConsentBadge, ConsentHistory } from "./consent";

/** Person profile card (crm.manage): current consent, undeliverable flags, full history. */
export async function CommunicationCard({ v, personId }: { v: Viewer; personId: string }) {
  const p = await staffConsentView(db, v, personId);
  return (
    <Card>
      <CardHeader title="Communication" kicker="Consent, quiet hours & history" />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-1">
          <ConsentBadge label="Email" consent={p.email?.consent} />
          <ConsentBadge label="SMS" consent={p.sms?.consent} />
          <span className="text-xs text-ink-3">
            Quiet hours: {p.quietHours ? `${p.quietHours.start}–${p.quietHours.end} (personal)` : p.facilityQuietHours ? `${p.facilityQuietHours.start}–${p.facilityQuietHours.end} (facility)` : "none"}
          </span>
        </div>
        {p.undeliverable.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-sm">
            <span>
              {u.address}: {u.reason === "hard_bounce" ? "hard bounce" : "spam complaint"} via {u.provider} on {fmt(u.createdAt)} — email suppressed.
            </span>
            <ActionForm action={clearUndeliverableAction}>
              <input type="hidden" name="id" value={u.id} />
              <input type="hidden" name="personId" value={personId} />
              <SubmitButton size="sm" variant="outline" confirm="Clear this flag? Only do this once the family has fixed or confirmed the address.">
                Clear flag
              </SubmitButton>
            </ActionForm>
          </div>
        ))}
        <ConsentHistory history={p.history} />
        <details>
          <summary className="cursor-pointer text-sm font-medium">Record a change the family told you about</summary>
          <ActionForm action={staffRecordConsentAction} className="mt-3 grid gap-3 sm:grid-cols-3" resetOnSuccess>
            <input type="hidden" name="personId" value={personId} />
            <Field label="Channel" htmlFor="c-channel">
              <Select id="c-channel" name="channel" defaultValue="email">
                <option value="email">Email</option>
                <option value="sms">SMS</option>
              </Select>
            </Field>
            <Field label="Consent" htmlFor="c-consent">
              <Select id="c-consent" name="consent" defaultValue="opted_out">
                <option value="opted_out">Opted out</option>
                <option value="opted_in">Opted in</option>
              </Select>
            </Field>
            <Field label="How you know" htmlFor="c-note" required>
              <Input id="c-note" name="note" required maxLength={300} placeholder="Phone call 3/2 with Alex" />
            </Field>
            <div className="sm:col-span-3">
              <SubmitButton size="sm">Record</SubmitButton>
            </div>
          </ActionForm>
        </details>
      </CardBody>
    </Card>
  );
}
