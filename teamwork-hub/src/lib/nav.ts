import type { Role } from "@/db/schema";

export type NavItem = { href: string; label: string; key: string; roles: Role[] };

const STAFF: Role[] = ["owner", "admin", "operations", "coach"];
const FAMILY: Role[] = ["guardian", "athlete"];
const ALL: Role[] = [...STAFF, ...FAMILY];

/** Single navigation definition. Each module page also enforces access server-side. */
export const NAV: NavItem[] = [
  { key: "today", href: "/today", label: "Today", roles: ALL },
  { key: "people", href: "/people", label: "People", roles: ["owner", "admin", "operations", "coach"] },
  { key: "schedule", href: "/schedule", label: "Schedule", roles: ALL },
  { key: "billing", href: "/billing", label: "Memberships & Billing", roles: ["owner", "admin", "operations", "guardian", "athlete"] },
  { key: "training", href: "/training", label: "Training", roles: ALL },
  { key: "science", href: "/science", label: "Sports Science", roles: ALL },
  { key: "performance", href: "/performance", label: "Performance", roles: ALL },
  { key: "messages", href: "/messages", label: "Messages", roles: ALL },
  { key: "documents", href: "/documents", label: "Documents", roles: ALL },
  { key: "reports", href: "/reports", label: "Reports", roles: ["owner", "admin", "operations", "coach"] },
  { key: "settings", href: "/settings", label: "Settings", roles: ["owner", "admin"] },
];

export function navFor(role: Role) {
  return NAV.filter((n) => n.roles.includes(role));
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
