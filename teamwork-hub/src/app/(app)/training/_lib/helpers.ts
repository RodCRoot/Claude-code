import "server-only";
import { notFound, redirect } from "next/navigation";
import { AuthzError, can, isStaff, type Viewer } from "@/lib/authz/policy";
import { TrainingError } from "@/lib/training/common";

/** Run page data loading; out-of-scope → /denied, missing → 404. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AuthzError) redirect("/denied");
    if (e instanceof TrainingError) notFound();
    throw e;
  }
}

export type TabKey = "overview" | "today" | "weight-room" | "review" | "athletes" | "programs" | "exercises" | "plan" | "reports" | "settings";

export function trainingTabs(v: Viewer) {
  if (v.role === "athlete") {
    return [
      { key: "today", href: "/training/today", label: "Today" },
      { key: "overview", href: "/training", label: "My training" },
    ];
  }
  if (!isStaff(v)) return [{ key: "overview", href: "/training", label: "Training" }];
  const tabs = [
    { key: "overview", href: "/training", label: "Overview" },
    { key: "weight-room", href: "/training/weight-room", label: "Weight room" },
    { key: "review", href: "/training/review", label: "Review" },
    { key: "athletes", href: "/training/athletes", label: "Athletes" },
    { key: "programs", href: "/training/programs", label: "Programs" },
    { key: "exercises", href: "/training/exercises", label: "Exercises" },
    { key: "plan", href: "/training/plan", label: "Annual plan" },
    { key: "reports", href: "/training/reports", label: "Reports" },
  ];
  if (can(v, "settings.manage")) tabs.push({ key: "settings", href: "/training/settings", label: "Settings" });
  if (!can(v, "training.manage")) return tabs.filter((t) => !["programs", "plan"].includes(t.key));
  return tabs;
}

export const sp = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
export const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
