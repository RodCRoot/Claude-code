import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db";
import { goLiveAttestations, organizations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { UserError } from "@/lib/billing/errors";
import { todayLocal } from "@/lib/time";
import { OPEN_DECISIONS, decisionKey } from "./decisions";

/**
 * The only things a person may tick on the go-live page. Each is something the hub has no way to
 * observe. Anything the system can verify (keys, webhooks, two-step verification, sample wording,
 * imports) is deliberately absent: there is no key for it, so it cannot be ticked.
 */
export type AttestationDef = { key: string; label: string; statement: string; needsNote: boolean; noteHint: string };

export const ATTESTATIONS: AttestationDef[] = [
  {
    key: "backups_rehearsed",
    label: "A database restore has been rehearsed",
    statement: "I restored a backup of the production database into a scratch database and checked it, following docs/BACKUP-RESTORE.md.",
    needsNote: true,
    noteHint: "Which backup was restored, and what you checked.",
  },
  {
    key: "error_reporting_skipped",
    label: "Going live without error reporting",
    statement: "I have decided to go live without an error reporting service. Problems will only show in the server logs.",
    needsNote: false,
    noteHint: "Optional: why.",
  },
  {
    key: "sms_not_used",
    label: "Text messages are not used",
    statement: "The gym will not send text messages from the hub.",
    needsNote: false,
    noteHint: "Optional.",
  },
  {
    key: "messaging_rules_reviewed",
    label: "Quiet hours and consent settings reviewed",
    statement: "I have read the quiet hours and the consent and opt-out settings and they are what the gym wants.",
    needsNote: false,
    noteHint: "Optional.",
  },
];

const DEF_BY_KEY = new Map(ATTESTATIONS.map((a) => [a.key, a]));
const DECISION_BY_KEY = new Map(OPEN_DECISIONS.map((d) => [decisionKey(d.id), d]));

export type Attestation = { key: string; byName: string; on: string; note: string | null; valueSnapshot: string | null };

export async function liveAttestations(tx: Tx, orgId: string): Promise<Map<string, Attestation>> {
  const rows = await tx
    .select()
    .from(goLiveAttestations)
    .where(and(eq(goLiveAttestations.orgId, orgId), isNull(goLiveAttestations.withdrawnAt)));
  return new Map(rows.map((r) => [r.key, { key: r.key, byName: r.attestedByName, on: r.attestedOn, note: r.note, valueSnapshot: r.valueSnapshot ?? null }]));
}

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

/**
 * Record (or replace) a statement by the signed-in owner or admin. Decisions store the setting
 * value being confirmed. Audited. Unknown keys are refused, which is what keeps system-verifiable
 * items from ever being ticked by hand.
 */
export async function attest(tx: Tx, v: Viewer, input: { key: string; note?: string | null; on?: string | null }, opts: { today?: string } = {}) {
  assertCan(v, "settings.manage");
  const def = DEF_BY_KEY.get(input.key);
  const decision = DECISION_BY_KEY.get(input.key);
  if (!def && !decision) throw new UserError("That item is checked by the system and cannot be ticked by hand.");
  const today = opts.today ?? todayLocal();
  const on = input.on && /^\d{4}-\d{2}-\d{2}$/.test(input.on) ? input.on : today;
  if (on > today) throw new UserError("The date cannot be in the future.", { on: "Today or earlier" });
  const note = (input.note ?? "").trim().slice(0, 500) || null;
  if (def?.needsNote && !note) throw new UserError("Add a short note saying what was done.", { note: "Required" });

  const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const valueSnapshot = decision ? decision.value(org?.settings ?? null) : null;
  await tx
    .update(goLiveAttestations)
    .set({ withdrawnAt: new Date(), withdrawnByUserId: v.userId })
    .where(and(eq(goLiveAttestations.orgId, v.orgId), eq(goLiveAttestations.key, input.key), isNull(goLiveAttestations.withdrawnAt)));
  const [row] = await tx
    .insert(goLiveAttestations)
    .values({ orgId: v.orgId, key: input.key, attestedByUserId: v.userId, attestedByName: v.displayName, attestedOn: on, note, valueSnapshot })
    .returning();
  await audit(tx, actor(v), decision ? "golive.decision_confirmed" : "golive.attested", "go_live_attestation", row.id, {
    summary: decision ? `Confirmed as is: ${decision.question} (${valueSnapshot})` : `Attested: ${def!.label}`,
    after: { key: input.key, attestedOn: on, note, valueSnapshot },
  });
  return row;
}

export async function withdrawAttestation(tx: Tx, v: Viewer, key: string) {
  assertCan(v, "settings.manage");
  const rows = await tx
    .update(goLiveAttestations)
    .set({ withdrawnAt: new Date(), withdrawnByUserId: v.userId })
    .where(and(eq(goLiveAttestations.orgId, v.orgId), eq(goLiveAttestations.key, key), isNull(goLiveAttestations.withdrawnAt)))
    .returning();
  if (!rows.length) throw new UserError("There is nothing to withdraw.");
  await audit(tx, actor(v), "golive.attestation_withdrawn", "go_live_attestation", rows[0].id, {
    summary: `Withdrew: ${DEF_BY_KEY.get(key)?.label ?? DECISION_BY_KEY.get(key)?.question ?? key}`,
    before: { key, attestedOn: rows[0].attestedOn, attestedByName: rows[0].attestedByName },
  });
}
