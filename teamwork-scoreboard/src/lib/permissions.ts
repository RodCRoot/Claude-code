/** Permission catalog. Roles store a JSON array of these keys. */
export const PERMISSIONS = {
  view_dashboard: "View dashboards and scoreboard",
  view_financials: "View financial KPIs and revenue detail",
  view_all_scorecards: "View every staff member's scorecard",
  submit_scorecard: "Submit own weekly scorecard and 5-15 report",
  review_reports: "Review and respond to staff 5-15 reports",
  manage_tasks: "Create/edit tasks and checklist templates",
  complete_tasks: "Complete assigned tasks and checklists",
  edit_records: "Add/edit leads, athletes, onboarding, appointments",
  manage_marketing: "Edit marketing plans and 3R tracker",
  manage_imports: "Run syncs and CSV/Sheets imports",
  manage_integrations: "Configure connectors and field mappings",
  override_values: "Manually override KPI values",
  manage_metrics: "Edit metric dictionary, goals, and thresholds",
  manage_users: "Manage users and roles",
  manage_settings: "Edit application settings",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const DEFAULT_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  "Owner/Admin": ALL_PERMISSIONS,
  Manager: [
    "view_dashboard",
    "view_all_scorecards",
    "submit_scorecard",
    "review_reports",
    "manage_tasks",
    "complete_tasks",
    "edit_records",
    "manage_marketing",
    "manage_imports",
    "override_values",
  ],
  Coach: ["view_dashboard", "submit_scorecard", "complete_tasks", "edit_records"],
  "Read-Only": ["view_dashboard"],
};

export function hasPermission(userPerms: string[], perm: Permission): boolean {
  return userPerms.includes(perm);
}
