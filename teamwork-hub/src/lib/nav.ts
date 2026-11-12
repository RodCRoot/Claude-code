import type { Role } from "@/db/schema";

import type { IconName } from "@/components/icons";

export type NavGroup = "front" | "members" | "coaching" | "business";
export type NavItem = { href: string; label: string; key: string; roles: Role[]; icon: IconName; group: NavGroup; /** Label families see when it differs from the staff term. */ familyLabel?: string };

/** Sidebar section headings (staff only; families see a flat list). */
export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  front: "Front desk",
  members: "Members",
  coaching: "Coaching",
  business: "Business",
};

const STAFF: Role[] = ["owner", "admin", "operations", "coach"];
const FAMILY: Role[] = ["guardian", "athlete"];
const ALL: Role[] = [...STAFF, ...FAMILY];

/** Single navigation definition. Each module page also enforces access server-side. */
export const NAV: NavItem[] = [
  { key: "today", href: "/today", label: "Dashboard", roles: ALL, icon: "today", group: "front" },
  { key: "schedule", href: "/schedule", label: "Calendar", roles: ALL, icon: "schedule", group: "front" },
  { key: "events", href: "/events", label: "Camps & clinics", roles: ["owner", "admin", "operations"], icon: "trophy", group: "front" },
  { key: "messages", href: "/messages", label: "Messages", roles: ALL, icon: "messages", group: "front" },
  { key: "follow-ups", href: "/follow-ups", label: "Follow-ups", roles: STAFF, icon: "today", group: "front" },
  { key: "people", href: "/people", label: "People", roles: ["owner", "admin", "operations", "coach"], icon: "people", group: "members" },
  { key: "billing", href: "/billing", label: "Memberships & Billing", familyLabel: "My Profile", roles: ["owner", "admin", "operations", "guardian", "athlete"], icon: "billing", group: "members" },
  { key: "documents", href: "/documents", label: "Documents", roles: ALL, icon: "documents", group: "members" },
  { key: "shop", href: "/shop", label: "Shop", roles: FAMILY, icon: "shop", group: "members" },
  { key: "refer", href: "/refer", label: "Refer a friend", roles: FAMILY, icon: "gift", group: "members" },
  { key: "training", href: "/training", label: "Training", roles: ALL, icon: "training", group: "coaching" },
  { key: "science", href: "/science", label: "Sports Science", roles: ALL, icon: "science", group: "coaching" },
  { key: "performance", href: "/performance", label: "Performance", roles: ALL, icon: "performance", group: "coaching" },
  { key: "anywhere", href: "/anywhere", label: "On Your Own", roles: FAMILY, icon: "anywhere", group: "coaching" },
  { key: "goals", href: "/goals", label: "Goals", roles: FAMILY, icon: "goals", group: "coaching" },
  { key: "showcase", href: "/showcase", label: "Showcase", roles: FAMILY, icon: "showcase", group: "coaching" },
  { key: "leaderboards", href: "/leaderboards", label: "Leaderboards", roles: ALL, icon: "trophy", group: "coaching" },
  { key: "reports", href: "/reports", label: "Reports", roles: ["owner", "admin", "operations", "coach"], icon: "reports", group: "business" },
  { key: "payroll", href: "/payroll", label: "Payroll", roles: ["owner", "admin"], icon: "payroll", group: "business" },
  { key: "imports", href: "/imports", label: "Imports", roles: ["owner", "admin"], icon: "imports", group: "business" },
  { key: "settings", href: "/settings", label: "Settings", roles: ["owner", "admin"], icon: "settings", group: "business" },
];

export function navFor(role: Role) {
  const family = FAMILY.includes(role);
  return NAV.filter((n) => n.roles.includes(role)).map((n) => (family && n.familyLabel ? { ...n, label: n.familyLabel } : n));
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  operations: "Operations",
  coach: "Coach",
  guardian: "Parent / Guardian",
  athlete: "Athlete",
  kiosk: "Kiosk",
};
