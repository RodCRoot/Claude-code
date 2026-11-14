import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents, users } from "@/db/schema";
import { ActionForm, SubmitButton } from "@/components/forms";
import { StableForm, StableSubmit } from "../../_components/stable-form";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { previewRule, sampleOptions } from "@/lib/automation/engine";
import { getRule, ruleConditions, TRIGGERS, type AutomationRule } from "@/lib/automation/rules";
import { listTemplates } from "@/lib/automation/templates";
import { DomainError } from "@/lib/messaging/errors";
import { fmt } from "@/lib/time";
import { createRuleAction, deleteRuleAction, toggleRuleAction, updateRuleAction } from "../../actions";
import { DeliveryBadge } from "../../_components/shared";

export const metadata = { title: "Automation rule" };

export default async function RulePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sample?: string; preview?: string }> }) {
  const v = await requireCap("crm.manage");
  const { id } = await params;
  const sp = await searchParams;
  const isNew = id === "new";
  let rule: AutomationRule | null = null;
  if (!isNew) {
    try {
      rule = await getRule(db, v, id);
    } catch (e) {
      if (e instanceof DomainError) notFound();
      throw e;
    }
  }
  const templates = await listTemplates(db, v.orgId);
  const cond = rule ? ruleConditions(rule) : {};
  const trig = TRIGGERS.find((t) => t.key === rule?.trigger);
  const samples = rule ? await sampleOptions(db, v.orgId, rule.trigger) : [];
  const preview = rule && sp.preview ? await previewRule(db, v, rule.id, sp.sample || undefined) : null;
  const history = rule
    ? await db
        .select({ e: auditEvents, actor: users.displayName })
        .from(auditEvents)
        .leftJoin(users, eq(users.id, auditEvents.actorUserId))
        .where(and(eq(auditEvents.orgId, v.orgId), eq(auditEvents.entityType, "automation_rule"), eq(auditEvents.entityId, rule.id)))
        .orderBy(desc(auditEvents.createdAt))
        .limit(50)
    : [];
  const channels = (rule?.channels as string[] | undefined) ?? ["in_app"];

  return (
    <>
      <PageHeader
        kicker="Automation"
        title={
          <span className="flex flex-wrap items-center gap-2">
            {isNew ? "New rule" : rule!.name}
            {rule ? rule.enabled ? <Badge variant="green">enabled</Badge> : <Badge>disabled</Badge> : null}
          </span>
        }
        actions={
          rule ? (
            <ActionForm action={toggleRuleAction}>
              <input type="hidden" name="ruleId" value={rule.id} />
              <input type="hidden" name="enabled" value={rule.enabled ? "0" : "1"} />
              <SubmitButton variant={rule.enabled ? "outline" : "primary"} confirm={rule.enabled ? undefined : "Enable this rule? It will start messaging families."}>
                {rule.enabled ? "Disable rule" : "Enable rule"}
              </SubmitButton>
            </ActionForm>
          ) : null
        }
      />
      <div className="grid gap-5 lg:grid-cols-[2fr_3fr]">
        <Card>
          <CardHeader title="Settings" />
          <CardBody>
            {isNew ? <p className="mb-3 text-sm text-ink-3">New rules are created disabled.</p> : null}
            <StableForm action={isNew ? createRuleAction : updateRuleAction} className="space-y-4">
              {rule ? <input type="hidden" name="ruleId" value={rule.id} /> : null}
              <Field label="Name" htmlFor="name" required>
                <Input id="name" name="name" required maxLength={120} defaultValue={rule?.name} />
              </Field>
              <Field label="Trigger" htmlFor="trigger" hint={trig?.help}>
                <Select id="trigger" name="trigger" defaultValue={rule?.trigger ?? "lead_created"}>
                  {TRIGGERS.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Template" htmlFor="templateId" required>
                <Select id="templateId" name="templateId" defaultValue={rule?.templateId ?? ""} required>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <fieldset className="flex flex-wrap gap-4 text-sm">
                <legend className="mb-1 text-sm font-medium text-ink-2">Channels</legend>
                <label className="flex min-h-11 items-center gap-2 text-ink-3">
                  <input type="checkbox" checked readOnly disabled className="size-4" /> In-app (always)
                </label>
                <label className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" name="channels" value="email" defaultChecked={channels.includes("email")} className="size-4" /> Email
                </label>
                <label className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" name="channels" value="sms" defaultChecked={channels.includes("sms")} className="size-4" /> SMS
                </label>
              </fieldset>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Delay (minutes)" htmlFor="delayMinutes">
                  <Input id="delayMinutes" name="delayMinutes" type="number" min={0} max={43200} defaultValue={rule?.delayMinutes ?? 0} />
                </Field>
                <Field label={trig?.daysLabel ?? "Days threshold"} htmlFor="days" hint="For scan triggers">
                  <Input id="days" name="days" type="number" min={1} max={365} defaultValue={cond.days ?? ""} placeholder={trig?.defaultDays ? String(trig.defaultDays) : ""} />
                </Field>
                <Field label="Only for sport" htmlFor="sport">
                  <Input id="sport" name="sport" maxLength={80} defaultValue={cond.sport ?? ""} placeholder="Any" />
                </Field>
                <Field label="Only service kind" htmlFor="serviceKind" hint="Session triggers">
                  <Select id="serviceKind" name="serviceKind" defaultValue={cond.serviceKind ?? ""}>
                    <option value="">Any</option>
                    {["class", "private", "semi_private", "assessment", "camp", "event"].map((k) => (
                      <option key={k} value={k}>
                        {k.replace("_", "-")}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="createTask" defaultChecked={rule?.createTask ?? false} className="size-4" /> Also create a staff follow-up task (once per record)
              </label>
              <div className="flex flex-wrap gap-3">
                <StableSubmit>{isNew ? "Create (disabled)" : "Save"}</StableSubmit>
                <Link href="/messages/automations" className="self-center text-sm text-ink-3 underline">
                  Back
                </Link>
              </div>
            </StableForm>
            {rule ? (
              <ActionForm action={deleteRuleAction} className="mt-6 border-t border-edge pt-4">
                <input type="hidden" name="ruleId" value={rule.id} />
                <SubmitButton variant="ghost" confirm="Delete this rule? Queued sends for it will be skipped.">
                  Delete rule
                </SubmitButton>
              </ActionForm>
            ) : null}
          </CardBody>
        </Card>

        {rule ? (
          <div className="min-w-0 space-y-5">
            <Card>
              <CardHeader title="Preview" kicker="Nothing is sent" />
              <CardBody>
                <form method="get" className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="preview" value="1" />
                  <Field label="Sample record" htmlFor="sample" className="min-w-60 flex-1" hint="Leave empty to scan everything that matches right now">
                    <Select id="sample" name="sample" defaultValue={sp.sample ?? ""}>
                      <option value="">All current matches</option>
                      {samples.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <button type="submit" className="h-10 rounded-lg border border-edge px-4 text-sm font-medium">
                    Preview
                  </button>
                </form>
                {samples.length === 0 ? <p className="mt-3 text-xs text-ink-3">No records of this kind exist yet (they come from Schedule, Forms or Billing).</p> : null}
                {preview ? (
                  <div className="mt-4 space-y-4">
                    {preview.sampleNote ? <Callout tone="warn">{preview.sampleNote}</Callout> : null}
                    {!preview.items.length && !preview.sampleNote ? <Callout tone="info">Nothing currently matches this rule.</Callout> : null}
                    {preview.items.map((it, i) => (
                      <div key={i} className="rounded-lg border border-edge p-3">
                        <p className="kicker">{it.label}</p>
                        <p className="mt-1 text-sm font-semibold">{it.subject}</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{it.body}</p>
                        {it.missing.length ? <p className="mt-1 text-xs text-warn">Missing values: {it.missing.join(", ")}</p> : null}
                        <Table className="mt-3" caption="Recipients">
                          <thead>
                            <tr>
                              <Th>Recipient</Th>
                              <Th>Channels</Th>
                            </tr>
                          </thead>
                          <tbody>
                            {it.recipients.map((r) => (
                              <tr key={r.personId}>
                                <Td>
                                  {r.name} <span className="text-xs text-ink-3">({r.role.replace("_", " ")})</span>
                                  {r.alreadySent ? (
                                    <Badge variant="blue" className="ml-1">
                                      already sent — won&apos;t repeat
                                    </Badge>
                                  ) : null}
                                </Td>
                                <Td>
                                  <div className="flex flex-wrap gap-1">
                                    {r.channels.map((c) => (
                                      <DeliveryBadge key={c.channel} channel={c.channel} status={c.status === "delivered" ? "delivered" : c.status} reason={c.reason} />
                                    ))}
                                  </div>
                                  {r.channels
                                    .filter((c) => c.reason || (c.runAt && c.status === "queued"))
                                    .map((c) => (
                                      <p key={c.channel} className="mt-0.5 text-xs text-ink-3">
                                        {c.channel}: {c.reason ?? ""} {c.runAt && c.status === "queued" ? `· would send ${fmt(c.runAt, "MMM d, h:mm a")}` : ""}
                                      </p>
                                    ))}
                                </Td>
                              </tr>
                            ))}
                          </tbody>
                        </Table>
                        {it.excludedNote ? <p className="mt-2 text-xs text-ink-3">Not included: {it.excludedNote}</p> : null}
                      </div>
                    ))}
                    <p className="text-xs text-ink-3">“queued” means the email/SMS would be attempted; without provider configuration it is recorded as not configured.</p>
                  </div>
                ) : null}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="History" kicker="Audit" />
              <CardBody>
                {history.length === 0 ? <p className="text-sm text-ink-3">No changes recorded.</p> : null}
                <ol className="space-y-1.5 text-sm">
                  {history.map((h) => (
                    <li key={h.e.id} className="border-l-2 border-edge pl-3">
                      <span className="font-medium">{h.e.summary ?? h.e.action.replace("automation.", "").replaceAll("_", " ")}</span>{" "}
                      <span className="text-xs text-ink-3">
                        {h.actor ?? (h.e.actorRole === "system" ? "System" : "—")} · {fmt(h.e.createdAt)}
                      </span>
                    </li>
                  ))}
                </ol>
              </CardBody>
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
