import type { TaskRow } from "@/lib/tasks";
import { completeTaskAction, reopenTaskAction } from "@/app/actions/team";
import { Badge, Button, Input } from "@/components/ui";

/** Server-rendered checklist with per-item complete/reopen forms. */
export function TaskChecklist({
  tasks,
  showDue = false,
  canComplete,
}: {
  tasks: TaskRow[];
  showDue?: boolean;
  canComplete: boolean;
}) {
  if (tasks.length === 0) {
    return <p className="py-3 text-sm text-ink-3">Nothing here — all clear.</p>;
  }
  return (
    <ul className="divide-y divide-edge/60">
      {tasks.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
          <form
            action={t.status === "done" ? reopenTaskAction : completeTaskAction}
            className="flex min-w-0 flex-1 items-center gap-3"
          >
            <input type="hidden" name="taskId" value={t.id} />
            {canComplete ? (
              <Button
                variant={t.status === "done" ? "secondary" : "outline"}
                size="sm"
                className="size-7 shrink-0 rounded-md p-0"
                aria-label={t.status === "done" ? "Reopen task" : "Complete task"}
                title={t.status === "done" ? "Reopen" : "Mark done"}
              >
                {t.status === "done" ? "✓" : ""}
              </Button>
            ) : (
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-edge text-xs">
                {t.status === "done" ? "✓" : ""}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span
                className={
                  t.status === "done"
                    ? "text-sm text-ink-3 line-through"
                    : "text-sm font-medium"
                }
              >
                {t.title}
              </span>
              <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                {showDue && (
                  <Badge variant={t.status === "open" ? "red" : "neutral"}>
                    due {t.dueDate}
                  </Badge>
                )}
                {t.assigneeName ? (
                  <Badge variant="neutral">{t.assigneeName}</Badge>
                ) : t.assignedRole ? (
                  <Badge variant="neutral">{t.assignedRole}</Badge>
                ) : null}
                {t.completedLate === 1 && <Badge variant="yellow">late</Badge>}
                {t.requiresApproval === 1 && t.status === "done" && (
                  <Badge variant="brand">needs approval</Badge>
                )}
              </span>
            </span>
            {t.status === "open" && canComplete ? (
              <Input
                name="proofNote"
                placeholder="note / proof link (optional)"
                className="hidden h-7 w-48 text-xs sm:block"
              />
            ) : t.proofNote ? (
              <span className="hidden max-w-48 truncate text-xs text-ink-3 sm:block" title={t.proofNote}>
                {t.proofNote}
              </span>
            ) : null}
          </form>
        </li>
      ))}
    </ul>
  );
}
