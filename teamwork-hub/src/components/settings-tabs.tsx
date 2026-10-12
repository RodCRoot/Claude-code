import Link from "next/link";
import { Tabs } from "./ui";

export function SettingsTabs({ current }: { current: string }) {
  return (
    <>
      <Tabs
        current={current}
        tabs={[
          { key: "org", href: "/settings", label: "Organization & policies" },
          { key: "users", href: "/settings/users", label: "Users & roles" },
          { key: "custom-fields", href: "/settings/custom-fields", label: "Custom fields" },
          { key: "security", href: "/settings/security", label: "My security" },
          { key: "integrations", href: "/settings/integrations", label: "Integrations" },
          { key: "audit", href: "/settings/audit", label: "Audit log" },
        ]}
      />
      <p className="-mt-3 mb-5 text-xs text-ink-3">
        Module settings:{" "}
        {[
          ["/schedule/settings", "Schedule & policies"],
          ["/billing/products", "Products & prices"],
          ["/documents", "Form templates"],
          ["/messages", "Templates & automations"],
          ["/imports", "Import Center & exports"],
        ].map(([href, label], i) => (
          <span key={href}>
            {i ? " · " : ""}
            <Link href={href} className="underline">
              {label}
            </Link>
          </span>
        ))}
      </p>
    </>
  );
}
