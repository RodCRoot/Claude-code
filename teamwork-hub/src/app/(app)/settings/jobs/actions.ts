"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { requireViewer } from "@/lib/auth/viewer";
import { runScheduledJobNow, SCHEDULED_JOBS } from "@/lib/scheduled/jobs";

/** Owner/admin: run one scheduled job for this organization now (authorization re-checked in runScheduledJobNow). */
export const runScheduledJobAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const type = String(fd.get("type") ?? "");
  if (!SCHEDULED_JOBS.some((j) => j.type === type && j.manual)) throw new UserError("Unknown scheduled job.");
  const results = await runScheduledJobNow(db, v, type);
  revalidatePath("/settings/jobs");
  const failed = results.filter((r) => r.status !== "done");
  if (failed.length) throw new UserError(`The job did not finish: ${(failed[0].error ?? "unknown error").slice(0, 200)}`);
  return { ok: true, message: "Done. The result is shown in the table." };
});
