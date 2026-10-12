import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents, segments, users } from "@/db/schema";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Stat, Table, Td, Th } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { AuthzError, isAdmin } from "@/lib/authz/policy";
import { listTemplates } from "@/lib/automation/templates";
import { campaignReport, getCampaign, previewCampaign, REPORT_STATUSES, statusLabel, type Campaign } from "@/lib/messaging/campaigns";
import { DomainError } from "@/lib/messaging/errors";
import { messagingSettings } from "@/lib/messaging/routing";
import { fmt } from "@/lib/time";
import { campaignStepAction, saveCampaignAction } from "../../actions";
import { CAMPAIGN_BADGE, ChannelStatus, DeliveryBadge } from "../../_components/shared";

export const metadata = { title: "Campaign" };

const STATUS_TITLE: Record<string, string> = {
  queued: "Queued",
  suppressed: "Suppressed",
  not_configured: "Not configured",
  test_redirected: "Test redirect",
  sent: "Sent (provider accepted)",
  delivered: "Delivered",
  failed: "Failed",
};

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireCap("crm.manage");
  const { id } = await params;
  const isNew = id === "new";
  let c: Campaign | null = null;
  if (!isNew) {
    try {
      c = await getCampaign(db, v, id);
    } catch (e) {
      if (e instanceof DomainError) notFound();
      throw e;
    }
  }
  const [templates, segs, settings] = await Promise.all([
    listTemplates(db, v.orgId),
    db
      .select({ id: segments.id, name: segments.name })
      .from(segments)
      .where(and(eq(segments.orgId, v.orgId), isNull(segments.archivedAt)))
      .orderBy(asc(segments.name)),
    messagingSettings(db, v.orgId),
  ]);
  const editable = isNew || c!.status === "draft" || c!.status === "pending_approval";
  const showPreview = c && ["draft", "pending_approval", "approved"].includes(c.status);
  let preview: Awaited<ReturnType<typeof previewCampaign>> | null = null;
  let previewError: string | null = null;
  if (showPreview) {
    try {
      preview = await previewCampaign(db, v, c!.id);
    } catch (e) {
      if (e instanceof AuthzError || e instanceof DomainError) previewError = e.message;
      else throw e;
    }
  }
  const report = c && ["sending", "sent"].includes(c.status) ? await campaignReport(db, v, c.id) : null;
  const history = c
    ? await db
        .select({ e: auditEvents, actor: users.displayName })
        .from(auditEvents)
        .leftJoin(users, eq(users.id, auditEvents.actorUserId))
        .where(and(eq(auditEvents.orgId, v.orgId), eq(auditEvents.entityType, "campaign"), eq(auditEvents.entityId, c.id)))
        .orderBy(desc(auditEvents.createdAt))
        .limit(50)
    : [];
  const channels = (c?.channels as string[] | undefined) ?? ["in_app"];
  const scheduledLocal = c?.scheduledAt ? fmt(c.scheduledAt, "yyyy-MM-dd'T'HH:mm", settings.timezone) : "";

  return (
    <>
      <PageHeader
        kicker="Campaign"
        title={
          <span className="flex flex-wrap items-center gap-2">
            {isNew ? "New campaign" : c!.name}
            {c ? <Badge variant={CAMPAIGN_BADGE[c.status]}>{statusLabel(c.status)}</Badge> : null}
          </span>
        }
        description={c?.scheduledAt ? `Scheduled for ${fmt(c.scheduledAt)} (facility time).` : c ? "Sends as soon as it is approved." : undefined}
      />
      <ChannelStatus />
      {c?.reviewNote && c.status === "draft" ? (
        <Callout tone="warn" className="mb-4" title="Returned by the approver">
          {c.reviewNote}
        </Callout>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[2fr_3fr]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Campaign" />
            <CardBody>
              {editable ? (
                <ActionForm action={saveCampaignAction} className="space-y-4">
                  {c ? <input type="hidden" name="campaignId" value={c.id} /> : null}
                  {c?.status === "pending_approval" ? <p className="text-xs text-warn">Saving changes returns this campaign to draft; it must be approved again.</p> : null}
                  <Field label="Name (staff only)" htmlFor="name" required>
                    <Input id="name" name="name" required maxLength={120} defaultValue={c?.name} />
                  </Field>
                  <Field label="Template" htmlFor="templateId" required hint="SAMPLE templates can't be broadcast — edit the text and clear the SAMPLE flag first.">
                    <Select id="templateId" name="templateId" defaultValue={c?.templateId ?? ""} required>
                      <option value="" disabled>
                        Choose…
                      </option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.isSample ? " (SAMPLE)" : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Segment" htmlFor="segmentId" required>
                    <Select id="segmentId" name="segmentId" defaultValue={c?.segmentId ?? ""} required>
                      <option value="" disabled>
                        Choose…
                      </option>
                      {segs.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
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
                      <input type="checkbox" name="channels" value="email" defaultChecked={channels.includes("email")} className="size-4" /> Email (opted-in only)
                    </label>
                    <label className="flex min-h-11 items-center gap-2">
                      <input type="checkbox" name="channels" value="sms" defaultChecked={channels.includes("sms")} className="size-4" /> SMS (opted-in only)
                    </label>
                  </fieldset>
                  <Field label="Schedule (facility time)" htmlFor="scheduledLocal" hint="Leave empty to send when approved. Quiet hours still defer each email/SMS.">
                    <Input id="scheduledLocal" name="scheduledLocal" type="datetime-local" defaultValue={scheduledLocal} />
                  </Field>
                  <div className="flex flex-wrap gap-3">
                    <SubmitButton>{isNew ? "Create draft" : "Save draft"}</SubmitButton>
                    <Link href="/messages/campaigns" className="self-center text-sm text-ink-3 underline">
                      Back
                    </Link>
                  </div>
                </ActionForm>
              ) : (
                <dl className="space-y-1 text-sm">
                  <div>
                    <dt className="inline font-medium">Template:</dt> <dd className="inline">{templates.find((t) => t.id === c!.templateId)?.name}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Segment:</dt> <dd className="inline">{segs.find((s) => s.id === c!.segmentId)?.name ?? "(archived)"}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Channels:</dt> <dd className="inline">{channels.join(", ")}</dd>
                  </div>
                  {c!.approvedAt ? (
                    <div>
                      <dt className="inline font-medium">Approved:</dt> <dd className="inline">{fmt(c!.approvedAt)}</dd>
                    </div>
                  ) : null}
                </dl>
              )}
            </CardBody>
          </Card>

          {c && ["draft", "pending_approval", "approved"].includes(c.status) ? (
            <Card>
              <CardHeader title="Approval" kicker={isAdmin(v) ? "You can approve" : "Owner or admin approves"} />
              <CardBody className="space-y-3">
                {c.status === "draft" ? (
                  <ActionForm action={campaignStepAction}>
                    <input type="hidden" name="campaignId" value={c.id} />
                    <input type="hidden" name="step" value="submit" />
                    <SubmitButton>Submit for approval</SubmitButton>
                  </ActionForm>
                ) : null}
                {c.status === "pending_approval" && isAdmin(v) ? (
                  <>
                    <ActionForm action={campaignStepAction}>
                      <input type="hidden" name="campaignId" value={c.id} />
                      <input type="hidden" name="step" value="approve" />
                      <SubmitButton confirm={`Approve "${c.name}"? It will message ${preview?.rows.length ?? "the"} recipients ${c.scheduledAt ? "at the scheduled time" : "now"}.`}>
                        Approve &amp; queue
                      </SubmitButton>
                    </ActionForm>
                    <ActionForm action={campaignStepAction} className="space-y-2">
                      <input type="hidden" name="campaignId" value={c.id} />
                      <input type="hidden" name="step" value="reject" />
                      <Field label="Return to draft with a note" htmlFor="note">
                        <Input id="note" name="note" maxLength={500} />
                      </Field>
                      <SubmitButton variant="outline">Return to draft</SubmitButton>
                    </ActionForm>
                  </>
                ) : null}
                {c.status === "pending_approval" && !isAdmin(v) ? <p className="text-sm text-ink-3">Waiting for an owner or admin to approve.</p> : null}
                {c.status === "approved" ? <p className="text-sm text-ink-3">Approved and queued. The job worker sends it {c.scheduledAt ? `at ${fmt(c.scheduledAt)}` : "shortly"}.</p> : null}
                <ActionForm action={campaignStepAction}>
                  <input type="hidden" name="campaignId" value={c.id} />
                  <input type="hidden" name="step" value="cancel" />
                  <SubmitButton variant="ghost" confirm="Cancel this campaign? It can't be restarted.">
                    Cancel campaign
                  </SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}

          {c ? (
            <Card>
              <CardHeader title="History" kicker="Audit" />
              <CardBody>
                <ol className="space-y-1.5 text-sm">
                  {history.map((h) => (
                    <li key={h.e.id} className="border-l-2 border-edge pl-3">
                      <span className="font-medium">{h.e.summary ?? h.e.action.replace("messaging.campaign_", "").replaceAll("_", " ")}</span>{" "}
                      <span className="text-xs text-ink-3">
                        {h.actor ?? (h.e.actorRole === "system" ? "System" : "—")} · {fmt(h.e.createdAt)}
                      </span>
                    </li>
                  ))}
                </ol>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="min-w-0 space-y-5">
          {previewError ? <Callout tone="warn">{previewError}</Callout> : null}
          {report ? (
            <Card>
              <CardHeader title="Report" kicker={`${report.recipients} recipients`} />
              <CardBody>
                {(["in_app", "email", "sms"] as const)
                  .filter((ch) => report.byChannel[ch])
                  .map((ch) => (
                    <div key={ch} className="mb-4">
                      <p className="kicker mb-2">{ch === "in_app" ? "In-app" : ch === "email" ? "Email" : "SMS"}</p>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {REPORT_STATUSES.filter((s) => report.byChannel[ch][s]).map((s) => (
                          <Stat key={s} label={STATUS_TITLE[s]} value={report.byChannel[ch][s]} tone={s === "failed" ? "bad" : s === "sent" || s === "delivered" ? "ok" : undefined} />
                        ))}
                      </div>
                    </div>
                  ))}
                {report.reasons.length ? (
                  <details className="text-xs text-ink-3">
                    <summary>Why some weren&apos;t sent</summary>
                    <ul className="mt-1 list-disc pl-5">
                      {report.reasons.map((r, i) => (
                        <li key={i}>
                          {r.channel}: {r.reason ?? "—"} ({r.n})
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <p className="mt-3 text-xs text-ink-3">“Sent” means the provider accepted the message. “Not configured” means no provider is set up, so nothing left the app.</p>
              </CardBody>
            </Card>
          ) : null}
          {preview ? (
            <Card>
              <CardHeader title="Preview" kicker={`Exact recipients as of now · evaluated for ${fmt(preview.at)}`} />
              <CardBody>
                {preview.templateIsSample ? (
                  <Callout tone="warn" className="mb-3">
                    The template is marked SAMPLE; it can&apos;t be submitted until its text is replaced.
                  </Callout>
                ) : null}
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat label="Recipients" value={preview.rows.length} hint={`${preview.matched} ${preview.audience === "leads" ? "leads" : "athletes"} matched`} />
                  {Object.entries(preview.totals)
                    .filter(([ch]) => ch !== "in_app")
                    .map(([ch, t]) => (
                      <Stat key={ch} label={ch === "email" ? "Email will send" : "SMS will send"} value={t.queued} hint={`${t.suppressed} suppressed${t.deferred ? ` · ${t.deferred} after quiet hours` : ""}`} />
                    ))}
                </div>
                <div className="mb-4 rounded-lg border border-edge p-3">
                  <p className="kicker">Rendered for {preview.sample.forName ?? "—"}</p>
                  <p className="mt-1 text-sm font-semibold">{preview.sample.subject}</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{preview.sample.body}</p>
                  {preview.sample.missing.length ? <p className="mt-1 text-xs text-warn">Missing values: {preview.sample.missing.join(", ")}</p> : null}
                </div>
                <Table caption="Recipients">
                  <thead>
                    <tr>
                      <Th>Recipient</Th>
                      <Th>Channels</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 200).map((r) => (
                      <tr key={r.personId}>
                        <Td>
                          {r.name} <span className="text-xs text-ink-3">({r.role.replace("_", " ")})</span>
                          {r.about ? <span className="block text-xs text-ink-3">{r.about}</span> : null}
                          {r.alreadySent ? (
                            <Badge variant="blue" className="mt-0.5">
                              already sent
                            </Badge>
                          ) : null}
                        </Td>
                        <Td>
                          <div className="flex flex-wrap gap-1">
                            {r.channels.map((ch) => (
                              <DeliveryBadge key={ch.channel} channel={ch.channel} status={ch.status} reason={ch.reason} />
                            ))}
                          </div>
                          {r.channels
                            .filter((ch) => ch.reason)
                            .map((ch) => (
                              <p key={ch.channel} className="mt-0.5 text-xs text-ink-3">
                                {ch.channel}: {ch.reason}
                                {ch.runAt && ch.status === "queued" ? ` · ${fmt(ch.runAt, "MMM d, h:mm a")}` : ""}
                              </p>
                            ))}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {preview.rows.length > 200 ? <p className="mt-2 text-xs text-ink-3">Showing 200 of {preview.rows.length}.</p> : null}
                {preview.excluded.length ? (
                  <details className="mt-3 text-xs text-ink-3">
                    <summary>{preview.excluded.length} not messaged (guardian routing)</summary>
                    <ul className="mt-1 list-disc pl-5">
                      {preview.excluded.slice(0, 200).map((e, i) => (
                        <li key={i}>
                          {e.name} ({e.about}): {e.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <p className="mt-3 text-xs text-ink-3">The list is re-resolved when the campaign sends, so it reflects any consent or roster changes made after approval. Each person is messaged at most once per campaign.</p>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
