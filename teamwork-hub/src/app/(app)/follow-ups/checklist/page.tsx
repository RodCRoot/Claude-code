import Link from "next/link";
import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { OPS_SECTIONS } from "@/db/schema";
import { listLocations, parseLocationParam } from "@/lib/locations";
import { OPS_SECTION_LABEL, opsChecklistForDay, opsMonthGrid } from "@/lib/journey/ops";
import { addMonthsYmd } from "@/lib/journey/templates";
import { addDaysYmd, fmtDate, fmtTime, isoWeekday } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { Segmented } from "@/components/profile/studio";
import { FollowUpTabs } from "@/components/journey/tabs";
import { setOpsTickAction } from "../actions";

export const metadata = { title: "Operations checklist" };

const monthLabel = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1, 12)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export default async function OpsChecklistPage({ searchParams }: { searchParams: Promise<{ location?: string; day?: string; month?: string }> }) {
  const v = await requireCap("ops_checklist.use");
  const sp = await searchParams;
  const locations = await listLocations(db, v.orgId, { activeOnly: true });
  const chosen = parseLocationParam(sp.location);
  const locationId = locations.find((l) => l.id === chosen)?.id ?? locations[0]?.id ?? null;
  const base = await opsChecklistForDay(db, v, { locationId });
  const yesterday = addDaysYmd(base.today, -1);
  const day = sp.day === yesterday ? yesterday : base.today;
  const list = day === base.today ? base : await opsChecklistForDay(db, v, { locationId, day });
  const grid = await opsMonthGrid(db, v, { locationId, month: sp.month });
  const q = (extra: Record<string, string>) => {
    const all: Record<string, string> = { ...(locationId ? { location: locationId } : {}), ...(day !== base.today ? { day } : {}), ...(sp.month ? { month: sp.month } : {}), ...extra };
    const p = new URLSearchParams(Object.entries(all).filter(([, val]) => val));
    const s = p.toString();
    return `/follow-ups/checklist${s ? `?${s}` : ""}`;
  };
  const lead = isoWeekday(grid.days[0].day) - 1;
  const prevMonth = addMonthsYmd(`${grid.month}-01`, -1).slice(0, 7);
  const nextMonth = addMonthsYmd(`${grid.month}-01`, 1).slice(0, 7);

  return (
    <>
      <PageHeader
        kicker="Front desk"
        title="Operations checklist"
        description="Opening, closing, cleaning and weekly tasks, ticked by whoever is on shift. Weekly tasks are ticked once per week."
        actions={
          can(v, "settings.manage") ? (
            <Link href="/settings/journey#ops-checklist" className="text-sm font-semibold text-brand underline">
              Edit the list
            </Link>
          ) : null
        }
      />
      <FollowUpTabs current="checklist" showReport={can(v, "journey.report")} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {locations.length > 1 ? <Segmented label="Location" items={locations.map((l) => ({ href: q({ location: l.id }), label: l.name, current: l.id === locationId }))} /> : null}
        <Segmented
          label="Day"
          items={[
            { href: q({ day: "" }), label: `Today, ${fmtDate(base.today)}`, current: day === base.today },
            { href: q({ day: yesterday }), label: "Yesterday", current: day === yesterday },
          ]}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          {list.items.length === 0 ? (
            <Card>
              <EmptyState title="No checklist yet">{can(v, "settings.manage") ? "Add items in Settings > Member journey." : "An owner or admin can add items in Settings."}</EmptyState>
            </Card>
          ) : null}
          {OPS_SECTIONS.map((section) => {
            const items = list.items.filter((i) => i.section === section);
            if (!items.length) return null;
            const done = items.filter((i) => i.tick).length;
            return (
              <Card key={section}>
                <CardHeader title={OPS_SECTION_LABEL[section]} kicker={`${done} of ${items.length} done`} />
                <ul className="divide-y divide-edge">
                  {items.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                      <div className="min-w-0 flex-1 text-sm">
                        <span className={i.tick ? "text-ink-3 line-through" : "font-medium"}>{i.label}</span>
                        {i.tick ? (
                          <span className="block text-xs text-ink-3">
                            Done by {i.tick.by} at {fmtTime(i.tick.at)}
                          </span>
                        ) : null}
                      </div>
                      <ActionForm action={setOpsTickAction}>
                        <input type="hidden" name="itemId" value={i.id} />
                        <input type="hidden" name="day" value={day} />
                        <input type="hidden" name="done" value={i.tick ? "0" : "1"} />
                        <SubmitButton size="sm" variant={i.tick ? "secondary" : "primary"} pendingText="…">
                          {i.tick ? "Undo" : "Done"}
                          <span className="sr-only">: {i.label}</span>
                        </SubmitButton>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>

        <Card>
          <CardHeader
            title={monthLabel(grid.month)}
            kicker="Daily items done"
            action={
              <span className="flex gap-3 text-xs font-semibold">
                <Link href={q({ month: prevMonth })} className="text-brand underline">
                  Previous<span className="sr-only"> month</span>
                </Link>
                <Link href={q({ month: nextMonth })} className="text-brand underline">
                  Next<span className="sr-only"> month</span>
                </Link>
              </span>
            }
          />
          <CardBody>
            {grid.dailyTotal === 0 ? (
              <p className="text-sm text-ink-3">No daily items for this location.</p>
            ) : (
              <>
                <ol className="grid grid-cols-7 gap-1 text-center text-xs" aria-label={`Completion for ${monthLabel(grid.month)}`}>
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                    <li key={d} aria-hidden className="pb-1 font-semibold text-ink-3">
                      {d}
                    </li>
                  ))}
                  {Array.from({ length: lead }, (_, i) => (
                    <li key={`pad-${i}`} aria-hidden />
                  ))}
                  {grid.days.map((d) => {
                    const full = d.done >= d.total;
                    const tone = d.future ? "border-edge text-ink-3" : full ? "border-ok/40 bg-ok/10 text-ok" : d.done > 0 ? "border-warn/40 bg-warn/10 text-warn" : "border-edge bg-surface-2 text-ink-3";
                    return (
                      <li key={d.day} className={`rounded-md border px-1 py-1.5 ${tone}`}>
                        <span className="block font-semibold text-ink">{Number(d.day.slice(8))}</span>
                        <span className="block tabular">
                          {d.future ? <span aria-hidden>·</span> : `${d.done}/${d.total}`}
                          <span className="sr-only">{d.future ? " not yet" : full ? " all done" : " done"}</span>
                        </span>
                      </li>
                    );
                  })}
                </ol>
                <p className="mt-3 text-xs text-ink-3">Each day shows items done out of {grid.dailyTotal}. Green is a full day, amber a partial one.</p>
              </>
            )}
            {grid.weekly.some((w) => w.total > 0) ? (
              <div className="mt-4 border-t border-edge pt-3">
                <h3 className="text-xs font-bold uppercase tracking-wide text-ink-2">Weekly tasks</h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {grid.weekly.map((w) => (
                    <li key={w.weekStart} className="flex justify-between">
                      <span>Week of {fmtDate(w.weekStart)}</span>
                      <span className="tabular">
                        {w.done} of {w.total}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
