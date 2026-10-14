import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { addDaysYmd, daysBetween, fmtDate, todayLocal } from "@/lib/time";
import { athleteNames, writableAthletes } from "@/lib/training/common";
import { groupsForViewer } from "@/lib/training/assignments";
import { listPrograms } from "@/lib/training/programs";
import { listPlanBlocks } from "@/lib/training/reports";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { cn } from "@/lib/cn";
import { TrainingNav } from "../_components/training-nav";
import { createPlanBlockAction, deletePlanBlockAction } from "../actions";

export const metadata = { title: "Annual plan" };

const KIND: Record<string, { label: string; cls: string }> = {
  off_season: { label: "Off-season", cls: "bg-info/20 border-info/50" },
  pre_season: { label: "Pre-season", cls: "bg-warn/20 border-warn/50" },
  in_season: { label: "In-season", cls: "bg-ok/20 border-ok/50" },
  post_season: { label: "Post-season", cls: "bg-brand/15 border-brand/40" },
  transition: { label: "Transition", cls: "bg-surface-2 border-edge" },
};

export default async function PlanPage() {
  const viewer = await requireCap("training.manage");
  const today = todayLocal();
  const blocks = await listPlanBlocks(db, viewer);
  const groupList = await groupsForViewer(db, viewer);
  const programsList = await listPrograms(db, viewer);
  const writable = await writableAthletes(db, viewer);
  const names = await athleteNames(db, viewer.orgId, [...new Set([...writable.map(([id]) => id), ...blocks.flatMap((b) => (b.athleteId ? [b.athleteId] : []))])]);
  const start = addDaysYmd(today.slice(0, 8) + "01", -92);
  const end = addDaysYmd(start, 365);
  const span = daysBetween(start, end);
  const pos = (d: string) => Math.min(100, Math.max(0, (daysBetween(start, d) / span) * 100));
  const rows = new Map<string, { label: string; blocks: typeof blocks }>();
  for (const b of blocks) {
    const key = b.groupId ? `g:${b.groupId}` : `a:${b.athleteId}`;
    const label = b.groupId ? groupList.find((g) => g.id === b.groupId)?.name ?? "Group" : names.get(b.athleteId!) ?? "Athlete";
    rows.set(key, { label, blocks: [...(rows.get(key)?.blocks ?? []), b] });
  }
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1 + i, 1));
    return { label: d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }), at: pos(d.toISOString().slice(0, 10)) };
  });

  return (
    <div>
      <PageHeader kicker="Training" title="Annual plan" description="Season blocks per group or athlete. Timeline shows 12 months starting three months ago." />
      <TrainingNav viewer={viewer} current="plan" />
      <Card className="mb-6">
        <CardHeader title="Timeline" kicker={`${fmtDate(start)} – ${fmtDate(end)}`} />
        <CardBody>
          {rows.size === 0 ? (
            <EmptyState title="No season blocks yet">Add one below.</EmptyState>
          ) : (
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Season timeline">
              <div className="min-w-[640px]">
                <div className="relative ml-40 h-6 border-b border-edge text-xs text-ink-3" aria-hidden>
                  {months.map((m) => (
                    <span key={m.label + m.at} className="absolute" style={{ left: `${m.at}%` }}>
                      {m.label}
                    </span>
                  ))}
                  <span className="absolute top-0 h-[999px] border-l-2 border-bad/60" style={{ left: `${pos(today)}%` }} title="Today" />
                </div>
                <ul>
                  {[...rows.values()].map((r) => (
                    <li key={r.label} className="flex items-center border-b border-edge/60 py-2">
                      <span className="w-40 shrink-0 truncate pr-2 text-sm font-medium">{r.label}</span>
                      <div className="relative h-9 flex-1">
                        {r.blocks.map((b) => (
                          <span
                            key={b.id}
                            className={cn("absolute top-0 flex h-9 items-center overflow-hidden rounded border px-1 text-[11px] whitespace-nowrap", KIND[b.kind]?.cls)}
                            style={{ left: `${pos(b.startDate)}%`, width: `${Math.max(1, pos(b.endDate) - pos(b.startDate))}%` }}
                            title={`${KIND[b.kind]?.label}: ${b.name} (${b.startDate} → ${b.endDate})${b.focus ? ` — ${b.focus}` : ""}`}
                          >
                            {b.name}
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <ul className="mt-3 flex flex-wrap gap-3 text-xs" aria-label="Legend">
            {Object.values(KIND).map((k) => (
              <li key={k.label} className="flex items-center gap-1">
                <span className={cn("inline-block size-3 rounded border", k.cls)} aria-hidden /> {k.label}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Add season block" />
          <CardBody>
            <ActionForm action={createPlanBlockAction} resetOnSuccess className="grid grid-cols-2 gap-3">
              <Field label="Group or athlete" htmlFor="pb-t" className="col-span-2" required>
                <Select id="pb-t" name="target" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  <optgroup label="Groups">
                    {groupList.map((g) => (
                      <option key={g.id} value={`group:${g.id}`}>
                        {g.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Athletes">
                    {writable.map(([id, n]) => (
                      <option key={id} value={`athlete:${id}`}>
                        {n}
                      </option>
                    ))}
                  </optgroup>
                </Select>
              </Field>
              <Field label="Name" htmlFor="pb-n" required>
                <Input id="pb-n" name="name" required maxLength={80} />
              </Field>
              <Field label="Season phase" htmlFor="pb-k">
                <Select id="pb-k" name="kind" defaultValue="off_season">
                  {Object.entries(KIND).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Start" htmlFor="pb-s" required>
                <Input id="pb-s" name="startDate" type="date" required defaultValue={today} />
              </Field>
              <Field label="End" htmlFor="pb-e" required>
                <Input id="pb-e" name="endDate" type="date" required defaultValue={addDaysYmd(today, 55)} />
              </Field>
              <Field label="Linked program (optional)" htmlFor="pb-p">
                <Select id="pb-p" name="programId" defaultValue="">
                  <option value="">None</option>
                  {programsList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Focus" htmlFor="pb-f">
                <Input id="pb-f" name="focus" maxLength={300} />
              </Field>
              <div className="col-span-2">
                <SubmitButton>Add block</SubmitButton>
              </div>
            </ActionForm>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Blocks" />
          <CardBody>
            {blocks.length === 0 ? (
              <p className="text-sm text-ink-3">None yet.</p>
            ) : (
              <ul className="divide-y divide-edge">
                {blocks.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span>
                      <strong>{b.name}</strong> · {KIND[b.kind]?.label} · {fmtDate(b.startDate)} – {fmtDate(b.endDate)}
                      <span className="block text-xs text-ink-3">{b.groupId ? groupList.find((g) => g.id === b.groupId)?.name : names.get(b.athleteId!)}{b.focus ? ` · ${b.focus}` : ""}</span>
                    </span>
                    <ActionForm action={deletePlanBlockAction}>
                      <input type="hidden" name="blockId" value={b.id} />
                      <SubmitButton size="sm" variant="ghost" confirm={`Delete block "${b.name}"?`}>
                        Delete
                      </SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
