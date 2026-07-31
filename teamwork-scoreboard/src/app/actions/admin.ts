"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  metrics,
  users,
  roles,
  taskTemplates,
  onboardingSteps,
  scorecardTemplates,
  scorecardMetrics,
  campaigns,
  marketingItems,
  contentThemes,
} from "@/db/schema";
import { requireUser, hashPassword } from "@/lib/auth";
import { setSetting } from "@/lib/settings";
import { ALL_PERMISSIONS } from "@/lib/permissions";

const now = () => new Date().toISOString();
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const opt = (fd: FormData, k: string) => str(fd, k) || null;
const int = (fd: FormData, k: string) => {
  const n = parseInt(str(fd, k), 10);
  return Number.isFinite(n) ? n : null;
};
const flt = (fd: FormData, k: string) => {
  const n = parseFloat(str(fd, k));
  return Number.isFinite(n) ? n : null;
};

/* --------------------------- Metrics --------------------------- */

export async function updateMetric(formData: FormData) {
  await requireUser("manage_metrics");
  const id = int(formData, "id");
  if (!id) return;
  db.update(metrics)
    .set({
      name: str(formData, "name") || undefined,
      definition: opt(formData, "definition"),
      formula: opt(formData, "formula"),
      sourceSystem: opt(formData, "sourceSystem"),
      sourceFields: opt(formData, "sourceFields"),
      dataOwner: opt(formData, "dataOwner"),
      frequency: str(formData, "frequency") || "weekly",
      unit: str(formData, "unit") || "count",
      direction: str(formData, "direction") === "down" ? "down" : "up",
      goal: flt(formData, "goal"),
      redBelowPct: flt(formData, "redBelowPct") ?? 70,
      yellowBelowPct: flt(formData, "yellowBelowPct") ?? 90,
      notes: opt(formData, "notes"),
      active: formData.get("active") === "0" ? 0 : 1,
      updatedAt: now(),
    })
    .where(eq(metrics.id, id))
    .run();
  revalidatePath("/scoreboard");
  revalidatePath("/admin/metrics");
}

/* ------------------------ Users & roles ------------------------ */

export async function addUser(formData: FormData) {
  await requireUser("manage_users");
  const email = str(formData, "email").toLowerCase();
  const name = str(formData, "name");
  const password = str(formData, "password");
  const roleId = int(formData, "roleId");
  if (!email || !name || !password || !roleId) return;
  db.insert(users)
    .values({
      name,
      email,
      passwordHash: hashPassword(password),
      roleId,
      title: opt(formData, "title"),
      active: 1,
      createdAt: now(),
    })
    .run();
  revalidatePath("/admin/users");
}

export async function updateUser(formData: FormData) {
  await requireUser("manage_users");
  const id = int(formData, "id");
  if (!id) return;
  const password = str(formData, "password");
  db.update(users)
    .set({
      name: str(formData, "name") || undefined,
      title: opt(formData, "title"),
      roleId: int(formData, "roleId") ?? undefined,
      active: formData.get("active") === "0" ? 0 : 1,
      ...(password ? { passwordHash: hashPassword(password) } : {}),
    })
    .where(eq(users.id, id))
    .run();
  revalidatePath("/admin/users");
}

export async function updateRolePermissions(formData: FormData) {
  await requireUser("manage_users");
  const id = int(formData, "roleId");
  if (!id) return;
  const perms = ALL_PERMISSIONS.filter((p) => formData.get(`perm_${p}`) === "on");
  db.update(roles).set({ permissions: JSON.stringify(perms) }).where(eq(roles.id, id)).run();
  revalidatePath("/admin/users");
}

export async function addRole(formData: FormData) {
  await requireUser("manage_users");
  const name = str(formData, "name");
  if (!name) return;
  db.insert(roles).values({ name, permissions: "[]", builtin: 0 }).run();
  revalidatePath("/admin/users");
}

/* --------------------------- Settings --------------------------- */

export async function saveSetting(formData: FormData) {
  await requireUser("manage_settings");
  const key = str(formData, "key");
  const raw = str(formData, "value");
  if (!key) return;
  let value: unknown = raw;
  const type = str(formData, "type");
  if (type === "number") value = parseFloat(raw);
  else if (type === "boolean") value = raw === "true" || raw === "on" || raw === "1";
  else if (type === "json") {
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
  }
  setSetting(key, value);
  revalidatePath("/admin");
  revalidatePath("/");
}

/* ------------------------ Task templates ------------------------ */

export async function upsertTaskTemplate(formData: FormData) {
  await requireUser("manage_tasks");
  const id = int(formData, "id");
  const values = {
    title: str(formData, "title"),
    description: opt(formData, "description"),
    category: str(formData, "category") || "operations",
    subcategory: opt(formData, "subcategory"),
    recurrence: str(formData, "recurrence") || "daily",
    dayOfWeek: int(formData, "dayOfWeek"),
    dayOfMonth: int(formData, "dayOfMonth"),
    assignedRole: opt(formData, "assignedRole"),
    assignedUserId: int(formData, "assignedUserId"),
    requiresApproval: formData.get("requiresApproval") === "on" ? 1 : 0,
    requiresProof: formData.get("requiresProof") === "on" ? 1 : 0,
    active: formData.get("active") === "0" ? 0 : 1,
    sortOrder: int(formData, "sortOrder") ?? 0,
  };
  if (!values.title) return;
  if (id) {
    db.update(taskTemplates).set(values).where(eq(taskTemplates.id, id)).run();
  } else {
    db.insert(taskTemplates).values(values).run();
  }
  revalidatePath("/admin/tasks");
  revalidatePath("/operations");
  revalidatePath("/facility");
}

export async function deleteTaskTemplate(formData: FormData) {
  await requireUser("manage_tasks");
  const id = int(formData, "id");
  if (!id) return;
  db.update(taskTemplates).set({ active: 0 }).where(eq(taskTemplates.id, id)).run();
  revalidatePath("/admin/tasks");
}

/* ---------------------- Onboarding steps ---------------------- */

export async function upsertOnboardingStep(formData: FormData) {
  await requireUser("manage_settings");
  const id = int(formData, "id");
  const values = {
    name: str(formData, "name"),
    description: opt(formData, "description"),
    dueOffsetDays: int(formData, "dueOffsetDays") ?? 7,
    sortOrder: int(formData, "sortOrder") ?? 0,
    active: formData.get("active") === "0" ? 0 : 1,
  };
  if (!values.name) return;
  if (id) {
    db.update(onboardingSteps).set(values).where(eq(onboardingSteps.id, id)).run();
  } else {
    db.insert(onboardingSteps).values(values).run();
  }
  revalidatePath("/admin/onboarding");
  revalidatePath("/onboarding");
}

/* --------------------- Scorecard templates --------------------- */

export async function upsertScorecardMetric(formData: FormData) {
  await requireUser("manage_metrics");
  const id = int(formData, "id");
  const templateId = int(formData, "templateId");
  const values = {
    name: str(formData, "name"),
    unit: str(formData, "unit") || "count",
    weeklyGoal: flt(formData, "weeklyGoal") ?? 0,
    direction: str(formData, "direction") === "down" ? "down" : "up",
    autoKey: opt(formData, "autoKey"),
    sortOrder: int(formData, "sortOrder") ?? 0,
    active: formData.get("active") === "0" ? 0 : 1,
  };
  if (!values.name) return;
  if (id) {
    db.update(scorecardMetrics).set(values).where(eq(scorecardMetrics.id, id)).run();
  } else if (templateId) {
    db.insert(scorecardMetrics).values({ ...values, templateId }).run();
  }
  revalidatePath("/admin/scorecards");
  revalidatePath("/team");
}

export async function addScorecardTemplate(formData: FormData) {
  await requireUser("manage_metrics");
  const roleName = str(formData, "roleName");
  if (!roleName) return;
  db.insert(scorecardTemplates).values({ roleName, active: 1 }).run();
  revalidatePath("/admin/scorecards");
  revalidatePath("/team");
}

/* --------------------------- Marketing --------------------------- */

export async function upsertCampaign(formData: FormData) {
  await requireUser("manage_marketing");
  const id = int(formData, "id");
  const values = {
    name: str(formData, "name"),
    audience: opt(formData, "audience"),
    startDate: opt(formData, "startDate"),
    endDate: opt(formData, "endDate"),
    goal: opt(formData, "goal"),
    status: str(formData, "status") || "planned",
    leadsGenerated: int(formData, "leadsGenerated") ?? 0,
    appointmentsBooked: int(formData, "appointmentsBooked") ?? 0,
    enrollments: int(formData, "enrollments") ?? 0,
    revenue: flt(formData, "revenue") ?? 0,
    notes: opt(formData, "notes"),
  };
  if (!values.name) return;
  if (id) {
    db.update(campaigns).set(values).where(eq(campaigns.id, id)).run();
  } else {
    db.insert(campaigns).values(values).run();
  }
  revalidatePath("/marketing");
}

export async function updateCampaignChecklist(formData: FormData) {
  await requireUser("manage_marketing");
  const id = int(formData, "id");
  const item = str(formData, "item");
  const value = str(formData, "value");
  if (!id || !item) return;
  const row = db.select().from(campaigns).where(eq(campaigns.id, id)).get();
  if (!row) return;
  let checklist: Record<string, string> = {};
  try {
    checklist = JSON.parse(row.checklist);
  } catch {}
  checklist[item] = value;
  db.update(campaigns)
    .set({ checklist: JSON.stringify(checklist) })
    .where(eq(campaigns.id, id))
    .run();
  revalidatePath("/marketing");
}

export async function upsertMarketingItem(formData: FormData) {
  await requireUser("manage_marketing");
  const id = int(formData, "id");
  const values = {
    pillar: str(formData, "pillar"),
    name: str(formData, "name"),
    month: str(formData, "month"),
    target: flt(formData, "target"),
    actual: flt(formData, "actual") ?? 0,
    unit: str(formData, "unit") || "count",
    status: str(formData, "status") || "planned",
    notes: opt(formData, "notes"),
    sortOrder: int(formData, "sortOrder") ?? 0,
  };
  if (id) {
    db.update(marketingItems).set(values).where(eq(marketingItems.id, id)).run();
  } else {
    if (!values.pillar || !values.name || !values.month) return;
    db.insert(marketingItems).values(values).run();
  }
  revalidatePath("/marketing");
}

export async function deleteMarketingItem(formData: FormData) {
  await requireUser("manage_marketing");
  const id = int(formData, "id");
  if (!id) return;
  db.delete(marketingItems).where(eq(marketingItems.id, id)).run();
  revalidatePath("/marketing");
}

export async function updateContentTheme(formData: FormData) {
  await requireUser("manage_marketing");
  const id = int(formData, "id");
  const theme = str(formData, "theme");
  if (!id || !theme) return;
  db.update(contentThemes).set({ theme }).where(eq(contentThemes.id, id)).run();
  revalidatePath("/marketing");
}
