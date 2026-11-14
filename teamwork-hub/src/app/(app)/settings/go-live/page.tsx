import Link from "next/link";
import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { goLiveReadiness, STATUS_LABEL, type GoLiveItem, type GoLiveStatus } from "@/lib/golive/readiness";
import { todayLocal } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Input, PageHeader, Stat, type BadgeVariant } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { attestAction, checkStorageAction, withdrawAttestationAction } from "./actions";

export const metadata = { title: "Go-live readiness" };

const TONE: Record<GoLiveStatus, BadgeVariant> = { done: "green", attention: "yellow", not_started: "red", na: "neutral" };

export default async function GoLivePage() {
  const v = await requireCap("settings.manage");
  const report = await goLiveReadiness(db, v);
  const today = todayLocal();
  return (
    <>
      <PageHeader
        kicker="Settings"
        title="Go-live readiness"
        description="What is left before real families use the hub. Every status is worked out from the server and the data each time this page loads; nothing here is ticked off in advance."
      />
      <SettingsTabs current="go-live" />
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Stat label="Done" value={`${report.done} of ${report.total}`} hint="Items that do not apply are left out of the count." />
        <Stat label="Block going live" value={report.blocking} tone={report.blocking ? "bad" : "ok"} hint="Safety, backups, legal text, and payments if the hub bills families." />
        <Stat label="Billing in the hub" value={report.billingHere ? "Yes" : "Not yet"} hint={report.billingHere ? "Payments items block going live." : "No Stripe keys and no hub-billed membership, so Payments items do not block."} />
      </div>
      <p className="mb-5 text-sm font-semibold" data-testid="golive-summary">
        {report.summary}
      </p>
      {report.blocking ? (
        <Callout tone="warn" title={`${report.blocking} ${report.blocking === 1 ? "item blocks" : "items block"} going live`} className="mb-5">
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {report.blockingItems.map((i) => (
              <li key={i.id}>
                <a href={`#${anchor(i.id)}`} className="underline">
                  {i.title}
                </a>
              </li>
            ))}
          </ul>
        </Callout>
      ) : (
        <Callout tone="ok" title="Nothing blocks going live" className="mb-5">
          The remaining items are worth finishing but do not stop real families from using the hub.
        </Callout>
      )}
      <div className="space-y-5">
        {report.sections.map((s) => (
          <Card key={s.id} id={`section-${s.id}`}>
            <CardHeader title={s.title} kicker={s.intro} action={<Badge variant={s.total && s.done === s.total ? "green" : "neutral"}>{s.total ? `${s.done} of ${s.total} done` : "Nothing applies"}</Badge>} />
            <CardBody className="p-0">
              <ul className="divide-y divide-edge">
                {s.items.map((i) => (
                  <ItemRow key={i.id} item={i} today={today} />
                ))}
              </ul>
            </CardBody>
          </Card>
        ))}
      </div>
      <p className="mt-5 text-xs text-ink-3">
        A tick by a person is only offered for things the hub cannot see, and it always shows who said so and on what date. Ticks and confirmations are written to the{" "}
        <Link href="/settings/audit" className="underline">
          audit log
        </Link>
        .
      </p>
    </>
  );
}

const anchor = (id: string) => `item-${id.replace(/[^a-zA-Z0-9]+/g, "-")}`;

function ItemRow({ item: i, today }: { item: GoLiveItem; today: string }) {
  const canAttest = !!i.attestKey && !i.attested && i.status !== "done";
  return (
    <li id={anchor(i.id)} className="px-4 py-3 text-sm" data-item={i.id} data-status={i.status}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h3 className="min-w-0 font-semibold">{i.title}</h3>
        <span className="flex flex-wrap gap-1">
          {i.blocking ? <Badge variant="red">Blocks going live</Badge> : null}
          <Badge variant={TONE[i.status]}>{STATUS_LABEL[i.status]}</Badge>
        </span>
      </div>
      <p className="mt-1 text-ink-2">{i.why}</p>
      <p className="mt-1 break-words text-ink">{i.detail}</p>
      {i.list?.length ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-ink-2">
          {i.list.map((l) => (
            <li key={l} className="break-words">
              {l}
            </li>
          ))}
        </ul>
      ) : null}
      {i.attested ? (
        <p className="mt-1 text-xs text-ink-2">
          <Badge variant="blue">Attested by a person</Badge> {i.attested.byName}, {i.attested.on}. The hub cannot check this itself.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        {i.href ? (
          <Link href={i.href} className="inline-flex min-h-8 items-center font-semibold text-brand underline">
            Fix it in {i.hrefLabel}
          </Link>
        ) : i.hrefLabel ? (
          <span className="text-ink-3">{i.hrefLabel}</span>
        ) : null}
        {i.id === "hosting.object_storage" ? (
          <ActionForm action={checkStorageAction}>
            <SubmitButton variant="outline" size="sm" pendingText="Checking…">
              Check storage now
            </SubmitButton>
          </ActionForm>
        ) : null}
        {i.attested && i.attestKey ? (
          <ActionForm action={withdrawAttestationAction}>
            <input type="hidden" name="key" value={i.attestKey} />
            <SubmitButton variant="ghost" size="sm" pendingText="Withdrawing…">
              Withdraw
            </SubmitButton>
          </ActionForm>
        ) : null}
      </div>
      {canAttest ? (
        <details className="mt-2 rounded-lg border border-edge bg-surface-2 px-3 py-2">
          <summary className="min-h-8 cursor-pointer text-xs font-semibold">{i.attestAction ?? "Record this yourself"}</summary>
          <ActionForm action={attestAction} className="mt-2 space-y-2">
            <input type="hidden" name="key" value={i.attestKey} />
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input type="checkbox" name="agree" className="mt-1" />
              <span>{i.attestStatement}</span>
            </label>
            <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
              <label className="text-xs font-medium">
                Date
                <Input type="date" name="on" defaultValue={today} max={today} />
              </label>
              <label className="text-xs font-medium">
                Note{i.attestNeedsNote ? " (required)" : " (optional)"}
                <Input name="note" maxLength={500} required={i.attestNeedsNote} />
              </label>
            </div>
            <p className="text-xs text-ink-3">This is saved with your name and shown here as attested by you. It is written to the audit log.</p>
            <SubmitButton size="sm">{i.attestAction ?? "Record"}</SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </li>
  );
}
