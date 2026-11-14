import { db } from "@/db";
import { requireStaff } from "@/lib/auth/viewer";
import { cn } from "@/lib/cn";
import { todayLocal } from "@/lib/time";
import { groupsForViewer } from "@/lib/training/assignments";
import { weightRoomRoster } from "@/lib/training/weightroom";
import { Button, EmptyState, Field, Input, Select } from "@/components/ui";
import { TrainingNav } from "../_components/training-nav";
import { WeightRoom } from "../_components/weight-room";
import { BOARD_THEME } from "../_components/tb";
import { guarded, isYmd, sp } from "../_lib/helpers";

export const metadata = { title: "Weight room" };

export default async function WeightRoomPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireStaff();
  const q = await searchParams;
  const groupList = await groupsForViewer(db, viewer);
  const groupId = groupList.find((g) => g.id === sp(q.group))?.id ?? groupList[0]?.id;
  const date = isYmd(sp(q.date)) ? sp(q.date) : todayLocal();
  const roster = groupId ? await guarded(() => weightRoomRoster(db, viewer, groupId, date)) : null;

  return (
    // Full-bleed dark board: cancels the app frame's side/bottom padding for this page only.
    <div className={cn(BOARD_THEME, "-mx-4 -mt-4 -mb-8 min-h-[calc(100vh-3.5rem)] px-4 pt-5 pb-10 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8")}>
      <header className="mb-4 min-w-0">
        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand">Training · Weight room</div>
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{roster ? roster.group.name : "Weight room"}</h1>
        <p className="mt-0.5 max-w-3xl text-sm text-ink-3">Shared-tablet view: pick a group, tap an athlete, log their sets. Shows names and workouts only.</p>
      </header>
      <TrainingNav viewer={viewer} current="weight-room" />
      {!groupList.length ? (
        <EmptyState title="No groups">You aren&apos;t assigned to coach any groups yet.</EmptyState>
      ) : (
        <>
          <form className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-edge bg-surface p-3" method="get">
            <Field label="Group" htmlFor="wr-group">
              <Select id="wr-group" name="group" defaultValue={groupId} className="h-11! min-w-48">
                {groupList.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date" htmlFor="wr-date">
              <Input id="wr-date" type="date" name="date" defaultValue={date} className="h-11!" />
            </Field>
            <Button type="submit" variant="primary" className="min-h-11">
              Open
            </Button>
          </form>
          {roster ? <WeightRoom key={`${groupId}-${date}`} athletes={roster.athletes} groupName={roster.group.name} date={date} /> : null}
        </>
      )}
    </div>
  );
}
