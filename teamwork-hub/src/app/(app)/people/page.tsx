import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { groups, tags } from "@/db/schema";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { searchPeople, type PeopleFilter } from "@/lib/people/queries";
import { Badge, ButtonLink, DemoBadge, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { PeopleTabs } from "@/components/people-tabs";
import { MemberAvatar, Segmented } from "@/components/profile/studio";
import { Icon } from "@/components/icons";
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

const filterCtl =
  "h-9 w-full rounded-md border border-edge bg-surface px-2.5 text-sm text-ink focus:outline-2 focus:outline-offset-1 focus:outline-brand";

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
  const page = filter.page!;
  const first = result.total ? (page - 1) * result.pageSize + 1 : 0;
  const last = Math.min(result.total, page * result.pageSize);
  const filtered = !!(filter.q || filter.groupId || filter.tagId || cfSel);
  // Compact page window: 1 … p-1 p p+1 … N
  const pageNums = [...new Set([1, page - 1, page, page + 1, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);

  return (
    <>
      <PageHeader
        kicker="People"
        title="People & families"
        description={v.role === "coach" ? "Your assigned athletes and their guardians." : "Athletes, guardians, households, payers, leads, and staff — one identity per person."}
        actions={can(v, "people.manage") ? <ButtonLink href="/people/new">Register athlete</ButtonLink> : null}
      />
      <PeopleTabs current="directory" showLeads={can(v, "crm.manage")} showRequests={can(v, "people.manage") || can(v, "crm.manage")} />

      <section aria-label="Member directory" className="min-w-0 overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
        {/* Compact filter bar */}
        <div className="space-y-2.5 border-b border-edge bg-th px-3 py-3 sm:px-4">
          <form role="search" action="/people" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="kind" value={filter.kind} />
            <div className="relative min-w-0 flex-[1_1_16rem]">
              <label className="sr-only" htmlFor="q">
                Search people
              </label>
              <Icon name="search" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-3" />
              <input id="q" name="q" defaultValue={filter.q} placeholder="Search name, email, or phone" className={`${filterCtl} pl-8`} />
            </div>
            <label className="sr-only" htmlFor="group">
              Group
            </label>
            <select id="group" name="group" defaultValue={filter.groupId ?? ""} className={`${filterCtl} flex-[1_1_9rem] sm:w-auto sm:flex-none`}>
              <option value="">All groups</option>
              {groupRows.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="tag">
              Tag
            </label>
            <select id="tag" name="tag" defaultValue={filter.tagId ?? ""} className={`${filterCtl} flex-[1_1_9rem] sm:w-auto sm:flex-none`}>
              <option value="">All tags</option>
              {tagRows.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {cfOptions.length ? (
              <>
                <label className="sr-only" htmlFor="cf">
                  Custom field
                </label>
                <select id="cf" name="cf" defaultValue={cfSel ?? ""} className={`${filterCtl} flex-[1_1_10rem] sm:w-auto sm:flex-none`}>
                  <option value="">Any custom field</option>
                  {cfOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            <button className="h-9 rounded-md bg-brand px-4 text-sm font-semibold text-brand-ink hover:brightness-110" type="submit">
              Search
            </button>
            {filtered ? (
              <Link href={`/people?kind=${filter.kind}`} className="flex h-9 items-center px-1 text-xs font-semibold text-ink-2 underline">
                Clear
              </Link>
            ) : null}
          </form>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented label="Filter by type" items={KINDS.map((k) => ({ href: qs({ kind: k.key, page: 1 }), label: k.label, current: filter.kind === k.key }))} />
            <p className="text-xs text-ink-2" aria-live="polite">
              {result.total ? (
                <>
                  Showing <strong className="tabular">{first}–{last}</strong> of <strong className="tabular">{result.total}</strong> {result.total === 1 ? "person" : "people"}
                </>
              ) : (
                "0 people"
              )}
            </p>
          </div>
        </div>

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
                  <Link href={`/people/${r.id}`} className="flex min-h-14 items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                    <MemberAvatar name={`${r.firstName} ${r.lastName}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">
                        {r.firstName} {r.lastName}
                        {age(r.dob) != null ? <span className="ml-1 text-xs font-normal text-ink-3">({age(r.dob)})</span> : null}
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
            <div className="relative hidden overflow-x-auto sm:block" tabIndex={0} role="region" aria-label="People">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <caption className="sr-only">People</caption>
                <thead>
                  <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-ink-2">
                    <th scope="col" className="border-b border-edge px-4 py-2">Member</th>
                    <th scope="col" className="border-b border-edge px-3 py-2">Status</th>
                    <th scope="col" className="border-b border-edge px-3 py-2">Type</th>
                    <th scope="col" className="border-b border-edge px-3 py-2">Sport / level</th>
                    <th scope="col" className="border-b border-edge px-3 py-2">Contact</th>
                    {listDefs.map((d) => (
                      <th scope="col" key={d.id} className="border-b border-edge px-3 py-2">
                        {d.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.id} className="group hover:bg-brand/5">
                      <td className="border-b border-edge/70 px-4 py-1.5">
                        <Link href={`/people/${r.id}`} className="flex items-center gap-2.5">
                          <MemberAvatar name={`${r.firstName} ${r.lastName}`} />
                          <span className="min-w-0">
                            <span className="block font-semibold whitespace-nowrap text-ink group-hover:text-brand group-hover:underline">
                              {r.firstName} {r.lastName}
                            </span>
                            {age(r.dob) != null || r.isDemo ? (
                              <span className="flex items-center gap-1.5 text-xs text-ink-3">
                                {age(r.dob) != null ? `Age ${age(r.dob)}` : null}
                                {r.isDemo ? <DemoBadge /> : null}
                              </span>
                            ) : null}
                          </span>
                        </Link>
                      </td>
                      <td className="border-b border-edge/70 px-3 py-1.5">
                        <StatusBadge status={r.athleteId && r.athleteActive === false ? "inactive" : r.status} />
                      </td>
                      <td className="border-b border-edge/70 px-3 py-1.5">
                        <div className="flex flex-wrap gap-1">
                          {r.athleteId ? <Badge variant="brand">Athlete</Badge> : null}
                          {r.guardianOf > 0 ? <Badge variant="blue">Guardian of {r.guardianOf}</Badge> : null}
                          {r.role && ["owner", "admin", "operations", "coach"].includes(r.role) ? <Badge>{ROLE_LABEL[r.role]}</Badge> : null}
                          {r.status === "lead" ? <Badge variant="yellow">Lead</Badge> : null}
                        </div>
                      </td>
                      <td className="border-b border-edge/70 px-3 py-1.5 text-ink-2">{[r.sport, r.level].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="border-b border-edge/70 px-3 py-1.5 text-ink-2">
                        <div className="max-w-56 truncate">{r.email ?? (v.role === "coach" ? <span className="text-ink-3">hidden</span> : "—")}</div>
                        {r.phone ? <div className="text-xs text-ink-3 tabular">{r.phone}</div> : null}
                      </td>
                      {listDefs.map((d) => (
                        <td key={d.id} className="border-b border-edge/70 px-3 py-1.5 text-ink-2">
                          {formatCustomValue(d, (r.customFields as Record<string, unknown>)?.[d.key]) ?? "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {pages > 1 ? (
          <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 border-t border-edge px-4 py-2.5 text-sm">
            <span className="text-xs text-ink-3">
              Page {page} of {pages}
            </span>
            <ul className="flex items-center gap-1">
              <li>
                {page > 1 ? (
                  <Link className="flex h-8 items-center rounded-md border border-edge px-2.5 text-xs font-semibold hover:bg-surface-2" href={qs({ page: page - 1 })}>
                    ‹ Prev
                  </Link>
                ) : null}
              </li>
              {pageNums.map((n, i) => (
                <li key={n} className="flex items-center gap-1">
                  {i > 0 && n - pageNums[i - 1] > 1 ? <span aria-hidden className="px-1 text-ink-3">…</span> : null}
                  <Link
                    href={qs({ page: n })}
                    aria-current={n === page ? "page" : undefined}
                    aria-label={`Page ${n}`}
                    className={`flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-xs font-semibold tabular ${n === page ? "border-brand bg-brand text-brand-ink" : "border-edge hover:bg-surface-2"}`}
                  >
                    {n}
                  </Link>
                </li>
              ))}
              <li>
                {page < pages ? (
                  <Link className="flex h-8 items-center rounded-md border border-edge px-2.5 text-xs font-semibold hover:bg-surface-2" href={qs({ page: page + 1 })}>
                    Next ›
                  </Link>
                ) : null}
              </li>
            </ul>
          </nav>
        ) : null}
      </section>
    </>
  );
}
