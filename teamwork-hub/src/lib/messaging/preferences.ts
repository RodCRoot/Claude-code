import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { athletes, commConsentEvents, commPreferences, guardianships, people, undeliverableAddresses, users, type ConsentState } from "@/db/schema";
import { audit } from "@/lib/audit";
import { AuthzError, assertCan, type Viewer } from "@/lib/authz/policy";
import { todayLocal } from "@/lib/time";
import { normalizeAddress } from "./addresses";
import { DomainError } from "./errors";
import { parseQuietHours, type QuietHours } from "./quiet-hours";
import { ageOn, messagingSettings } from "./routing";

export type ExternalChannel = "email" | "sms";
export const EXTERNAL_CHANNELS: ExternalChannel[] = ["email", "sms"];

/** Where a consent change came from (stored on every history row). */
export type ConsentSource = "family_portal" | "staff" | "sms_keyword" | "email_complaint" | "inquiry_form" | "lead_conversion" | "seed";

export const SOURCE_LABEL: Record<string, string> = {
  family_portal: "Family portal",
  staff: "Recorded by staff",
  sms_keyword: "SMS keyword reply",
  email_complaint: "Email spam complaint",
  inquiry_form: "Inquiry form",
  lead_conversion: "Lead conversion",
  seed: "Demo data",
  backfill: "Recorded before history existed",
};

type Actor = { actorUserId?: string | null; actorRole?: string | null };

/** Appends a history row only (callers that insert the preference row themselves, e.g. intake). */
export async function logConsentEvent(
  tx: Tx,
  e: { orgId: string; personId: string; channel: ExternalChannel; consent: ConsentState; previous?: ConsentState | null; source: ConsentSource; detail?: string | null; actorUserId?: string | null; now?: Date },
) {
  await tx.insert(commConsentEvents).values({
    orgId: e.orgId,
    personId: e.personId,
    channel: e.channel,
    kind: "consent",
    consent: e.consent,
    previousConsent: e.previous ?? null,
    source: e.source,
    detail: e.detail ?? null,
    actorUserId: e.actorUserId ?? null,
    createdAt: e.now ?? new Date(),
  });
}

/**
 * Sets one person's consent on one channel, with history (source + timestamp) and an audit
 * event. No-op (no history row) when the consent is unchanged.
 */
export async function recordConsent(
  tx: Tx,
  input: { orgId: string; personId: string; channel: ExternalChannel; consent: ConsentState; source: ConsentSource; detail?: string | null; now?: Date } & Actor,
): Promise<{ changed: boolean; previous: ConsentState | null }> {
  const now = input.now ?? new Date();
  const [cur] = await tx
    .select()
    .from(commPreferences)
    .where(and(eq(commPreferences.personId, input.personId), eq(commPreferences.channel, input.channel), eq(commPreferences.orgId, input.orgId)))
    .for("update");
  const previous = cur?.consent ?? null;
  if (previous === input.consent) return { changed: false, previous };
  const sourceText = `${SOURCE_LABEL[input.source] ?? input.source}${input.detail ? ` — ${input.detail}` : ""}`.slice(0, 300);
  if (cur) {
    await tx.update(commPreferences).set({ consent: input.consent, consentSource: sourceText, capturedAt: now }).where(eq(commPreferences.id, cur.id));
  } else {
    await tx.insert(commPreferences).values({ orgId: input.orgId, personId: input.personId, channel: input.channel, consent: input.consent, consentSource: sourceText, capturedAt: now });
  }
  await logConsentEvent(tx, { ...input, previous, now });
  await audit(tx, { orgId: input.orgId, actorUserId: input.actorUserId ?? null, actorRole: input.actorRole ?? (input.actorUserId ? null : "system") }, "messaging.consent_changed", "person", input.personId, {
    summary: `${input.channel.toUpperCase()} consent ${previous ?? "unknown"} → ${input.consent} (${sourceText})`,
    before: { channel: input.channel, consent: previous },
    after: { channel: input.channel, consent: input.consent, source: input.source },
  });
  return { changed: true, previous };
}

/** Sets (or clears, with null) a person's personal quiet-hours window on both external channels. */
export async function recordQuietHours(
  tx: Tx,
  input: { orgId: string; personId: string; window: QuietHours | null; source: ConsentSource; detail?: string | null; now?: Date } & Actor,
): Promise<{ changed: boolean }> {
  const now = input.now ?? new Date();
  const rows = await tx
    .select()
    .from(commPreferences)
    .where(and(eq(commPreferences.personId, input.personId), eq(commPreferences.orgId, input.orgId)))
    .for("update");
  const fmtW = (s: string | null, e: string | null) => (s && e ? `${s.slice(0, 5)}–${e.slice(0, 5)}` : "facility default");
  const want = input.window ? fmtW(input.window.start, input.window.end) : "facility default";
  let changed = false;
  let before = "facility default";
  for (const ch of EXTERNAL_CHANNELS) {
    const cur = rows.find((r) => r.channel === ch);
    const had = cur ? fmtW(cur.quietStartLocal, cur.quietEndLocal) : "facility default";
    if (ch === "email") before = had;
    if (had === want) continue;
    changed = true;
    const vals = { quietStartLocal: input.window?.start ?? null, quietEndLocal: input.window?.end ?? null };
    if (cur) await tx.update(commPreferences).set(vals).where(eq(commPreferences.id, cur.id));
    else await tx.insert(commPreferences).values({ orgId: input.orgId, personId: input.personId, channel: ch, consent: "unknown", ...vals });
    await tx.insert(commConsentEvents).values({
      orgId: input.orgId,
      personId: input.personId,
      channel: ch,
      kind: "quiet_hours",
      consent: cur?.consent ?? "unknown",
      quietStartLocal: vals.quietStartLocal,
      quietEndLocal: vals.quietEndLocal,
      source: input.source,
      detail: input.detail ?? null,
      actorUserId: input.actorUserId ?? null,
      createdAt: now,
    });
  }
  if (changed) {
    await audit(tx, { orgId: input.orgId, actorUserId: input.actorUserId ?? null, actorRole: input.actorRole ?? null }, "messaging.quiet_hours_changed", "person", input.personId, {
      summary: `Quiet hours ${before} → ${want}`,
      before: { quietHours: before },
      after: { quietHours: want, source: input.source },
    });
  }
  return { changed };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type PreferencesView = Awaited<ReturnType<typeof preferencesView>>;

async function preferencesView(tx: Tx, orgId: string, personId: string) {
  const [p] = await tx
    .select({ id: people.id, first: people.firstName, last: people.lastName, email: people.email, phone: people.phone })
    .from(people)
    .where(and(eq(people.id, personId), eq(people.orgId, orgId)));
  if (!p) throw new DomainError("Person not found.");
  const prefs = await tx.select().from(commPreferences).where(and(eq(commPreferences.personId, personId), eq(commPreferences.orgId, orgId)));
  const s = await messagingSettings(tx, orgId);
  const pref = (ch: ExternalChannel) => prefs.find((x) => x.channel === ch) ?? null;
  const qSrc = pref("email") ?? pref("sms");
  const personal = qSrc?.quietStartLocal && qSrc?.quietEndLocal ? parseQuietHours({ start: qSrc.quietStartLocal, end: qSrc.quietEndLocal }) : null;
  const addresses = [normalizeAddress("email", p.email), normalizeAddress("sms", p.phone)].filter((a): a is string => !!a);
  const flagged = addresses.length
    ? await tx
        .select()
        .from(undeliverableAddresses)
        .where(and(eq(undeliverableAddresses.orgId, orgId), isNull(undeliverableAddresses.clearedAt), inArray(undeliverableAddresses.address, addresses)))
    : [];
  const history = await tx
    .select({ e: commConsentEvents, actor: users.displayName })
    .from(commConsentEvents)
    .leftJoin(users, eq(users.id, commConsentEvents.actorUserId))
    .where(and(eq(commConsentEvents.personId, personId), eq(commConsentEvents.orgId, orgId)))
    .orderBy(desc(commConsentEvents.createdAt))
    .limit(100);
  return {
    person: { id: p.id, name: `${p.first} ${p.last}`, email: p.email, phone: p.phone },
    email: pref("email"),
    sms: pref("sms"),
    quietHours: personal,
    facilityQuietHours: s.quietHours,
    undeliverable: flagged,
    // A quiet-hours change writes one row per channel; show it once.
    history: history.filter((h) => h.e.kind === "consent" || h.e.channel === "email").map((h) => ({ ...h.e, actorName: h.actor })),
  };
}

/**
 * Guardians and adult athletes manage their own preferences. Minor athletes do not (their
 * guardians receive messages about them).
 */
export async function canManageOwnPreferences(tx: Tx, v: Viewer): Promise<{ ok: boolean; reason: string | null }> {
  if (!v.personId || (v.role !== "guardian" && v.role !== "athlete")) return { ok: false, reason: "Only family accounts manage communication preferences here." };
  if (v.role === "guardian") return { ok: true, reason: null };
  const [a] = await tx
    .select({ id: athletes.id, dob: people.dateOfBirth })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.personId, v.personId), eq(athletes.orgId, v.orgId)));
  if (!a) return { ok: true, reason: null };
  const s = await messagingSettings(tx, v.orgId);
  if (a.dob) {
    if (ageOn(a.dob, todayLocal(s.timezone)) >= 18) return { ok: true, reason: null };
  } else {
    const g = await tx
      .select({ id: guardianships.id })
      .from(guardianships)
      .where(and(eq(guardianships.athleteId, a.id), eq(guardianships.status, "active")))
      .limit(1);
    if (!g.length) return { ok: true, reason: null };
  }
  return { ok: false, reason: "Your parent or guardian manages communication preferences for your account." };
}

export async function myPreferences(tx: Tx, v: Viewer) {
  const access = await canManageOwnPreferences(tx, v);
  if (!v.personId) throw new AuthzError();
  return { ...(await preferencesView(tx, v.orgId, v.personId)), editable: access.ok, notEditableReason: access.reason };
}

const choice = z.preprocess((x) => (x === "" || x == null ? undefined : x), z.enum(["opted_in", "opted_out"]).optional());
const hm = z.preprocess((x) => (x === "" || x == null ? undefined : x), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM").optional());
const prefsSchema = z.object({
  email: choice,
  sms: choice,
  quietMode: z.enum(["facility", "custom"]).default("facility"),
  quietStart: hm,
  quietEnd: hm,
});

/** The signed-in guardian / adult athlete updates their own consent and quiet hours. */
export async function updateMyPreferences(tx: Tx, v: Viewer, input: z.input<typeof prefsSchema>, now = new Date()) {
  const access = await canManageOwnPreferences(tx, v);
  if (!access.ok || !v.personId) throw new AuthzError(access.reason ?? undefined);
  const d = prefsSchema.parse(input);
  const [p] = await tx.select({ email: people.email, phone: people.phone }).from(people).where(and(eq(people.id, v.personId), eq(people.orgId, v.orgId)));
  if (!p) throw new AuthzError();
  if (d.email === "opted_in" && !p.email) throw new DomainError("There is no email address on your profile. Ask the front desk to add one, then opt in.", { email: "No email on file" });
  if (d.sms === "opted_in" && !p.phone) throw new DomainError("There is no mobile number on your profile. Ask the front desk to add one, then opt in to texts.", { sms: "No mobile number on file" });
  let window: QuietHours | null = null;
  if (d.quietMode === "custom") {
    window = parseQuietHours({ start: d.quietStart, end: d.quietEnd });
    if (!window) throw new DomainError("Choose a start and end time for your quiet hours (they must differ).", { quietStart: "Required" });
  }
  const actor = { actorUserId: v.userId, actorRole: v.role };
  const changes: string[] = [];
  for (const ch of EXTERNAL_CHANNELS) {
    const want = d[ch];
    if (!want) continue;
    const r = await recordConsent(tx, { orgId: v.orgId, personId: v.personId, channel: ch, consent: want, source: "family_portal", now, ...actor });
    if (r.changed) changes.push(`${ch === "email" ? "Email" : "Text messages"}: ${want === "opted_in" ? "on" : "off"}`);
  }
  const q = await recordQuietHours(tx, { orgId: v.orgId, personId: v.personId, window, source: "family_portal", now, ...actor });
  if (q.changed) changes.push(`Quiet hours: ${window ? `${window.start}–${window.end}` : "facility default"}`);
  return { changes };
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

/** Staff (crm.manage) view of a person's current consent, undeliverable flags and full history. */
export async function staffConsentView(tx: Tx, v: Viewer, personId: string) {
  assertCan(v, "crm.manage");
  if (!z.string().uuid().safeParse(personId).success) throw new DomainError("Person not found.");
  return preferencesView(tx, v.orgId, personId);
}

const staffSchema = z.object({
  personId: z.string().uuid(),
  channel: z.enum(["email", "sms"]),
  consent: z.enum(["opted_in", "opted_out"]),
  note: z.string().trim().min(3, "Say how the family told you (e.g. phone call on 3/2)").max(300),
});

/** Staff record a consent change the family gave them directly (phone, paper form). */
export async function staffRecordConsent(tx: Tx, v: Viewer, input: z.input<typeof staffSchema>, now = new Date()) {
  assertCan(v, "crm.manage");
  const d = staffSchema.parse(input);
  const [p] = await tx.select({ id: people.id }).from(people).where(and(eq(people.id, d.personId), eq(people.orgId, v.orgId)));
  if (!p) throw new DomainError("Person not found.");
  return recordConsent(tx, { orgId: v.orgId, personId: d.personId, channel: d.channel, consent: d.consent, source: "staff", detail: d.note, now, actorUserId: v.userId, actorRole: v.role });
}

/** Staff clear an undeliverable flag after the family fixed their address. */
export async function clearUndeliverable(tx: Tx, v: Viewer, id: string, now = new Date()) {
  assertCan(v, "crm.manage");
  if (!z.string().uuid().safeParse(id).success) throw new DomainError("Not found.");
  const [u] = await tx
    .select()
    .from(undeliverableAddresses)
    .where(and(eq(undeliverableAddresses.id, id), eq(undeliverableAddresses.orgId, v.orgId), isNull(undeliverableAddresses.clearedAt)))
    .for("update");
  if (!u) throw new DomainError("This address is not flagged.");
  await tx.update(undeliverableAddresses).set({ clearedAt: now, clearedByUserId: v.userId }).where(eq(undeliverableAddresses.id, u.id));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "messaging.undeliverable_cleared", "undeliverable_address", u.id, {
    summary: `Cleared ${u.reason.replace("_", " ")} flag on ${u.channel} address`,
    before: { reason: u.reason, provider: u.provider },
  });
}
