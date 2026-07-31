import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import {
  addLead,
  logLeadActivity,
  updateLeadStage,
  scheduleAppointment,
  updateAppointment,
} from "@/app/actions/crm";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Button,
  Input,
  Select,
  Textarea,
  Field,
} from "@/components/ui";
import { cn } from "@/lib/cn";

export const metadata = { title: "Leads & Appointments" };

const STAGES = [
  "new",
  "contacted",
  "appointment_scheduled",
  "appointment_completed",
  "trial",
  "member",
  "lost",
];

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; tab?: string; lead?: string }>;
}) {
  const me = await requireUser("view_dashboard");
  const canEdit = me.permissions.includes("edit_records");
  const sp = await searchParams;
  const tab = sp.tab === "appointments" ? "appointments" : "leads";
  const filter = sp.filter ?? "open";
  const leadSources = getSetting("lead_sources");
  const apptTypes = getSetting("appointment_types");

  const where =
    filter === "uncontacted"
      ? sql`WHERE l.first_contacted_at IS NULL AND l.stage NOT IN ('lost','member')`
      : filter === "all"
      ? sql``
      : sql`WHERE l.stage NOT IN ('lost','member')`;

  const leadRows = db.all<{
    id: number;
    name: string;
    contact_name: string | null;
    phone: string | null;
    email: string | null;
    source: string;
    stage: string;
    created_at: string;
    first_contacted_at: string | null;
    notes: string | null;
    activities: number;
  }>(sql`
    SELECT l.*, (SELECT COUNT(*) FROM lead_activities la WHERE la.lead_id = l.id) AS activities
    FROM leads l ${where}
    ORDER BY l.created_at DESC LIMIT 200
  `);

  const appts = db.all<{
    id: number;
    who: string;
    type_key: string;
    scheduled_at: string;
    status: string;
    confirmed: number;
  }>(sql`
    SELECT ap.id, COALESCE(l.name, a.name, '—') AS who, ap.type_key, ap.scheduled_at,
      ap.status, ap.confirmed
    FROM appointments ap
    LEFT JOIN leads l ON l.id = ap.lead_id
    LEFT JOIN athletes a ON a.id = ap.athlete_id
    ${sp.filter === "no_show" ? sql`WHERE ap.status = 'no_show'` : sql``}
    ORDER BY ap.scheduled_at DESC LIMIT 200
  `);

  const openLead = sp.lead ? leadRows.find((l) => l.id === parseInt(sp.lead!, 10)) : undefined;

  return (
    <>
      <PageHeader
        kicker="Records"
        title="Leads & Appointments"
        subtitle="Pipeline data normally flows in from the CRM (webhook or import); everything here can also be managed manually."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="flex overflow-hidden rounded-lg border border-edge">
          {[
            { key: "leads", label: "Leads" },
            { key: "appointments", label: "Appointments" },
          ].map((t) => (
            <Link
              key={t.key}
              href={`/leads?tab=${t.key}`}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold",
                tab === t.key ? "bg-brand-600 text-white" : "bg-surface-2 text-ink-2 hover:bg-surface-3"
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>
        {tab === "leads" && (
          <div className="flex overflow-hidden rounded-lg border border-edge">
            {[
              { key: "open", label: "Open pipeline" },
              { key: "uncontacted", label: "Uncontacted" },
              { key: "all", label: "All" },
            ].map((f) => (
              <Link
                key={f.key}
                href={`/leads?filter=${f.key}`}
                className={cn(
                  "px-3 py-1.5 text-xs font-semibold",
                  filter === f.key ? "bg-surface-3 text-ink" : "bg-surface-2 text-ink-2 hover:bg-surface-3"
                )}
              >
                {f.label}
              </Link>
            ))}
          </div>
        )}
      </div>

      {tab === "leads" ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <CardHeader kicker={`${leadRows.length} shown`} title="Lead pipeline" />
              <CardBody>
                <ul className="divide-y divide-edge/60">
                  {leadRows.map((l) => (
                    <li key={l.id} className={cn("py-2.5", openLead?.id === l.id && "rounded-lg bg-surface-3/50 px-2")}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <Link href={`/leads?lead=${l.id}&filter=${filter}`} className="font-semibold hover:underline">
                            {l.name}
                          </Link>
                          {l.contact_name ? (
                            <span className="ml-2 text-xs text-ink-3">({l.contact_name})</span>
                          ) : null}
                          <span className="ml-2 text-xs text-ink-3">
                            {l.source} · added {l.created_at.slice(0, 10)}
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          {l.first_contacted_at ? (
                            <Badge variant="green">contacted</Badge>
                          ) : (
                            <Badge variant="red">needs contact</Badge>
                          )}
                          <Badge variant="neutral">{l.stage.replace(/_/g, " ")}</Badge>
                        </span>
                      </div>
                      {openLead?.id === l.id && canEdit && (
                        <div className="mt-3 grid gap-3 border-t border-edge/60 pt-3 sm:grid-cols-2">
                          <form action={logLeadActivity} className="space-y-2">
                            <input type="hidden" name="leadId" value={l.id} />
                            <div className="kicker">Log outreach</div>
                            <div className="flex gap-2">
                              <Select name="type" className="w-28">
                                <option value="call">Call</option>
                                <option value="text">Text</option>
                                <option value="email">Email</option>
                                <option value="note">Note</option>
                              </Select>
                              <Input name="note" placeholder="What happened?" />
                            </div>
                            <Button size="sm" type="submit">Log it</Button>
                            <span className="ml-2 text-xs text-ink-3">{l.activities} activities so far</span>
                          </form>
                          <div className="space-y-2">
                            <form action={updateLeadStage} className="flex items-end gap-2">
                              <input type="hidden" name="leadId" value={l.id} />
                              <Field label="Stage">
                                <Select name="stage" defaultValue={l.stage} className="w-48">
                                  {STAGES.map((s) => (
                                    <option key={s} value={s}>
                                      {s.replace(/_/g, " ")}
                                    </option>
                                  ))}
                                </Select>
                              </Field>
                              <Button size="sm" variant="secondary" type="submit">Update</Button>
                            </form>
                            <form action={scheduleAppointment} className="flex items-end gap-2">
                              <input type="hidden" name="leadId" value={l.id} />
                              <Field label="Book appointment">
                                <Input type="datetime-local" name="scheduledAt" required className="w-48" />
                              </Field>
                              <Select name="typeKey" className="w-36">
                                {apptTypes.map((t) => (
                                  <option key={t.key} value={t.key}>
                                    {t.label}
                                  </option>
                                ))}
                              </Select>
                              <Button size="sm" variant="secondary" type="submit">Book</Button>
                            </form>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                  {leadRows.length === 0 && (
                    <li className="py-4 text-sm text-ink-3">No leads match this filter.</li>
                  )}
                </ul>
              </CardBody>
            </Card>
          </div>

          <Card id="add" className="h-fit">
            <CardHeader kicker="Quick action" title="Add lead" />
            <CardBody>
              {canEdit ? (
                <form action={addLead} className="space-y-3">
                  <Field label="Lead / athlete name">
                    <Input name="name" required />
                  </Field>
                  <Field label="Parent or guardian">
                    <Input name="contactName" />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Phone">
                      <Input name="phone" />
                    </Field>
                    <Field label="Email">
                      <Input name="email" type="email" />
                    </Field>
                  </div>
                  <Field label="Source">
                    <Select name="source">
                      {leadSources.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Notes">
                    <Textarea name="notes" rows={2} />
                  </Field>
                  <Button type="submit" className="w-full">Add lead</Button>
                </form>
              ) : (
                <p className="text-sm text-ink-3">Your role cannot add records.</p>
              )}
            </CardBody>
          </Card>
        </div>
      ) : (
        <Card>
          <CardHeader kicker={`${appts.length} shown`} title="Appointments" />
          <CardBody>
            <ul className="divide-y divide-edge/60">
              {appts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span>
                    <span className="font-semibold">{a.who}</span>
                    <span className="ml-2 text-xs text-ink-3">
                      {a.type_key.replace(/_/g, " ")} · {a.scheduled_at.slice(0, 16).replace("T", " ")}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Badge
                      variant={
                        a.status === "completed"
                          ? "green"
                          : a.status === "no_show"
                          ? "red"
                          : a.status === "canceled"
                          ? "neutral"
                          : a.confirmed
                          ? "green"
                          : "yellow"
                      }
                    >
                      {a.status === "scheduled" ? (a.confirmed ? "confirmed" : "unconfirmed") : a.status.replace("_", " ")}
                    </Badge>
                    {canEdit && a.status === "scheduled" && (
                      <form action={updateAppointment} className="flex gap-1">
                        <input type="hidden" name="appointmentId" value={a.id} />
                        {!a.confirmed && (
                          <Button size="sm" variant="outline" name="do" value="confirm">
                            Confirm
                          </Button>
                        )}
                        <Button size="sm" variant="outline" name="do" value="completed">
                          Showed
                        </Button>
                        <Button size="sm" variant="ghost" name="do" value="no_show">
                          No-show
                        </Button>
                      </form>
                    )}
                  </span>
                </li>
              ))}
              {appts.length === 0 && <li className="py-4 text-sm text-ink-3">No appointments.</li>}
            </ul>
          </CardBody>
        </Card>
      )}
    </>
  );
}
