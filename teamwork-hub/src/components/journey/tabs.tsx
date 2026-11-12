import { Tabs } from "@/components/ui";

/** Section tabs for the follow-ups area. The report tab is only shown to roles that may open it. */
export function FollowUpTabs({ current, showReport }: { current: "queue" | "checklist" | "scorecard" | "report"; showReport: boolean }) {
  return (
    <Tabs
      current={current}
      tabs={[
        { key: "queue", href: "/follow-ups", label: "Today's follow-ups" },
        { key: "checklist", href: "/follow-ups/checklist", label: "Operations checklist" },
        { key: "scorecard", href: "/follow-ups/scorecard", label: "Coach scorecard" },
        ...(showReport ? [{ key: "report", href: "/follow-ups/report", label: "Journey report" }] : []),
      ]}
    />
  );
}
