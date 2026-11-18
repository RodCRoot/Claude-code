import Link from "next/link";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents, users } from "@/db/schema";
import { requireCap } from "@/lib/auth/viewer";
import { fmt } from "@/lib/time";
import { Card, CardBody, EmptyState, Input, PageHeader, Table, Td, Th } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const v = await requireCap("audit.read");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const q = sp.q?.trim();
  const rows = await db
    .select({ e: auditEvents, actor: users.displayName })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(and(eq(auditEvents.orgId, v.orgId), q ? or(ilike(auditEvents.action, `%${q}%`), ilike(auditEvents.entityType, `%${q}%`), ilike(auditEvents.summary, `%${q}%`), ilike(users.displayName, `%${q}%`)) : undefined))
    .orderBy(desc(auditEvents.createdAt))
    .limit(50)
    .offset((page - 1) * 50);
  return (
    <>
      <PageHeader kicker="Settings" title="Audit log" description="Append-only record of sign-ins, permission changes, money movements, imports, signatures, and other changes. Entries can't be edited or deleted." />
      <SettingsTabs current="audit" />
      <form className="mb-4 flex max-w-md gap-2" action="/settings/audit">
        <label htmlFor="aq" className="sr-only">
          Filter
        </label>
        <Input id="aq" name="q" defaultValue={q} placeholder="Filter by action, entity, or person" />
        <button className="h-10 rounded-lg border border-edge px-4 text-sm" type="submit">
          Filter
        </button>
      </form>
      <Card>
        <CardBody className="pt-4">
          {rows.length === 0 ? (
            <EmptyState title="No audit events match" />
          ) : (
            <Table caption="Audit events">
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Who</Th>
                  <Th>Action</Th>
                  <Th>Entity</Th>
                  <Th>Summary</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ e, actor }) => (
                  <tr key={e.id}>
                    <Td className="whitespace-nowrap text-xs">{fmt(e.createdAt, "MMM d, h:mm:ss a")}</Td>
                    <Td className="text-xs">
                      {actor ?? "system"} {e.actorRole ? <span className="text-ink-3">({e.actorRole})</span> : null}
                    </Td>
                    <Td className="font-mono text-xs">{e.action}</Td>
                    <Td className="text-xs">
                      {e.entityType}
                      {e.entityId ? <span className="block max-w-40 truncate text-ink-3">{e.entityId}</span> : null}
                    </Td>
                    <Td className="text-xs">{e.summary ?? (e.after ? <details><summary className="cursor-pointer">changes</summary><pre className="max-w-md overflow-x-auto text-[10px]">{JSON.stringify({ before: e.before, after: e.after }, null, 1)}</pre></details> : "—")}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <div className="mt-3 flex gap-3 text-sm">
            {page > 1 ? <Link href={`/settings/audit?page=${page - 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>Newer</Link> : null}
            {rows.length === 50 ? <Link href={`/settings/audit?page=${page + 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>Older</Link> : null}
          </div>
        </CardBody>
      </Card>
    </>
  );
}
