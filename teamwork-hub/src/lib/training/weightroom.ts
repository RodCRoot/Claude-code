import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { groupMembers, groups, workouts } from "@/db/schema";
import { accessibleAthleteIds, AuthzError, isStaff, type Viewer } from "@/lib/authz/policy";
import { athleteNames, TrainingError } from "./common";
import { workoutProgress, workoutsWithItems } from "./logging";
import { manageableGroupIds } from "./assignments";

/**
 * Weight-room tablet roster: athletes in a group that the viewer may log for (coaches:
 * their assigned athletes only; owner/admin: all). Operations may view read-only.
 * Returns only names + workout data — no contact, health, or billing fields.
 */
export async function weightRoomRoster(tx: Tx, v: Viewer, groupId: string, date: string) {
  if (!isStaff(v)) throw new AuthzError();
  const [g] = await tx.select().from(groups).where(and(eq(groups.id, groupId), eq(groups.orgId, v.orgId)));
  if (!g) throw new TrainingError("Group not found.");
  const okGroups = await manageableGroupIds(tx, v);
  if (okGroups !== "all" && !okGroups.includes(groupId)) throw new AuthzError("You can only open the weight room for groups you coach.");
  const logScope = await accessibleAthleteIds(tx, v, "training.log");
  const readScope = await accessibleAthleteIds(tx, v, "training.read");
  const members = (await tx.select({ id: groupMembers.athleteId }).from(groupMembers).where(eq(groupMembers.groupId, groupId))).map((m) => m.id);
  const visible = members.filter((id) => readScope === "all" || readScope.includes(id));
  const names = await athleteNames(tx, v.orgId, visible);
  const ws = visible.length
    ? await tx.select().from(workouts).where(and(eq(workouts.orgId, v.orgId), eq(workouts.scheduledDate, date), inArray(workouts.athleteId, visible)))
    : [];
  const full = await workoutsWithItems(tx, v.orgId, ws);
  return {
    group: { id: g.id, name: g.name },
    canLog: logScope === "all" || logScope.length > 0,
    athletes: visible
      .map((id) => {
        const w = full.find((x) => x.athleteId === id) ?? null;
        return {
          athleteId: id,
          name: names.get(id) ?? "Athlete",
          canLog: logScope === "all" || logScope.includes(id),
          workout: w ? { id: w.id, title: w.title, status: w.status, progress: workoutProgress(w) } : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
