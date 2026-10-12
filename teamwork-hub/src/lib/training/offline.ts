import "server-only";
import { createHmac } from "node:crypto";
import type { Tx } from "@/db";
import { accessibleAthleteIds, type Viewer } from "@/lib/authz/policy";
import { env } from "@/lib/env";
import { todayLocal } from "@/lib/time";
import { workoutsForDate } from "./dashboard";
import type { WorkoutDetail } from "./logging";

/**
 * Offline copy of the athlete logger ("today" page, service worker).
 *
 * Only an athlete signing in as themself gets an offline copy, and it holds only what is needed to
 * log today's sets: their own workouts for today (ids, titles, exercise names, prescriptions,
 * resolved loads, already-logged sets). No athlete names (not even their own), no coach feedback,
 * no other athletes, no substitution catalogue. Weight-room / coach / guardian sessions never get one.
 */
export const OFFLINE_PAYLOAD_VERSION = 1;

/** Opaque per-user key the service worker uses to tell users apart (HMAC of the user id; not reversible). */
export function offlineOwnerKey(v: Viewer): string | null {
  if (v.role !== "athlete") return null;
  return createHmac("sha256", env().SESSION_SECRET).update(`training-offline:${v.orgId}:${v.userId}`).digest("hex").slice(0, 32);
}

export type OfflineItem = Pick<WorkoutDetail["items"][number], "id" | "blockLabel" | "notes" | "athleteModification" | "performed" | "substituted" | "groups" | "sets" | "logs"> & {
  exercise: Pick<WorkoutDetail["items"][number]["exercise"], "id" | "name" | "coachingNotes" | "videoUrl">;
};
export type OfflineWorkout = Pick<WorkoutDetail, "id" | "title" | "status" | "scheduledDate" | "sessionRpe" | "durationMinutes" | "athleteComment"> & { items: OfflineItem[] };
export type OfflineTodayPayload = { v: number; owner: string; date: string; generatedAt: string; workouts: OfflineWorkout[] };

export async function offlineTodayPayload(tx: Tx, v: Viewer, date = todayLocal()): Promise<OfflineTodayPayload | null> {
  const owner = offlineOwnerKey(v);
  if (!owner) return null;
  const scope = await accessibleAthleteIds(tx, v, "training.log");
  const self = scope === "all" ? [] : scope; // athletes never get "all"; be strict anyway
  const list = self.length ? await workoutsForDate(tx, v, date, { athleteIds: self }) : [];
  return {
    v: OFFLINE_PAYLOAD_VERSION,
    owner,
    date,
    generatedAt: new Date().toISOString(),
    workouts: list
      .filter((w) => self.includes(w.athleteId))
      .map((w) => ({
        id: w.id,
        title: w.title,
        status: w.status,
        scheduledDate: w.scheduledDate,
        sessionRpe: w.sessionRpe,
        durationMinutes: w.durationMinutes,
        athleteComment: w.athleteComment,
        items: w.items.map((i) => ({
          id: i.id,
          blockLabel: i.blockLabel,
          notes: i.notes,
          athleteModification: i.athleteModification,
          exercise: { id: i.exercise.id, name: i.exercise.name, coachingNotes: i.exercise.coachingNotes, videoUrl: i.exercise.videoUrl },
          performed: i.performed,
          substituted: i.substituted,
          groups: i.groups,
          sets: i.sets,
          logs: i.logs,
        })),
      })),
  };
}
