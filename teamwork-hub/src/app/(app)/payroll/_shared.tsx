import "server-only";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { getOrg, requireStaff } from "@/lib/auth/viewer";
import { canManagePayroll } from "@/lib/payroll/service";
import { DEFAULT_TZ } from "@/lib/time";
import { Tabs } from "@/components/ui";

/** Every payroll page: owner/admin, or operations explicitly granted access. */
export async function requirePayroll() {
  const v = await requireStaff();
  if (!(await canManagePayroll(db, v))) redirect("/denied");
  const tz = (await getOrg(v.orgId))?.timezone ?? DEFAULT_TZ;
  return { v, tz };
}

export function PayrollTabs({ current }: { current: string }) {
  return (
    <Tabs
      current={current}
      tabs={[
        { key: "run", href: "/payroll", label: "Calculate" },
        { key: "staff", href: "/payroll/staff", label: "Staff, rates & PINs" },
        { key: "import", href: "/payroll/import", label: "Import from Zen Planner" },
        { key: "settings", href: "/payroll/settings", label: "Settings" },
      ]}
    />
  );
}
