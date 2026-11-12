import { eq } from "drizzle-orm";
import { organizations } from "@/db/schema";
import type { ReportDef, ReportResult } from "@/lib/reports";
import { retentionSettingsFrom } from "@/lib/retention/common";
import { checkinInsights, type ClassInsight } from "./views";

const top = (xs: { label: string; count: number }[]) =>
  xs
    .slice(0, 3)
    .map((x) => `${x.label} (${x.count})`)
    .join(", ") || null;

/** Owner report: completion, rating and themes by coach and by class slot. No names, no comments, no health values. */
export const CHECKIN_REPORTS: ReportDef[] = [
  {
    key: "session-checkins",
    title: "Session check-ins: completion, intensity and themes",
    category: "Retention",
    definition:
      'For sessions that started in the range, by coach and by class slot (class name, weekday and start time): attended bookings, ready checks and after checks answered and their completion rates (checkin_completion_v1: answered ÷ attended), mean session RPE reported by athletes beside the RPE the coach planned (intensity_gap_v1: reported minus planned, only for sessions with both), the average 1 to 5 rating, and the three most tapped "liked" and "did not like" chips. Missing answers are left out of every average, never counted as 0. No names, no comments and no health answers. A coach sees only their own sessions, and ratings and chip totals appear for a coach only once there are the minimum number of responses set in the retention settings.',
    cap: "feedback.report",
    columns: [
      { key: "section", label: "Level" },
      { key: "name", label: "Coach / class slot" },
      { key: "sessions", label: "Sessions", kind: "int" },
      { key: "attended", label: "Attended", kind: "int" },
      { key: "ready", label: "Ready checks", kind: "int" },
      { key: "ready_rate", label: "Ready check rate", kind: "pct" },
      { key: "after", label: "After checks", kind: "int" },
      { key: "after_rate", label: "After check rate", kind: "pct" },
      { key: "mean_rpe", label: "Mean reported RPE (0–10)" },
      { key: "intended_rpe", label: "Planned RPE" },
      { key: "gap", label: "Reported minus planned" },
      { key: "ratings", label: "Ratings", kind: "int" },
      { key: "avg_rating", label: "Average rating (1–5)" },
      { key: "top_liked", label: "Most liked" },
      { key: "top_disliked", label: 'Most "did not like"' },
    ],
    run: async (tx, orgId, r): Promise<ReportResult> => {
      const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
      const s = retentionSettingsFrom(org?.settings);
      const coachOnly = r.viewer?.role === "coach" ? r.viewer.userId : null;
      const opts = { reviewer: !coachOnly, minResponses: s.anonymityMinResponses };
      const scope = { from: r.from, to: r.to, tz: r.tz, coachUserId: coachOnly };
      const hidden = `not shown (fewer than ${s.anonymityMinResponses})`;
      const shape = (section: string) => (x: ClassInsight) => ({
        section,
        name: x.slot ? `${x.title} · ${x.slot}` : x.title,
        sessions: x.sessions,
        attended: x.attended,
        ready: x.ready,
        ready_rate: x.readyRate,
        after: x.after,
        after_rate: x.afterRate,
        mean_rpe: x.meanRpe,
        intended_rpe: x.intendedRpe,
        gap: x.gap === null ? null : `${x.gap > 0 ? "+" : ""}${x.gap} (${x.gapSessions} session${x.gapSessions === 1 ? "" : "s"})`,
        ratings: x.ratingCount,
        avg_rating: x.ratingHidden ? hidden : x.meanRating === null ? null : x.meanRating.toFixed(2),
        top_liked: x.chipsHidden ? hidden : top(x.liked),
        top_disliked: x.chipsHidden ? hidden : top(x.disliked),
      });
      const coaches = await checkinInsights(tx, orgId, { ...scope, groupBy: "coach" }, opts);
      const classes = await checkinInsights(tx, orgId, { ...scope, groupBy: "class" }, opts);
      const attended = coaches.reduce((a, c) => a + c.attended, 0);
      const ready = coaches.reduce((a, c) => a + c.ready, 0);
      const after = coaches.reduce((a, c) => a + c.after, 0);
      const pct = (n: number) => (attended ? `${Math.round((n / attended) * 1000) / 10}% (${n} of ${attended})` : "no attended sessions");
      return {
        rows: [...coaches.map(shape("Coach")), ...classes.map(shape("Class slot"))],
        summary: [
          { label: "Attended bookings", value: attended },
          { label: "Ready check rate", value: pct(ready) },
          { label: "After check rate", value: pct(after) },
        ],
        notes: coachOnly ? ["Showing your own sessions only."] : [],
      };
    },
  },
];
