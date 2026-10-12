import { Tabs } from "@/components/ui";

export function ImportTabs({ current, canImport = true }: { current: "imports" | "hawkin" | "exports"; canImport?: boolean }) {
  const tabs = [
    ...(canImport
      ? [
          { key: "imports", href: "/imports", label: "Imports" },
          { key: "hawkin", href: "/imports/hawkin", label: "Hawkin API sync" },
        ]
      : []),
    { key: "exports", href: "/imports/exports", label: "Exports & backup" },
  ];
  return <Tabs tabs={tabs} current={current} />;
}

export function fmtStats(stats: Record<string, number>, keys: [string, string][]) {
  return keys
    .filter(([k]) => (stats[k] ?? 0) > 0)
    .map(([k, label]) => `${stats[k]} ${label}`)
    .join(" · ");
}
