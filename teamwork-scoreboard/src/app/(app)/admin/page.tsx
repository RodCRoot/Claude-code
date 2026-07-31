import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSetting, SETTING_DEFAULTS } from "@/lib/settings";
import { saveSetting } from "@/app/actions/admin";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Button,
  Input,
  Textarea,
  Field,
  Badge,
} from "@/components/ui";

export const metadata = { title: "Admin" };

const AREAS = [
  { href: "/admin/metrics", title: "Metric Dictionary", desc: "Definitions, formulas, goals, and red/yellow/green thresholds for every KPI." },
  { href: "/admin/users", title: "Users & Roles", desc: "Staff logins, role assignments, and per-role permissions." },
  { href: "/admin/tasks", title: "Task Templates", desc: "Recurring operations, cleaning, and marketing checklist templates." },
  { href: "/admin/onboarding", title: "Onboarding Steps", desc: "The new-athlete checklist every athlete works through." },
  { href: "/admin/scorecards", title: "Scorecard Templates", desc: "Role scorecards and weekly measurables." },
  { href: "/data", title: "Data & Sync", desc: "Connectors, sync history, imports, and field mappings." },
];

export default async function AdminPage() {
  await requireUser("manage_settings");

  const numberSettings: { key: keyof typeof SETTING_DEFAULTS; label: string; hint: string }[] = [
    { key: "monthly_revenue_target", label: "Monthly revenue target ($)", hint: "Drives “Progress to monthly revenue target”. Set your own goal — no old figures are baked in." },
    { key: "lead_response_goal_minutes", label: "Lead response goal (minutes)", hint: "Leads uncontacted past this trigger a red attention item." },
    { key: "at_risk_days_without_attendance", label: "At-risk threshold (days without attendance)", hint: "Active athletes with no check-in for this many days are flagged." },
  ];

  const jsonSettings: { key: keyof typeof SETTING_DEFAULTS; label: string; hint: string }[] = [
    { key: "appointment_types", label: "Appointment types", hint: 'JSON list of {"key","label"} — e.g. Success Session, Strong Start, Assessment.' },
    { key: "lead_sources", label: "Lead sources", hint: 'JSON list of {"key","label"}.' },
    { key: "programs", label: "Programs", hint: "JSON list of program names." },
  ];

  const demo = getSetting("demo_mode");

  return (
    <>
      <PageHeader
        kicker="Administration"
        title="Admin Settings"
        subtitle="Everything that may change later — goals, staff, metrics, thresholds, schedules, templates — is edited here, not in code."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {AREAS.map((a) => (
          <Link key={a.href} href={a.href}>
            <Card className="h-full p-4 transition-colors hover:border-brand-600/50">
              <h3 className="font-bold">{a.title}</h3>
              <p className="mt-1 text-sm text-ink-2">{a.desc}</p>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader kicker="Business rules" title="Thresholds & goals" />
          <CardBody className="space-y-4">
            {numberSettings.map((s) => (
              <form key={s.key} action={saveSetting} className="flex items-end gap-2">
                <input type="hidden" name="key" value={s.key} />
                <input type="hidden" name="type" value="number" />
                <Field label={s.label} hint={s.hint}>
                  <Input
                    name="value"
                    type="number"
                    step="any"
                    defaultValue={String(getSetting(s.key))}
                    className="w-40"
                  />
                </Field>
                <Button size="sm" variant="secondary" type="submit">Save</Button>
              </form>
            ))}
            <form action={saveSetting} className="flex items-end gap-2">
              <input type="hidden" name="key" value="business_name" />
              <input type="hidden" name="type" value="string" />
              <Field label="Business name">
                <Input name="value" defaultValue={String(getSetting("business_name"))} className="w-64" />
              </Field>
              <Button size="sm" variant="secondary" type="submit">Save</Button>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            kicker="Demo data"
            title="Demo mode"
            action={<Badge variant={demo ? "yellow" : "green"}>{demo ? "Demo data labeled" : "Live"}</Badge>}
          />
          <CardBody className="space-y-3 text-sm text-ink-2">
            <p>
              While demo mode is on, a “Demo data” label shows in the navigation.
              Turn it off once real data is connected. To remove all seeded sample
              records cleanly, run <code className="rounded bg-surface-3 px-1">npm run db:clear-demo</code>
              {" "}(keeps users, templates, metrics, and settings).
            </p>
            <form action={saveSetting} className="flex items-center gap-2">
              <input type="hidden" name="key" value="demo_mode" />
              <input type="hidden" name="type" value="boolean" />
              <input type="hidden" name="value" value={demo ? "0" : "true"} />
              <Button size="sm" variant={demo ? "primary" : "secondary"} type="submit">
                {demo ? "Turn demo label off" : "Turn demo label on"}
              </Button>
            </form>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader kicker="Configurable lists" title="Terminology & options" />
          <CardBody className="grid gap-4 lg:grid-cols-3">
            {jsonSettings.map((s) => (
              <form key={s.key} action={saveSetting} className="space-y-2">
                <input type="hidden" name="key" value={s.key} />
                <input type="hidden" name="type" value="json" />
                <Field label={s.label} hint={s.hint}>
                  <Textarea
                    name="value"
                    rows={6}
                    className="font-mono text-xs"
                    defaultValue={JSON.stringify(getSetting(s.key), null, 2)}
                  />
                </Field>
                <Button size="sm" variant="secondary" type="submit">Save</Button>
              </form>
            ))}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
