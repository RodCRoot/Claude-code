import { AppNav } from "@/components/app-nav";
import { requireViewer, getOrg } from "@/lib/auth/viewer";
import { logoutAction } from "@/lib/auth/actions";
import { navFor, NAV_GROUP_LABEL, ROLE_LABEL } from "@/lib/nav";
import { isDemoMode } from "@/lib/env";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { STAFF_ROLES } from "@/lib/auth/session";
import { MFA_REQUIRED_REDIRECT, shouldRequireMfa } from "@/lib/auth/mfa-policy";
import { can } from "@/lib/authz/policy";
import { offlineOwnerKey } from "@/lib/training/offline";
import { TrainingOfflineGuard } from "@/components/training-offline";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer();
  if (viewer.role === "kiosk") redirect("/kiosk");
  const org = await getOrg(viewer.orgId);
  // Enforce staff MFA when the organization requires it (decision in src/lib/auth/mfa-policy.ts).
  if (shouldRequireMfa(viewer as { role: typeof viewer.role; mfaEnabled?: boolean }, org?.settings, (await headers()).get("x-pathname") ?? "")) redirect(MFA_REQUIRED_REDIRECT);
  const brand = org?.branding?.primaryColor;
  const staff = STAFF_ROLES.includes(viewer.role);
  // "+ New" menu: only shortcuts this role can actually use (each page re-checks access).
  const quickActions = staff
    ? [
        can(viewer, "people.manage") && { href: "/people/new", label: "Register athlete or family" },
        can(viewer, "crm.manage") && { href: "/people/leads/new", label: "New lead" },
        { href: "/schedule/book", label: "Book a session" },
        can(viewer, "billing.manage") && { href: "/billing/pos", label: "Point of sale" },
        { href: "/messages/new", label: "New message" },
      ].filter((a): a is { href: string; label: string } => !!a)
    : [];
  return (
    <div className="lg:flex" style={brand ? ({ ["--brand" as string]: brand } as React.CSSProperties) : undefined}>
      <AppNav
        items={navFor(viewer.role).map(({ href, label, key, icon, group }) => ({ href, label, key, icon, group }))}
        groupLabels={staff ? NAV_GROUP_LABEL : null}
        orgName={org?.branding?.displayName ?? "Teamwork"}
        userName={viewer.displayName}
        roleLabel={ROLE_LABEL[viewer.role]}
        demo={isDemoMode() || !!org?.isDemo}
        search={staff}
        quickActions={quickActions}
        logoutAction={logoutAction}
      />
      <TrainingOfflineGuard owner={offlineOwnerKey(viewer)} />
      <main id="main" className="min-w-0 flex-1 px-4 pt-[4.5rem] pb-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1400px]">{children}</div>
      </main>
    </div>
  );
}
