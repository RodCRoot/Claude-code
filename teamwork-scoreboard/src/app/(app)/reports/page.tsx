import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { lastNWeekStarts } from "@/lib/periods";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  ButtonLink,
  Table,
} from "@/components/ui";

export const metadata = { title: "5-15 Reports" };

export default async function ReportsPage() {
  const me = await requireUser("view_dashboard");
  const canReview = me.permissions.includes("review_reports");

  const reports = db.all<{
    id: number;
    user_name: string;
    user_id: number;
    week_start: string;
    rating: number | null;
    manager_status: string;
    submitted_at: string | null;
  }>(sql`
    SELECT r.id, u.name AS user_name, r.user_id, r.week_start, r.rating,
           r.manager_status, r.submitted_at
    FROM reports_515 r JOIN users u ON u.id = r.user_id
    ${canReview ? sql`` : sql`WHERE r.user_id = ${me.id}`}
    ORDER BY r.week_start DESC, u.name LIMIT 100
  `);

  // Missing-submission grid: staff × last 4 weeks
  const staff = db.all<{ id: number; name: string }>(sql`
    SELECT u.id, u.name FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.active = 1 AND r.permissions LIKE '%submit_scorecard%' ORDER BY u.name
  `);
  const weeks = lastNWeekStarts(4);
  const submitted = new Set(
    db
      .all<{ user_id: number; week_start: string }>(
        sql`SELECT user_id, week_start FROM reports_515 WHERE submitted_at IS NOT NULL`
      )
      .map((r) => `${r.user_id}|${r.week_start}`)
  );

  return (
    <>
      <PageHeader
        kicker="Weekly staff reports"
        title="5-15 Reports"
        subtitle="Fifteen minutes to write, five to read. Submit yours each week after your scorecard."
        actions={<ButtonLink href="/reports/new">+ New 5-15</ButtonLink>}
      />

      {canReview && (
        <Card className="mb-6">
          <CardHeader kicker="Accountability" title="Submissions — last 4 weeks" />
          <CardBody>
            <Table
              columns={["Staff", ...weeks.map((w) => w.slice(5))]}
              rows={staff.map((s) => [
                s.name,
                ...weeks.map((w) =>
                  submitted.has(`${s.id}|${w}`) ? (
                    <Badge key={w} variant="green">✓</Badge>
                  ) : (
                    <Badge key={w} variant="red">missing</Badge>
                  )
                ),
              ])}
            />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader kicker="History" title={canReview ? "All reports" : "Your reports"} />
        <CardBody>
          <Table
            columns={["Week", "Staff", "Rating", "Manager review", "Submitted", ""]}
            rows={reports.map((r) => [
              r.week_start,
              r.user_name,
              r.rating !== null ? `${r.rating}/10` : "—",
              r.manager_status === "reviewed" ? (
                <Badge key="s" variant="green">Reviewed</Badge>
              ) : (
                <Badge key="s" variant="yellow">Pending</Badge>
              ),
              r.submitted_at ? r.submitted_at.slice(0, 10) : "draft",
              <Link
                key="v"
                href={`/reports/${r.id}`}
                className="font-semibold text-brand-600 hover:underline"
              >
                Open →
              </Link>,
            ])}
            empty="No 5-15 reports yet — submit your first from the button above."
          />
        </CardBody>
      </Card>
    </>
  );
}
