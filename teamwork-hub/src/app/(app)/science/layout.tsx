import { requireViewer } from "@/lib/auth/viewer";
import { isStaff } from "@/lib/authz/policy";
import { ScienceTabs } from "./_components/tabs";

export default async function ScienceLayout({ children }: { children: React.ReactNode }) {
  const v = await requireViewer();
  const staffTabs = [
    { href: "/science", label: "Overview" },
    { href: "/science/wellness", label: "Wellness" },
    { href: "/science/body-map", label: "Body map" },
    { href: "/science/habits", label: "Habits" },
    { href: "/science/kpis", label: "KPIs" },
    { href: "/science/load", label: "Load" },
    { href: "/science/volume", label: "Volume" },
    { href: "/science/wearables", label: "Wearables" },
    { href: "/science/force-plate", label: "Force plate" },
    { href: "/science/reports", label: "Reports" },
  ];
  const athleteTabs = [
    { href: "/science", label: "Today" },
    { href: "/science/wellness", label: "Check-in" },
    { href: "/science/body-map", label: "Body map" },
    { href: "/science/habits", label: "Habits" },
    { href: "/science/load", label: "Load" },
    { href: "/science/kpis", label: "Results" },
  ];
  const tabs = isStaff(v) ? staffTabs : v.role === "athlete" ? athleteTabs : [{ href: "/science", label: "Overview" }];
  return (
    <div>
      <ScienceTabs tabs={tabs} />
      {children}
    </div>
  );
}
