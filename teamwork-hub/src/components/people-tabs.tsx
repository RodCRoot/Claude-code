import { Tabs } from "./ui";

export function PeopleTabs({ current, showLeads = true, showRequests = false, showRetention = true }: { current: "directory" | "leads" | "tasks" | "requests" | "retention" | "referrals" | "showcases" | "new"; showLeads?: boolean; showRequests?: boolean; showRetention?: boolean }) {
  const tabs = [
    { key: "directory", href: "/people", label: "Directory" },
    ...(showLeads ? [{ key: "leads", href: "/people/leads", label: "Leads & pipeline" }] : []),
    ...(showRequests ? [{ key: "requests", href: "/people/requests", label: "Member requests" }] : []),
    ...(showRetention ? [{ key: "retention", href: "/people/retention", label: "Retention" }] : []),
    ...(showLeads ? [{ key: "referrals", href: "/people/referrals", label: "Referrals" }] : []),
    { key: "showcases", href: "/people/showcases", label: "Showcases" },
    { key: "tasks", href: "/people/tasks", label: "Tasks" },
  ];
  return <Tabs tabs={tabs} current={current} />;
}
