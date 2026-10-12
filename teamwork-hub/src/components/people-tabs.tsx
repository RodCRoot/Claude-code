import { Tabs } from "./ui";

export function PeopleTabs({ current, showLeads = true }: { current: "directory" | "leads" | "tasks" | "new"; showLeads?: boolean }) {
  const tabs = [
    { key: "directory", href: "/people", label: "Directory" },
    ...(showLeads ? [{ key: "leads", href: "/people/leads", label: "Leads & pipeline" }] : []),
    { key: "tasks", href: "/people/tasks", label: "Tasks" },
  ];
  return <Tabs tabs={tabs} current={current} />;
}
