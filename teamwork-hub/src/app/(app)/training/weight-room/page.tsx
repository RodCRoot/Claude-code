import { db } from "@/db";
import { requireStaff } from "@/lib/auth/viewer";
import { todayLocal } from "@/lib/time";
import { groupsForViewer } from "@/lib/training/assignments";
import { weightRoomRoster } from "@/lib/training/weightroom";
import { Button, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { TrainingNav } from "../_components/training-nav";
import { WeightRoom } from "../_components/weight-room";
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
    <div>
      <PageHeader kicker="Training" title="Weight room" description="Shared-tablet view: pick a group, tap an athlete, log their sets. Shows names and workouts only." />
      <TrainingNav viewer={viewer} current="weight-room" />
      {!groupList.length ? (
        <EmptyState title="No groups">You aren&apos;t assigned to coach any groups yet.</EmptyState>
      ) : (
        <>
          <form className="mb-5 flex flex-wrap items-end gap-3" method="get">
            <Field label="Group" htmlFor="wr-group">
              <Select id="wr-group" name="group" defaultValue={groupId}>
                {groupList.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date" htmlFor="wr-date">
              <Input id="wr-date" type="date" name="date" defaultValue={date} />
            </Field>
            <Button type="submit" variant="secondary" className="min-h-11">
              Open
            </Button>
          </form>
          {roster ? <WeightRoom key={`${groupId}-${date}`} athletes={roster.athletes} groupName={roster.group.name} date={date} /> : null}
        </>
      )}
    </div>
  );
}
