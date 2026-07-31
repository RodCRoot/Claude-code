import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { safePct } from "@/lib/calc";
import { todayStr } from "@/lib/periods";
import {
  upsertCampaign,
  updateCampaignChecklist,
  upsertMarketingItem,
  updateContentTheme,
} from "@/app/actions/admin";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Button,
  Input,
  Select,
  Field,
} from "@/components/ui";
import { cn } from "@/lib/cn";

export const metadata = { title: "Marketing & 3R" };

const CAMPAIGN_CHECKLIST: [string, string][] = [
  ["lead_form", "Lead form"],
  ["email_campaign", "Email campaign"],
  ["text_campaign", "Text campaign"],
  ["paid_ads", "Paid ads"],
  ["organic_posts", "Organic posts"],
  ["website_updates", "Website updates"],
  ["social_bios", "FB cover / IG bio updates"],
];

const PILLARS: { key: string; label: string; blurb: string }[] = [
  { key: "email_321", label: "3-2-1 Email Strategy", blurb: "3 newsletters/week · 2 engagement emails or texts/month · 1 deadline-driven campaign" },
  { key: "referrals", label: "3R — Referrals", blurb: "Evergreen offer, monthly campaign, asks, and results" },
  { key: "reactivations", label: "3R — Reactivations", blurb: "Birthday & former-athlete outreach" },
  { key: "relationships", label: "3R — Relationships", blurb: "Partners, local businesses, community events, lead boxes" },
  { key: "internal", label: "Internal Engagement", blurb: "Day-one photos, recognition, goals board, workshops, socials, upgrades" },
  { key: "social_proof", label: "Social Proof", blurb: "Reviews, testimonials, spotlights, wins, posts, stories" },
  { key: "digital", label: "Digital Marketing", blurb: "Meta & Google ads, website, SEO, Google Business Profile" },
];

const STATUSES = ["planned", "in_progress", "done", "skipped"];

export default async function MarketingPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const me = await requireUser("view_dashboard");
  const canEdit = me.permissions.includes("manage_marketing");
  const sp = await searchParams;
  const thisMonth = todayStr().slice(0, 7);
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : thisMonth;

  const prevMonth = new Date(month + "-15T00:00:00");
  prevMonth.setMonth(prevMonth.getMonth() - 1);
  const nextMonth = new Date(month + "-15T00:00:00");
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  const fmtMonth = (d: Date) => d.toISOString().slice(0, 7);

  const campaignRows = db.all<{
    id: number;
    name: string;
    audience: string | null;
    start_date: string | null;
    end_date: string | null;
    goal: string | null;
    checklist: string;
    leads_generated: number;
    appointments_booked: number;
    enrollments: number;
    revenue: number;
    status: string;
    notes: string | null;
  }>(sql`
    SELECT * FROM campaigns
    WHERE (start_date IS NULL OR substr(start_date,1,7) <= ${month})
      AND (end_date IS NULL OR substr(end_date,1,7) >= ${month})
    ORDER BY start_date DESC LIMIT 5
  `);

  const items = db.all<{
    id: number;
    pillar: string;
    name: string;
    target: number | null;
    actual: number;
    unit: string;
    status: string;
    notes: string | null;
  }>(sql`
    SELECT id, pillar, name, target, actual, unit, status, notes
    FROM marketing_items WHERE month = ${month}
    ORDER BY pillar, sort_order, id
  `);

  const themes = db.all<{ id: number; day_of_week: number; theme: string }>(
    sql`SELECT * FROM content_themes ORDER BY day_of_week`
  );
  const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  return (
    <>
      <PageHeader
        kicker="Marketing workspace"
        title={`Marketing Plan — ${month}`}
        subtitle="Deadline-driven offer, digital channels, 3-2-1 email, the 3R framework, and weekly content themes."
        actions={
          <div className="no-print flex items-center gap-2">
            <Link href={`/marketing?month=${fmtMonth(prevMonth)}`} className="rounded-lg border border-edge px-2.5 py-1.5 text-xs font-semibold hover:bg-surface-3">←</Link>
            <Link href={`/marketing?month=${thisMonth}`} className="rounded-lg border border-edge px-2.5 py-1.5 text-xs font-semibold hover:bg-surface-3">This month</Link>
            <Link href={`/marketing?month=${fmtMonth(nextMonth)}`} className="rounded-lg border border-edge px-2.5 py-1.5 text-xs font-semibold hover:bg-surface-3">→</Link>
          </div>
        }
      />

      {/* Deadline-driven offer */}
      <Card className="mb-5">
        <CardHeader
          kicker="Deadline-driven offer"
          title={campaignRows.length > 0 ? "Active campaigns" : "No campaign this month"}
        />
        <CardBody className="space-y-5">
          {campaignRows.map((c) => {
            let checklist: Record<string, string> = {};
            try {
              checklist = JSON.parse(c.checklist);
            } catch {}
            const conv = safePct(c.enrollments, c.leads_generated);
            return (
              <div key={c.id} className="rounded-lg border border-edge p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-bold">{c.name}</h3>
                    <p className="text-xs text-ink-3">
                      {c.audience ?? "all audiences"} · {c.start_date ?? "?"} → {c.end_date ?? "?"} · Goal: {c.goal ?? "—"}
                    </p>
                  </div>
                  <Badge variant={c.status === "active" ? "green" : c.status === "complete" ? "neutral" : "yellow"}>
                    {c.status}
                  </Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    ["Leads", c.leads_generated],
                    ["Appointments", c.appointments_booked],
                    ["Enrollments", c.enrollments],
                    ["Revenue", `$${c.revenue.toLocaleString()}`],
                  ].map(([label, v]) => (
                    <div key={String(label)} className="rounded-lg bg-surface-3/60 px-3 py-2">
                      <div className="kicker">{label}</div>
                      <div className="stat-figure text-xl font-bold">{v}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-ink-3">
                  Campaign conversion: {conv === null ? "—" : `${Math.round(conv)}%`} (enrollments ÷ leads)
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {CAMPAIGN_CHECKLIST.map(([key, label]) => {
                    const st = checklist[key] ?? "planned";
                    return canEdit ? (
                      <form key={key} action={updateCampaignChecklist}>
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="item" value={key} />
                        <input type="hidden" name="value" value={st === "done" ? "planned" : "done"} />
                        <button
                          className={cn(
                            "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                            st === "done"
                              ? "border-ok/30 bg-ok/10 text-ok"
                              : "border-edge bg-surface-2 text-ink-3 hover:bg-surface-3"
                          )}
                          title="Click to toggle"
                        >
                          {st === "done" ? "✓ " : ""}
                          {label}
                        </button>
                      </form>
                    ) : (
                      <Badge key={key} variant={st === "done" ? "green" : "neutral"}>{label}</Badge>
                    );
                  })}
                </div>
                {canEdit && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-semibold text-brand-600">
                      Update results
                    </summary>
                    <form action={upsertCampaign} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="name" value={c.name} />
                      <Field label="Leads"><Input name="leadsGenerated" type="number" defaultValue={c.leads_generated} /></Field>
                      <Field label="Appts"><Input name="appointmentsBooked" type="number" defaultValue={c.appointments_booked} /></Field>
                      <Field label="Enrolled"><Input name="enrollments" type="number" defaultValue={c.enrollments} /></Field>
                      <Field label="Revenue"><Input name="revenue" type="number" step="any" defaultValue={c.revenue} /></Field>
                      <Field label="Status">
                        <Select name="status" defaultValue={c.status}>
                          <option value="planned">planned</option>
                          <option value="active">active</option>
                          <option value="complete">complete</option>
                        </Select>
                      </Field>
                      <div className="col-span-2 sm:col-span-5">
                        <Button size="sm" type="submit">Save results</Button>
                      </div>
                    </form>
                  </details>
                )}
              </div>
            );
          })}
          {canEdit && (
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-brand-600">
                + New deadline-driven offer
              </summary>
              <form action={upsertCampaign} className="mt-3 grid gap-2 sm:grid-cols-3">
                <Field label="Offer name"><Input name="name" required /></Field>
                <Field label="Audience"><Input name="audience" /></Field>
                <Field label="Goal"><Input name="goal" placeholder="e.g. 10 enrollments" /></Field>
                <Field label="Start"><Input name="startDate" type="date" /></Field>
                <Field label="End"><Input name="endDate" type="date" /></Field>
                <div className="flex items-end">
                  <Button type="submit">Create campaign</Button>
                </div>
              </form>
            </details>
          )}
        </CardBody>
      </Card>

      {/* Pillars */}
      <div className="grid gap-4 lg:grid-cols-2">
        {PILLARS.map((p) => {
          const rows = items.filter((i) => i.pillar === p.key);
          const done = rows.filter((r) => r.status === "done").length;
          return (
            <Card key={p.key}>
              <CardHeader
                kicker={p.blurb}
                title={p.label}
                action={<Badge variant={rows.length && done === rows.length ? "green" : "neutral"}>{done}/{rows.length}</Badge>}
              />
              <CardBody>
                <ul className="divide-y divide-edge/60">
                  {rows.map((i) => (
                    <li key={i.id} className="py-2">
                      {canEdit ? (
                        <form action={upsertMarketingItem} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="id" value={i.id} />
                          <input type="hidden" name="pillar" value={i.pillar} />
                          <input type="hidden" name="name" value={i.name} />
                          <input type="hidden" name="month" value={month} />
                          <input type="hidden" name="target" value={i.target ?? ""} />
                          <span className="min-w-0 flex-1 text-sm font-medium">{i.name}</span>
                          <span className="text-xs text-ink-3">
                            {i.target !== null ? `goal ${i.target}` : ""}
                          </span>
                          <Input
                            name="actual"
                            type="number"
                            step="any"
                            defaultValue={i.actual}
                            className="h-7 w-16 text-xs"
                            aria-label="actual"
                          />
                          <Select name="status" defaultValue={i.status} className="h-7 w-28 text-xs">
                            {STATUSES.map((s) => (
                              <option key={s} value={s}>{s.replace("_", " ")}</option>
                            ))}
                          </Select>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" type="submit">
                            Save
                          </Button>
                        </form>
                      ) : (
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium">{i.name}</span>
                          <span className="text-xs text-ink-3">
                            {i.actual}
                            {i.target !== null ? ` / ${i.target}` : ""} ·{" "}
                            <Badge variant={i.status === "done" ? "green" : i.status === "in_progress" ? "yellow" : "neutral"}>
                              {i.status.replace("_", " ")}
                            </Badge>
                          </span>
                        </div>
                      )}
                    </li>
                  ))}
                  {rows.length === 0 && (
                    <li className="py-2 text-sm text-ink-3">No items planned for {month}.</li>
                  )}
                </ul>
                {canEdit && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-semibold text-brand-600">+ Add item</summary>
                    <form action={upsertMarketingItem} className="mt-2 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="pillar" value={p.key} />
                      <input type="hidden" name="month" value={month} />
                      <Field label="Item"><Input name="name" required className="w-56" /></Field>
                      <Field label="Goal"><Input name="target" type="number" step="any" className="w-20" /></Field>
                      <Button size="sm" type="submit">Add</Button>
                    </form>
                  </details>
                )}
              </CardBody>
            </Card>
          );
        })}

        {/* Weekly content themes */}
        <Card>
          <CardHeader
            kicker="Always-on social"
            title="Weekly Content Themes"
            action={<Badge variant="neutral">editable</Badge>}
          />
          <CardBody>
            <ul className="divide-y divide-edge/60">
              {themes.map((t) => (
                <li key={t.id} className="flex items-center gap-2 py-2">
                  <span className="w-24 text-sm font-semibold">{DAYS[t.day_of_week]}</span>
                  {canEdit ? (
                    <form action={updateContentTheme} className="flex flex-1 gap-2">
                      <input type="hidden" name="id" value={t.id} />
                      <Input name="theme" defaultValue={t.theme} className="h-8 flex-1 text-sm" />
                      <Button size="sm" variant="outline" type="submit">Save</Button>
                    </form>
                  ) : (
                    <span className="text-sm text-ink-2">{t.theme}</span>
                  )}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
