import { Tabs } from "./ui";

export function PeopleTabs({ current, showLeads = true, showRequests = false }: { current: "directory" | "leads" | "tasks" | "requests" | "new"; showLeads?: boolean; showRequests?: boolean }) {
  const tabs = [
    { key: "directory", href: "/people", label: "Directory" },
    ...(showLeads ? [{ key: "leads", href: "/people/leads", label: "Leads & pipeline" }] : []),
    ...(showRequests ? [{ key: "requests", href: "/people/requests", label: "Member requests" }] : []),
    { key: "tasks", href: "/people/tasks", label: "Tasks" },
  ];
  return <Tabs tabs={tabs} current={current} />;
}
