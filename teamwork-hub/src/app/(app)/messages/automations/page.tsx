import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Callout, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { listRules, triggerLabel } from "@/lib/automation/rules";
import { evaluateNowAction, toggleRuleAction } from "../actions";
import { StaffTabs } from "../_components/shared";

export const metadata = { title: "Automations" };

export default async function AutomationsPage() {
  const v = await requireCap("crm.manage");
  const rows = await listRules(db, v.orgId);
  return (
    <>
      <PageHeader
        title="Messages"
        description="Automations send a template when something happens. Every rule starts disabled; preview it against real records before enabling."
        actions={
          <>
            <ActionForm action={evaluateNowAction}>
              <SubmitButton variant="outline" pendingText="Queuing…">
                Run scan now
              </SubmitButton>
            </ActionForm>
            <ButtonLink href="/messages/automations/new">New rule</ButtonLink>
          </>
        }
      />
      <StaffTabs v={v} current="automations" />
      <Callout tone="info" className="mb-4">
        Rules run in the background job worker (<code>pnpm jobs:work</code>). Each (rule, record, recipient, period) sends at most once; consent, guardian routing and quiet hours always apply. Session
        cancellations still send a plain in-app notice when no cancellation rule is enabled.
      </Callout>
      {rows.length === 0 ? (
        <EmptyState title="No automation rules" action={<ButtonLink href="/messages/automations/new">New rule</ButtonLink>} />
      ) : (
        <Card>
          <Table caption="Automation rules">
            <thead>
              <tr>
                <Th>Rule</Th>
                <Th>Trigger</Th>
                <Th>Template</Th>
                <Th>Channels</Th>
                <Th align="right">Delay</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ rule: r, templateName, templateIsSample }) => (
                <tr key={r.id}>
                  <Td>
                    <Link href={`/messages/automations/${r.id}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                    {r.createTask ? <span className="block text-xs text-ink-3">+ creates a staff task</span> : null}
                  </Td>
                  <Td>{triggerLabel(r.trigger)}</Td>
                  <Td>
                    {templateName ?? "—"}
                    {templateIsSample ? (
                      <Badge variant="yellow" className="ml-1">
                        SAMPLE
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>{(r.channels as string[]).map((c) => c.replace("_", "-")).join(", ")}</Td>
                  <Td align="right">{r.delayMinutes ? `${r.delayMinutes} min` : "—"}</Td>
                  <Td>{r.enabled ? <Badge variant="green">enabled</Badge> : <Badge>disabled</Badge>}</Td>
                  <Td>
                    <ActionForm action={toggleRuleAction}>
                      <input type="hidden" name="ruleId" value={r.id} />
                      <input type="hidden" name="enabled" value={r.enabled ? "0" : "1"} />
                      <SubmitButton size="sm" variant={r.enabled ? "outline" : "secondary"} confirm={r.enabled ? undefined : `Enable "${r.name}"? It will start messaging families. Preview it first.`}>
                        {r.enabled ? "Disable" : "Enable"}
                      </SubmitButton>
                    </ActionForm>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
