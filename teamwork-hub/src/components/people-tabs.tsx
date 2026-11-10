import { Tabs } from "./ui";

export function PeopleTabs({ current, showLeads = true, showRequests = false }: { current: "directory" | "leads" | "tasks" | "requests" | "referrals" | "new"; showLeads?: boolean; showRequests?: boolean }) {
  const tabs = [
    { key: "directory", href: "/people", label: "Directory" },
    ...(showLeads ? [{ key: "leads", href: "/people/leads", label: "Leads & pipeline" }] : []),
    ...(showRequests ? [{ key: "requests", href: "/people/requests", label: "Member requests" }] : []),
    ...(showLeads ? [{ key: "referrals", href: "/people/referrals", label: "Referrals" }] : []),
    { key: "tasks", href: "/people/tasks", label: "Tasks" },
  ];
  return <Tabs tabs={tabs} current={current} />;
}
