import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { groups, tags } from "@/db/schema";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { searchPeople, type PeopleFilter } from "@/lib/people/queries";
import { Avatar, Badge, ButtonLink, Card, DemoBadge, EmptyState, Input, PageHeader, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { PeopleTabs } from "@/components/people-tabs";
import { ROLE_LABEL } from "@/lib/nav";
import { formatCustomValue, listFieldDefs } from "@/lib/people/custom-fields";

export const metadata = { title: "People" };

const KINDS: { key: NonNullable<PeopleFilter["kind"]>; label: string }[] = [
  { key: "all", label: "Everyone" },
  { key: "athletes", label: "Active athletes" },
  { key: "guardians", label: "Guardians" },
  { key: "leads", label: "Leads" },
  { key: "staff", label: "Staff" },
  { key: "inactive", label: "Inactive" },
];

function age(dob: string | null) {
  if (!dob) return null;
  const d = new Date(dob + "T12:00:00Z");
  const now = new Date();
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

export default async function PeoplePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const v = await requireStaff();
  const sp = await searchParams;
  const listDefs = (await listFieldDefs(db, v.orgId)).filter((d) => d.showInList).slice(0, 4);
  const filterDefs = listDefs.filter((d) => d.fieldType === "select" || d.fieldType === "boolean");
  const cfOptions = filterDefs.flatMap((d) =>
    (d.fieldType === "boolean" ? [["true", "Yes"], ["false", "No"]] : (d.options ?? []).map((o) => [o, o])).map(([val, lbl]) => ({ value: `${d.key}:${val}`, label: `${d.label}: ${lbl}` })),
  );
  const cfSel = cfOptions.find((o) => o.value === sp.cf)?.value;
  const filter: PeopleFilter = {
    q: sp.q,
    kind: (KINDS.find((k) => k.key === sp.kind)?.key ?? "athletes") as PeopleFilter["kind"],
    groupId: sp.group || undefined,
    tagId: sp.tag || undefined,
    custom: cfSel ? { key: cfSel.slice(0, cfSel.indexOf(":")), value: cfSel.slice(cfSel.indexOf(":") + 1) } : undefined,
    page: Number(sp.page ?? 1) || 1,
  };
  const [result, groupRows, tagRows] = await Promise.all([
    searchPeople(db, v, filter),
    db.select().from(groups).where(eq(groups.orgId, v.orgId)).orderBy(asc(groups.name)),
    db.select().from(tags).where(eq(tags.orgId, v.orgId)).orderBy(asc(tags.name)),
  ]);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const qs = (patch: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const merged = { q: filter.q, kind: filter.kind, group: filter.groupId, tag: filter.tagId, cf: cfSel, page: filter.page, ...patch };
    for (const [k, val] of Object.entries(merged)) if (val !== undefined && val !== "") p.set(k, String(val));
    return `/people?${p}`;
  };

  return (
    <>
      <PageHeader
        kicker="People"
        title="People & families"
        description={v.role === "coach" ? "Your assigned athletes and their guardians." : "Athletes, guardians, households, payers, leads, and staff — one identity per person."}
        actions={can(v, "people.manage") ? <ButtonLink href="/people/new">Register athlete</ButtonLink> : null}
      />
      <PeopleTabs current="directory" showLeads={can(v, "crm.manage")} />

      <form role="search" className={`mb-4 grid gap-3 ${cfOptions.length ? "sm:grid-cols-[1fr_auto_auto_auto_auto_auto]" : "sm:grid-cols-[1fr_auto_auto_auto_auto]"}`} action="/people">
        <label className="sr-only" htmlFor="q">
          Search people
        </label>
        <Input id="q" name="q" defaultValue={filter.q} placeholder="Search name, email, or phone" />
        <input type="hidden" name="kind" value={filter.kind} />
        <label className="sr-only" htmlFor="group">
          Group
        </label>
        <Select id="group" name="group" defaultValue={filter.groupId ?? ""}>
          <option value="">All groups</option>
          {groupRows.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
        <label className="sr-only" htmlFor="tag">
          Tag
        </label>
        <Select id="tag" name="tag" defaultValue={filter.tagId ?? ""}>
          <option value="">All tags</option>
          {tagRows.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        {cfOptions.length ? (
          <>
            <label className="sr-only" htmlFor="cf">
              Custom field
            </label>
            <Select id="cf" name="cf" defaultValue={cfSel ?? ""}>
              <option value="">Any custom field</option>
              {cfOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </>
        ) : null}
        <button className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink" type="submit">
          Search
        </button>
      </form>

      <nav aria-label="Filter by type" className="mb-4 flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <Link
            key={k.key}
            href={qs({ kind: k.key, page: 1 })}
            aria-current={filter.kind === k.key ? "true" : undefined}
            className={`min-h-9 rounded-full border px-3 py-1.5 text-sm ${filter.kind === k.key ? "border-brand bg-brand text-brand-ink" : "border-edge bg-surface text-ink-2 hover:bg-surface-2"}`}
          >
            {k.label}
          </Link>
        ))}
      </nav>

      <Card>
        {result.rows.length === 0 ? (
          <div className="p-5">
            <EmptyState title="No one matches these filters">
              {v.role === "coach" ? "Only athletes assigned to you (directly or through a group) appear here." : "Try a different search or filter, or register a new athlete."}
            </EmptyState>
          </div>
        ) : (
          <>
          <ul className="divide-y divide-edge sm:hidden">
            {result.rows.map((r) => (
              <li key={r.id}>
                <Link href={`/people/${r.id}`} className="flex min-h-14 items-center gap-3 px-4 py-3">
                  <Avatar name={`${r.firstName} ${r.lastName}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {r.firstName} {r.lastName}
                      {age(r.dob) != null ? <span className="ml-1 text-xs text-ink-3">({age(r.dob)})</span> : null}
                    </div>
                    <div className="truncate text-xs text-ink-3">
                      {[r.athleteId ? "Athlete" : null, r.guardianOf > 0 ? `Guardian of ${r.guardianOf}` : null, r.sport, r.level].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <StatusBadge status={r.athleteId && r.athleteActive === false ? "inactive" : r.status} />
                </Link>
              </li>
            ))}
          </ul>
          <Table caption="People" className="hidden sm:block">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Sport / level</Th>
                <Th>Contact</Th>
                {listDefs.map((d) => (
                  <Th key={d.id}>{d.label}</Th>
                ))}
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.id} className="hover:bg-surface-2/60">
                  <Td>
                    <Link href={`/people/${r.id}`} className="flex items-center gap-2 font-medium hover:underline">
                      <Avatar name={`${r.firstName} ${r.lastName}`} />
                      <span>
                        {r.firstName} {r.lastName}
                        {age(r.dob) != null ? <span className="ml-1 text-xs text-ink-3">({age(r.dob)})</span> : null}
                      </span>
                      {r.isDemo ? <DemoBadge /> : null}
                    </Link>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {r.athleteId ? <Badge variant="brand">Athlete</Badge> : null}
                      {r.guardianOf > 0 ? <Badge variant="blue">Guardian of {r.guardianOf}</Badge> : null}
                      {r.role && ["owner", "admin", "operations", "coach"].includes(r.role) ? <Badge>{ROLE_LABEL[r.role]}</Badge> : null}
                      {r.status === "lead" ? <Badge variant="yellow">Lead</Badge> : null}
                    </div>
                  </Td>
                  <Td className="text-ink-2">{[r.sport, r.level].filter(Boolean).join(" · ") || "—"}</Td>
                  <Td className="text-ink-2">
                    <div className="max-w-56 truncate">{r.email ?? (v.role === "coach" ? <span className="text-ink-3">hidden</span> : "—")}</div>
                    {r.phone ? <div className="text-xs text-ink-3">{r.phone}</div> : null}
                  </Td>
                  {listDefs.map((d) => (
                    <Td key={d.id} className="text-ink-2">
                      {formatCustomValue(d, (r.customFields as Record<string, unknown>)?.[d.key]) ?? "—"}
                    </Td>
                  ))}
                  <Td>
                    <StatusBadge status={r.athleteId && r.athleteActive === false ? "inactive" : r.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          </>
        )}
      </Card>
      <div className="mt-4 flex items-center justify-between text-sm text-ink-3">
        <span>
          {result.total} {result.total === 1 ? "person" : "people"}
        </span>
        <div className="flex gap-2">
          {filter.page! > 1 ? (
            <Link className="rounded-lg border border-edge px-3 py-2" href={qs({ page: filter.page! - 1 })}>
              Previous
            </Link>
          ) : null}
          <span className="px-2 py-2">
            Page {filter.page} of {pages}
          </span>
          {filter.page! < pages ? (
            <Link className="rounded-lg border border-edge px-3 py-2" href={qs({ page: filter.page! + 1 })}>
              Next
            </Link>
          ) : null}
        </div>
      </div>
    </>
  );
}
