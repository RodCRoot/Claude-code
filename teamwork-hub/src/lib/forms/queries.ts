import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, formRequests, formTemplates, formTemplateVersions, groups, people } from "@/db/schema";

export type RequestRow = Awaited<ReturnType<typeof listRequests>>[number];

/** Request list for pages. Pass athleteIds = "all" for org-wide staff. Always org-scoped. */
export async function listRequests(
  tx: Tx,
  orgId: string,
  opts: { athleteIds: string[] | "all"; statuses?: string[]; templateId?: string; limit?: number },
) {
  const conds: SQL[] = [eq(formRequests.orgId, orgId)];
  if (opts.athleteIds !== "all") {
    if (!opts.athleteIds.length) return [];
    conds.push(inArray(formRequests.athleteId, opts.athleteIds));
  }
  if (opts.statuses?.length) conds.push(inArray(formRequests.status, opts.statuses as (typeof formRequests.$inferSelect)["status"][]));
  if (opts.templateId) conds.push(eq(formTemplateVersions.templateId, opts.templateId));
  return tx
    .select({
      id: formRequests.id,
      status: formRequests.status,
      athleteId: formRequests.athleteId,
      subjectPersonId: formRequests.subjectPersonId,
      dueDate: formRequests.dueDate,
      completedAt: formRequests.completedAt,
      expiresAt: formRequests.expiresAt,
      createdAt: formRequests.createdAt,
      reminderCount: formRequests.reminderCount,
      lastReminderAt: formRequests.lastReminderAt,
      pdfObjectId: formRequests.completedPdfObjectId,
      templateId: formTemplates.id,
      templateName: formTemplates.name,
      templateKind: formTemplates.kind,
      version: formTemplateVersions.version,
      title: formTemplateVersions.title,
      isSampleText: formTemplateVersions.isSampleText,
      subjectName: sql<string>`${people.firstName} || ' ' || ${people.lastName}`,
    })
    .from(formRequests)
    .innerJoin(formTemplateVersions, eq(formTemplateVersions.id, formRequests.templateVersionId))
    .innerJoin(formTemplates, eq(formTemplates.id, formTemplateVersions.templateId))
    .innerJoin(people, eq(people.id, formRequests.subjectPersonId))
    .where(and(...conds))
    .orderBy(desc(formRequests.createdAt))
    .limit(opts.limit ?? 500);
}

export async function listTemplates(tx: Tx, orgId: string) {
  const tpls = await tx.select().from(formTemplates).where(eq(formTemplates.orgId, orgId)).orderBy(desc(formTemplates.active), asc(formTemplates.name));
  if (!tpls.length) return [];
  const vers = await tx
    .select()
    .from(formTemplateVersions)
    .where(
      inArray(
        formTemplateVersions.templateId,
        tpls.map((t) => t.id),
      ),
    )
    .orderBy(desc(formTemplateVersions.version));
  const counts = await tx
    .select({ templateId: formTemplateVersions.templateId, status: formRequests.status, n: sql<number>`count(*)::int` })
    .from(formRequests)
    .innerJoin(formTemplateVersions, eq(formTemplateVersions.id, formRequests.templateVersionId))
    .where(eq(formRequests.orgId, orgId))
    .groupBy(formTemplateVersions.templateId, formRequests.status);
  return tpls.map((t) => {
    const vs = vers.filter((v) => v.templateId === t.id);
    const current = vs.find((v) => v.status === "published") ?? null;
    const draft = vs.find((v) => v.status === "draft") ?? null;
    const c = (s: string) => counts.filter((x) => x.templateId === t.id && x.status === s).reduce((a, x) => a + x.n, 0);
    return { ...t, current, draft, versions: vs, open: c("pending") + c("partially_signed"), completed: c("completed") };
  });
}

export async function athleteOptions(tx: Tx, orgId: string, ids?: string[]) {
  const conds: SQL[] = [eq(athletes.orgId, orgId)];
  if (ids) {
    if (!ids.length) return [];
    conds.push(inArray(athletes.id, ids));
  }
  return tx
    .select({ id: athletes.id, personId: athletes.personId, name: sql<string>`${people.firstName} || ' ' || ${people.lastName}`, active: athletes.active, dob: people.dateOfBirth })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(...conds))
    .orderBy(asc(people.lastName), asc(people.firstName));
}

export async function groupOptions(tx: Tx, orgId: string) {
  return tx
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(and(eq(groups.orgId, orgId), eq(groups.active, true)))
    .orderBy(asc(groups.name));
}

export async function peopleOptions(tx: Tx, orgId: string) {
  return tx
    .select({ id: people.id, name: sql<string>`${people.firstName} || ' ' || ${people.lastName}` })
    .from(people)
    .where(and(eq(people.orgId, orgId), sql`${people.archivedAt} is null`))
    .orderBy(asc(people.lastName), asc(people.firstName));
}
