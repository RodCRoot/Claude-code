"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { runSync } from "@/lib/connectors";

export async function runSyncNow(formData: FormData) {
  await requireUser("manage_imports");
  const key = String(formData.get("connectorKey") ?? "");
  if (!key) return;
  await runSync(key, "manual");
  revalidatePath("/data");
  revalidatePath("/");
}
