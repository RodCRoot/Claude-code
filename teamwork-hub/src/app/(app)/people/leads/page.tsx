import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { tags } from "@/db/schema";
import { ActionForm, SubmitButton } from "@/components/forms";
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,

  Table,
  Tabs,
  Td,
  Th,
} from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { listLeads, leadSources, type LeadFilters, type LeadRow } from "@/lib/crm/leads";
import { ensureStages, type LeadStage } from "@/lib/crm/stages";
import { staffDirectory } from "@/lib/messaging/threads";
import { fmt, fmtDate } from "@/lib/time";
import { KpiTile, MemberAvatar } from "@/components/profile/studio";
import { changeStageAction, createStageAction, deleteStageAction, moveStageAction, updateStageAction } from "./actions";

export const metadata = { title: "Leads" };

type SP = Record<string, string | undefined>;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const v = await requireCap("crm.manage");
  const sp = await searchParams;
  const view = sp.view === "list" ? "list" : sp.view === "stages" ? "stages" : "board";
  const num = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : undefined);
  const filters: LeadFilters = {
    stage: sp.stage || undefined,
    owner: sp.owner || undefined,
    source: sp.source || undefined,
    tag: sp.tag || undefined,
    minAge: num(sp.minAge),
    maxAge: num(sp.maxAge),
    q: sp.q || undefined,
  };
  const stages = await db.transaction((tx) => ensureStages(tx, v.orgId));
  const [rows, sources, staff, tagList] = await Promise.all([
    listLeads(db, v, filters),
    leadSources(db, v.orgId),
    staffDirectory(db, v.orgId),
    db.select().from(tags).where(eq(tags.orgId, v.orgId)).orderBy(asc(tags.name)),
  ]);
  const stageLabel = (k: string) => stages.find((s) => s.key === k)?.label ?? k;
  const openKeys = stages.filter((s) => !s.isWon && !s.isLost).map((s) => s.key);
  const filtered = Object.values(filters).some((x) => x !== undefined);
  const qs = (extra: SP) => {
    const p = new URLSearchParams();
    for (const [k, val] of Object.entries({ ...sp, ...extra })) if (val) p.set(k, val);
    return `?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        kicker="People"
        title="Leads"
        description="Inquiries from the public form and staff entry, from first contact through assessment to a converted athlete."
        actions={
          <>
            <ButtonLink href="/inquire" variant="outline" target="_blank" rel="noopener">
              Public inquiry form ↗
            </ButtonLink>
            <ButtonLink href="/people/leads/new">Add lead</ButtonLink>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-4">
        <KpiTile icon="people" label="Open leads" value={rows.filter((r) => openKeys.includes(r.stage)).length} />
        <KpiTile icon="messages" label="New (uncontacted)" value={rows.filter((r) => r.stage === "new").length} tone={rows.some((r) => r.stage === "new") ? "warn" : "ok"} />
        <KpiTile icon="shield" label="Possible duplicates" value={rows.filter((r) => r.possibleDuplicate && !r.convertedAt).length} hint="Need review before converting" />
        <KpiTile icon="today" label="Converted" value={rows.filter((r) => r.convertedAt).length} tone="ok" />
      </div>

      <Tabs
        current={view}
        tabs={[
          { key: "board", label: "Board", href: `/people/leads${qs({ view: undefined })}` },
          { key: "list", label: "List", href: `/people/leads${qs({ view: "list" })}` },
          { key: "stages", label: "Pipeline stages", href: "/people/leads?view=stages" },
        ]}
      />

      {view === "stages" ? (
        <StageSettings stages={stages} />
      ) : (
        <>
          <form method="get" className="mb-4 grid grid-cols-2 gap-3 rounded-md border border-edge bg-th p-3 sm:grid-cols-3 lg:grid-cols-7" aria-label="Filter leads">
            {view === "list" ? <input type="hidden" name="view" value="list" /> : null}
            <Field label="Search" htmlFor="f-q" className="col-span-2 sm:col-span-1">
              <Input id="f-q" name="q" defaultValue={sp.q} placeholder="Name or email" />
            </Field>
            <Field label="Stage" htmlFor="f-stage">
              <Select id="f-stage" name="stage" defaultValue={sp.stage ?? ""}>
                <option value="">All</option>
                {stages.map((s) => (
                  <option key={s.id} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Owner" htmlFor="f-owner">
              <Select id="f-owner" name="owner" defaultValue={sp.owner ?? ""}>
                <option value="">Anyone</option>
                <option value="me">Me</option>
                <option value="none">Unassigned</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Source" htmlFor="f-source">
              <Select id="f-source" name="source" defaultValue={sp.source ?? ""}>
                <option value="">Any</option>
                {sources.map((s) => (
                  <option key={s} value={s}>
                    {s.replaceAll("_", " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tag" htmlFor="f-tag">
              <Select id="f-tag" name="tag" defaultValue={sp.tag ?? ""}>
                <option value="">Any</option>
                {tagList.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Min age" htmlFor="f-min">
                <Input id="f-min" name="minAge" type="number" min={0} max={99} defaultValue={sp.minAge} />
              </Field>
              <Field label="Max age" htmlFor="f-max">
                <Input id="f-max" name="maxAge" type="number" min={0} max={99} defaultValue={sp.maxAge} />
              </Field>
            </div>
            <div className="flex items-end gap-2">
              <button type="submit" className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink">
                Apply
              </button>
              {filtered ? (
                <Link href={view === "list" ? "/people/leads?view=list" : "/people/leads"} className="flex h-10 items-center px-2 text-sm text-ink-3 underline">
                  Reset
                </Link>
              ) : null}
            </div>
          </form>

          {rows.length === 0 ? (
            <EmptyState title={filtered ? "No leads match these filters" : "No leads yet"} action={<ButtonLink href="/people/leads/new">Add lead</ButtonLink>}>
              {filtered ? "Try clearing a filter." : "Leads arrive from the public inquiry form at /inquire, or add one manually."}
            </EmptyState>
          ) : view === "board" ? (
            <Board rows={rows} stages={stages} />
          ) : (
            <LeadTable rows={rows} stageLabel={stageLabel} />
          )}
        </>
      )}
    </>
  );
}

function Board({ rows, stages }: { rows: LeadRow[]; stages: LeadStage[] }) {
  const movable = stages.filter((s) => !s.isWon && !s.isLost);
  return (
    <div className="relative -mx-4 overflow-x-auto px-4 pb-3 sm:mx-0 sm:px-0" role="region" aria-label="Lead pipeline board" tabIndex={0}>
      <div className="flex items-start gap-3">
        {stages.map((s) => {
          const items = rows.filter((r) => r.stage === s.key);
          return (
            <section
              key={s.id}
              className={`flex max-h-[75vh] w-64 shrink-0 flex-col overflow-hidden rounded-md border border-t-4 border-edge bg-th ${s.isWon ? "border-t-ok" : s.isLost ? "border-t-bad" : "border-t-brand"}`}
              aria-labelledby={`col-${s.id}`}
            >
              <h2 id={`col-${s.id}`} className="flex items-center justify-between gap-2 border-b border-edge px-3 py-2 text-[12px] font-bold uppercase tracking-wide text-ink-2">
                <span className="truncate">{s.label}</span>
                <span className="rounded-full bg-surface px-2 text-[11px] tabular ring-1 ring-edge">
                  {items.length}
                  <span className="sr-only"> lead{items.length === 1 ? "" : "s"}</span>
                </span>
              </h2>
              <ul className="space-y-1.5 overflow-y-auto p-1.5">
                {items.length === 0 ? <li className="rounded border border-dashed border-edge px-2 py-4 text-center text-xs text-ink-3">No leads</li> : null}
                {items.map((r) => (
                  <li key={r.id} className="rounded border border-edge bg-surface px-2.5 py-2 text-sm shadow-[0_1px_2px_rgb(16_24_40/0.06)] hover:border-brand/50">
                    <div className="flex items-start gap-2">
                      <MemberAvatar name={r.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <Link href={`/people/leads/${r.id}`} className="block truncate font-semibold leading-tight hover:underline">
                          {r.name}
                        </Link>
                        <div className="truncate text-[11px] text-ink-3">
                          {[r.age != null ? `${r.age} yrs` : null, r.interest, r.source?.replaceAll("_", " ")].filter(Boolean).join(" · ") || "—"}
                        </div>
                      </div>
                    </div>
                    {r.contactName ? <div className="mt-1 truncate text-[11px] text-ink-3">Contact: {r.contactName}</div> : null}
                    {(r.possibleDuplicate && !r.convertedAt) || r.openTasks || r.tags.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.possibleDuplicate && !r.convertedAt ? <Badge variant="yellow">Possible duplicate</Badge> : null}
                        {r.openTasks ? <Badge variant="blue">{r.openTasks} task{r.openTasks > 1 ? "s" : ""}</Badge> : null}
                        {r.tags.map((t) => (
                          <Badge key={t.id}>{t.name}</Badge>
                        ))}
                      </div>
                    ) : null}
                    <div className="mt-1 flex items-center justify-between gap-2 border-t border-edge/70 pt-1 text-[11px] text-ink-3">
                      <span className="truncate">{r.ownerName ?? "Unassigned"}</span>
                      <span className={`shrink-0 ${r.lastContactedAt ? "" : "font-semibold text-warn"}`}>{r.lastContactedAt ? `contacted ${fmtDate(r.lastContactedAt)}` : "not contacted"}</span>
                    </div>
                    {!s.isWon && !s.isLost ? (
                      <ActionForm action={changeStageAction} className="mt-1.5 flex gap-1">
                        <input type="hidden" name="leadId" value={r.id} />
                        <label htmlFor={`mv-${r.id}`} className="sr-only">
                          Move {r.name} to stage
                        </label>
                        <select id={`mv-${r.id}`} name="stage" defaultValue={r.stage} className="h-7 min-w-0 flex-1 rounded border border-edge bg-surface px-1.5 text-xs">
                          {movable.map((m) => (
                            <option key={m.id} value={m.key}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                        <SubmitButton size="sm" variant="secondary" pendingText="…" className="h-7 px-2">
                          Move
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-ink-3">Mark a lead lost (with a reason) or convert it to an athlete from its detail page.</p>
    </div>
  );
}

function LeadTable({ rows, stageLabel }: { rows: LeadRow[]; stageLabel: (k: string) => string }) {
  return (
    <Card>
      <Table caption="Leads">
        <thead>
          <tr>
            <Th>Lead</Th>
            <Th>Contact</Th>
            <Th>Stage</Th>
            <Th>Source</Th>
            <Th>Owner</Th>
            <Th align="right">Age</Th>
            <Th>Last contacted</Th>
            <Th>Created</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <Td>
                <Link href={`/people/leads/${r.id}`} className="font-medium hover:underline">
                  {r.name}
                </Link>
                {r.possibleDuplicate && !r.convertedAt ? (
                  <Badge variant="yellow" className="ml-2">
                    Possible duplicate
                  </Badge>
                ) : null}
              </Td>
              <Td className="text-ink-2">
                {r.contactName ?? "—"}
                <div className="text-xs text-ink-3">{r.email ?? r.phone ?? ""}</div>
              </Td>
              <Td>
                <Badge variant={r.stage === "won" ? "green" : r.stage === "lost" ? "red" : "neutral"}>{stageLabel(r.stage)}</Badge>
              </Td>
              <Td>{r.source?.replaceAll("_", " ") ?? "—"}</Td>
              <Td>{r.ownerName ?? "Unassigned"}</Td>
              <Td align="right">{r.age ?? "—"}</Td>
              <Td>{r.lastContactedAt ? fmt(r.lastContactedAt, "MMM d, h:mm a") : "—"}</Td>
              <Td>{fmtDate(r.createdAt)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function StageSettings({ stages }: { stages: LeadStage[] }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
      <Card>
        <CardHeader title="Pipeline stages" kicker="Settings" />
        <CardBody>
          <p className="mb-3 text-sm text-ink-3">
            Order is left-to-right on the board. Stages marked <strong>Won</strong> are set by conversion; <strong>Lost</strong> requires a reason. A stage with leads in it can&apos;t be deleted.
          </p>
          <ul className="divide-y divide-edge">
            {stages.map((s, i) => (
              <li key={s.id} className="flex flex-wrap items-end gap-2 py-3">
                <ActionForm action={updateStageAction} className="flex flex-1 flex-wrap items-end gap-2">
                  <input type="hidden" name="stageId" value={s.id} />
                  <Field label="Label" htmlFor={`st-${s.id}`} className="min-w-40 flex-1">
                    <Input id={`st-${s.id}`} name="label" defaultValue={s.label} required maxLength={60} />
                  </Field>
                  <Field label="Type" htmlFor={`sk-${s.id}`}>
                    <Select id={`sk-${s.id}`} name="kind" defaultValue={s.isWon ? "won" : s.isLost ? "lost" : "open"}>
                      <option value="open">Open</option>
                      <option value="won">Won</option>
                      <option value="lost">Lost</option>
                    </Select>
                  </Field>
                  <SubmitButton variant="secondary">Save</SubmitButton>
                </ActionForm>
                <div className="flex gap-1">
                  <ActionForm action={moveStageAction}>
                    <input type="hidden" name="stageId" value={s.id} />
                    <input type="hidden" name="dir" value="up" />
                    <button type="submit" disabled={i === 0} aria-label={`Move ${s.label} earlier`} className="h-10 w-10 rounded-lg border border-edge disabled:opacity-40">
                      ↑
                    </button>
                  </ActionForm>
                  <ActionForm action={moveStageAction}>
                    <input type="hidden" name="stageId" value={s.id} />
                    <input type="hidden" name="dir" value="down" />
                    <button type="submit" disabled={i === stages.length - 1} aria-label={`Move ${s.label} later`} className="h-10 w-10 rounded-lg border border-edge disabled:opacity-40">
                      ↓
                    </button>
                  </ActionForm>
                  <ActionForm action={deleteStageAction}>
                    <input type="hidden" name="stageId" value={s.id} />
                    <SubmitButton variant="ghost" confirm={`Delete stage "${s.label}"?`} pendingText="…">
                      Delete
                    </SubmitButton>
                  </ActionForm>
                </div>
                <code className="w-full text-[11px] text-ink-3">key: {s.key}</code>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Add a stage" />
        <CardBody>
          <ActionForm action={createStageAction} resetOnSuccess className="space-y-3">
            <Field label="Label" htmlFor="new-stage">
              <Input id="new-stage" name="label" required maxLength={60} placeholder="e.g. Trial week" />
            </Field>
            <Field label="Type" htmlFor="new-kind">
              <Select id="new-kind" name="kind" defaultValue="open">
                <option value="open">Open</option>
                <option value="won">Won</option>
                <option value="lost">Lost</option>
              </Select>
            </Field>
            <SubmitButton>Add stage</SubmitButton>
          </ActionForm>
        </CardBody>
      </Card>
    </div>
  );
}
