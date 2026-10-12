import { AppNav } from "@/components/app-nav";
import { requireViewer, getOrg } from "@/lib/auth/viewer";
import { logoutAction } from "@/lib/auth/actions";
import { navFor, ROLE_LABEL } from "@/lib/nav";
import { isDemoMode } from "@/lib/env";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { STAFF_ROLES } from "@/lib/auth/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer();
  if (viewer.role === "kiosk") redirect("/kiosk");
  const org = await getOrg(viewer.orgId);
  // Enforce staff MFA when the organization requires it.
  if (org?.settings?.requireStaffMfa && STAFF_ROLES.includes(viewer.role) && !(viewer as { mfaEnabled?: boolean }).mfaEnabled) {
    const path = (await headers()).get("x-pathname") ?? "";
    if (!path.startsWith("/settings/security")) redirect("/settings/security?required=1");
  }
  const brand = org?.branding?.primaryColor;
  return (
    <div className="lg:flex" style={brand ? ({ ["--brand" as string]: brand } as React.CSSProperties) : undefined}>
      <AppNav
        items={navFor(viewer.role).map(({ href, label, key }) => ({ href, label, key }))}
        orgName={org?.branding?.displayName ?? "Teamwork"}
        userName={viewer.displayName}
        roleLabel={ROLE_LABEL[viewer.role]}
        demo={isDemoMode() || !!org?.isDemo}
        logoutAction={logoutAction}
      />
      <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">{children}</div>
      </main>
    </div>
  );
}
