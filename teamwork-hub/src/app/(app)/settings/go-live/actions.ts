"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { requireViewer } from "@/lib/auth/viewer";
import { UserError as DomainUserError } from "@/lib/billing/errors";
import { attest, withdrawAttestation } from "@/lib/golive/attestations";
import { checkStorage } from "@/lib/golive/storage-check";

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DomainUserError) throw new UserError(e.message, e.fieldErrors);
    throw e;
  }
}

/** Owner/admin: record a statement about something the hub cannot see (authorization re-checked in attest). */
export const attestAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  if (fd.get("agree") !== "on") throw new UserError("Tick the box to confirm the statement.", { agree: "Required" });
  await run(() => db.transaction((tx) => attest(tx, v, { key: String(fd.get("key") ?? ""), note: String(fd.get("note") ?? ""), on: String(fd.get("on") ?? "") })));
  revalidatePath("/settings/go-live");
  revalidatePath("/today");
  return { ok: true, message: "Recorded with your name and the date." };
});

export const withdrawAttestationAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await run(() => db.transaction((tx) => withdrawAttestation(tx, v, String(fd.get("key") ?? ""))));
  revalidatePath("/settings/go-live");
  revalidatePath("/today");
  return { ok: true, message: "Withdrawn." };
});

export const checkStorageAction = safeAction(async () => {
  const v = await requireViewer();
  const probe = await run(() => db.transaction((tx) => checkStorage(tx, v)));
  revalidatePath("/settings/go-live");
  revalidatePath("/settings/integrations");
  if (!probe.ok) throw new UserError("The storage check failed. Nothing was changed; check the bucket settings and try again.");
  return { ok: true, message: `A test file was written, read back and removed (${probe.backend === "s3" ? "bucket" : "local disk"}).` };
});
