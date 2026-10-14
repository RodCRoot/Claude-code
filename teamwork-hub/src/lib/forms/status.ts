import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, formRequests, formTemplates, formTemplateVersions, people } from "@/db/schema";

/**
 * Per-athlete, per-template form state at an instant.
 * Priority: a valid (completed, unexpired) request wins; otherwise an open request
 * (pending / partially_signed); otherwise "expired" if anything was ever completed;
 * otherwise "missing". Expiry is time-based (completed_at + renewal period), so the
 * answer is correct even before the renewal sweep flips status to "expired".
 */
export type FormState = "valid" | "pending" | "partially_signed" | "expired" | "missing";

export type FormStatusItem = {
  templateId: string;
  templateName: string;
  state: FormState;
  requestId: string | null;
  dueDate: string | null;
  expiresAt: Date | null;
};

export async function athleteFormStatus(
  tx: Tx,
  orgId: string,
  athleteIds: string[],
  templates: { id: string; name: string }[],
  at: Date = new Date(),
): Promise<Map<string, FormStatusItem[]>> {
  const out = new Map<string, FormStatusItem[]>();
  if (!athleteIds.length || !templates.length) {
    for (const a of athleteIds) out.set(a, templates.map((t) => blank(t)));
    return out;
  }
  const rows = await tx
    .select({
      id: formRequests.id,
      athleteId: formRequests.athleteId,
      status: formRequests.status,
      dueDate: formRequests.dueDate,
      expiresAt: formRequests.expiresAt,
      completedAt: formRequests.completedAt,
      templateId: formTemplateVersions.templateId,
    })
    .from(formRequests)
    .innerJoin(formTemplateVersions, eq(formTemplateVersions.id, formRequests.templateVersionId))
    .where(
      and(
        eq(formRequests.orgId, orgId),
        inArray(formRequests.athleteId, athleteIds),
        inArray(
          formTemplateVersions.templateId,
          templates.map((t) => t.id),
        ),
      ),
    )
    .orderBy(desc(formRequests.createdAt));

  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.athleteId}:${r.templateId}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }
  for (const a of athleteIds) {
    out.set(
      a,
      templates.map((t) => {
        const rs = byKey.get(`${a}:${t.id}`) ?? [];
        const valid = rs.find((r) => r.status === "completed" && (!r.expiresAt || r.expiresAt > at));
        if (valid) return { templateId: t.id, templateName: t.name, state: "valid", requestId: valid.id, dueDate: valid.dueDate, expiresAt: valid.expiresAt };
        const open = rs.find((r) => r.status === "pending" || r.status === "partially_signed");
        if (open)
          return { templateId: t.id, templateName: t.name, state: open.status as FormState, requestId: open.id, dueDate: open.dueDate, expiresAt: null };
        const expired = rs.find((r) => r.status === "expired" || (r.status === "completed" && r.expiresAt && r.expiresAt <= at));
        if (expired) return { templateId: t.id, templateName: t.name, state: "expired", requestId: expired.id, dueDate: null, expiresAt: expired.expiresAt };
        return blank(t);
      }),
    );
  }
  return out;
}

function blank(t: { id: string; name: string }): FormStatusItem {
  return { templateId: t.id, templateName: t.name, state: "missing", requestId: null, dueDate: null, expiresAt: null };
}

/**
 * Eligibility helper for the scheduling module: is this athlete's paperwork in order
 * for the given templates at `at`? Unknown / other-org template ids count as missing.
 * Callers are responsible for authorizing the viewer against the athlete.
 */
export async function formsEligibility(
  tx: Tx,
  athleteId: string,
  requiredTemplateIds: string[],
  at: Date = new Date(),
): Promise<{ eligible: boolean; missing: { templateId: string; templateName: string; state: Exclude<FormState, "valid">; requestId: string | null }[] }> {
  const ids = [...new Set(requiredTemplateIds)];
  if (!ids.length) return { eligible: true, missing: [] };
  const [ath] = await tx.select({ orgId: athletes.orgId }).from(athletes).where(eq(athletes.id, athleteId));
  if (!ath) return { eligible: false, missing: ids.map((id) => ({ templateId: id, templateName: "Unknown form", state: "missing" as const, requestId: null })) };
  const tpls = await tx
    .select({ id: formTemplates.id, name: formTemplates.name })
    .from(formTemplates)
    .where(and(eq(formTemplates.orgId, ath.orgId), inArray(formTemplates.id, ids)));
  const status = (await athleteFormStatus(tx, ath.orgId, [athleteId], tpls, at)).get(athleteId) ?? [];
  const missing = status
    .filter((s) => s.state !== "valid")
    .map((s) => ({ templateId: s.templateId, templateName: s.templateName, state: s.state as Exclude<FormState, "valid">, requestId: s.requestId }));
  for (const id of ids) {
    if (!tpls.some((t) => t.id === id)) missing.push({ templateId: id, templateName: "Unknown form", state: "missing", requestId: null });
  }
  return { eligible: missing.length === 0, missing };
}

export type MissingFormsRow = {
  athleteId: string;
  personId: string;
  name: string;
  items: FormStatusItem[];
};

/**
 * Staff dashboard data: for every active athlete in the org, the required forms
 * (active templates marked "required for booking") that are not currently valid.
 * Only athletes with at least one problem are returned. Pass `athleteIds` to scope
 * (e.g. a coach's assigned athletes).
 */
export async function missingForms(tx: Tx, orgId: string, opts: { at?: Date; athleteIds?: string[] } = {}): Promise<MissingFormsRow[]> {
  const at = opts.at ?? new Date();
  const tpls = await tx
    .select({ id: formTemplates.id, name: formTemplates.name })
    .from(formTemplates)
    .where(and(eq(formTemplates.orgId, orgId), eq(formTemplates.active, true), eq(formTemplates.requiredForBooking, true)))
    .orderBy(asc(formTemplates.name));
  const conds = [eq(athletes.orgId, orgId), eq(athletes.active, true)];
  if (opts.athleteIds) {
    if (!opts.athleteIds.length) return [];
    conds.push(inArray(athletes.id, opts.athleteIds));
  }
  const ath = await tx
    .select({ id: athletes.id, personId: athletes.personId, first: people.firstName, last: people.lastName })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(...conds))
    .orderBy(asc(people.lastName), asc(people.firstName));
  const status = await athleteFormStatus(
    tx,
    orgId,
    ath.map((a) => a.id),
    tpls,
    at,
  );
  const out: MissingFormsRow[] = [];
  for (const a of ath) {
    const items = (status.get(a.id) ?? []).filter((s) => s.state !== "valid");
    if (items.length) out.push({ athleteId: a.id, personId: a.personId, name: `${a.first} ${a.last}`, items });
  }
  return out;
}
