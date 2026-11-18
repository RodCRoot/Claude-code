"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { assertCan } from "@/lib/authz/policy";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { loadTeamworkCatalog } from "@/lib/zenplanner/catalog";
import { RECON_FIELDS, saveReconciliation, type ReconKey } from "@/lib/zenplanner/reconcile";
import { saveVocabExtras, VOCAB_KEYS, type VocabKey } from "@/lib/zenplanner/vocab";
import { saveZpWebhookConfig, stageZpWebhookEvents } from "@/lib/zenplanner/webhooks";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

/** Owner only (checked again in loadTeamworkCatalog). Idempotent. */
export const loadCatalogAction = safeAction(async (_p: ActionState, _fd: FormData) => {
  void _fd;
  const v = await requireViewer();
  const r = await db.transaction((tx) => loadTeamworkCatalog(tx, v));
  revalidatePath("/imports/zenplanner");
  revalidatePath("/billing/products");
  return {
    ok: true,
    message: r.created.length
      ? `Created ${r.created.length} draft plan(s). They are inactive and unlisted until you confirm each one in Billing → Products.${r.existing.length ? ` ${r.existing.length} were already loaded.` : ""}`
      : `Nothing to do: all ${r.existing.length} catalog plans were already loaded.`,
  };
});

export const saveVocabAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  assertCan(v, "imports.manage");
  const key = str(fd, "key") as VocabKey;
  if (!VOCAB_KEYS.includes(key)) throw new UserError("Unknown list.");
  const values = str(fd, "values").split(/\r?\n/);
  const saved = await db.transaction((tx) => saveVocabExtras(tx, v, key, values));
  revalidatePath("/imports/zenplanner");
  return { ok: true, message: `Saved ${saved.length} extra value(s).` };
});

export const saveReconciliationAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  assertCan(v, "imports.manage");
  const entered: Partial<Record<ReconKey, number | null>> = {};
  const errors: Record<string, string> = {};
  for (const f of RECON_FIELDS) {
    const raw = str(fd, f.key).replace(/[$,\s]/g, "");
    if (!raw) {
      entered[f.key] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || (!f.money && !Number.isInteger(n))) errors[f.key] = f.money ? "Enter a dollar amount" : "Enter a whole number";
    else entered[f.key] = f.money ? Math.round(n * 100) : n;
  }
  if (Object.keys(errors).length) throw new UserError("Check the highlighted numbers.", errors);
  const batchId = str(fd, "batchId") || null;
  await db.transaction((tx) => saveReconciliation(tx, v, { batchId, asOf: str(fd, "asOf") || null, entered, note: str(fd, "note") || null }));
  revalidatePath("/imports/zenplanner/reconcile");
  redirect(`/imports/zenplanner/reconcile?saved=1${batchId ? `&batch=${batchId}` : ""}`);
});

export const saveWebhookConfigAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  assertCan(v, "integrations.manage");
  const perMinute = Number(str(fd, "perMinute") || "120");
  if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 6000) throw new UserError("Deliveries per minute must be a whole number from 1 to 6000.", { perMinute: "1 to 6000" });
  const cfg = await db.transaction((tx) =>
    saveZpWebhookConfig(tx, v, {
      enabled: fd.get("enabled") === "on",
      secretIn: str(fd, "secretIn") === "query" ? "query" : "header",
      secretName: str(fd, "secretName") || undefined,
      accountId: str(fd, "accountId") || null,
      perMinute,
    }),
  );
  revalidatePath("/settings/integrations");
  return { ok: true, message: cfg.enabled ? "Saved. The receiver is on." : "Saved. The receiver is off." };
});

export const stageWebhookAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  assertCan(v, "imports.manage");
  const r = await db.transaction((tx) => stageZpWebhookEvents(tx, v, str(fd, "feed")));
  revalidatePath("/settings/integrations");
  redirect(`/imports/${r.batchId}?flash=${encodeURIComponent(`Staged ${r.records} record(s) from ${r.events} webhook deliver${r.events === 1 ? "y" : "ies"}. Review and commit like any other import.`)}`);
});
