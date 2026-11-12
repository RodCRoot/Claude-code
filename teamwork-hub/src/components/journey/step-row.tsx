import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Input, Select } from "@/components/ui";
import { fmtDate } from "@/lib/time";
import { stepHref, type StepView } from "@/lib/journey/steps";
import { AUTO_RULES, OWNER_ROLE_LABEL, REVIEW_OUTCOMES, STEP_LINKS, type AutoRule } from "@/lib/journey/templates";
import { assignStepAction, completeStepAction, skipStepAction, snoozeStepAction } from "@/app/(app)/follow-ups/actions";

export type StaffOption = { id: string; name: string };

const OUTCOMES: Record<string, (keyof typeof REVIEW_OUTCOMES)[]> = { review_ask: ["asked", "reviewed", "declined"], referral_ask: ["asked", "referred", "declined"] };

function DueBadge({ s }: { s: StepView }) {
  if (s.state === "done") return <Badge variant="green">{s.completedVia === "auto" ? "Ticked automatically" : "Done"}</Badge>;
  if (s.state === "skipped") return <Badge>Skipped</Badge>;
  if (s.state === "snoozed") return <Badge variant="blue">Snoozed to {fmtDate(s.snoozedUntil)}</Badge>;
  if (s.overdueDays > 0) return <Badge variant="red">{s.overdueDays} day{s.overdueDays === 1 ? "" : "s"} overdue</Badge>;
  return <Badge variant="yellow">Due {fmtDate(s.dueOn)}</Badge>;
}

/**
 * One journey step with its actions: one-tap Done (or a short form when the step records a
 * conversation, an outcome or a date), skip with a reason, snooze, assign. Every action is a
 * server action that re-checks scope; nothing here sends a message.
 */
export function StepRow({ s, staff, showAthlete = true, canAssign = true, coachView = false }: { s: StepView; staff: StaffOption[]; showAthlete?: boolean; canAssign?: boolean; /** Coaches cannot open the referral, win-back, billing or documents pages, so those links are left out. */ coachView?: boolean }) {
  const open = s.state === "open" || s.state === "snoozed";
  const href = coachView && s.link && ["referrals", "winback", "billing", "documents"].includes(s.link) ? null : stepHref(s.link, s);
  const about = `${s.name} for ${s.athleteName}`;
  const uid = s.taskId.slice(0, 8);
  return (
    <li className="px-4 py-3" data-step={s.stepKey}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{s.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
            {showAthlete ? (
              <Link href={`/people/${s.personId}`} className="font-medium text-ink-2 underline">
                {s.athleteName}
              </Link>
            ) : null}
            <span>{OWNER_ROLE_LABEL[s.ownerRole]}</span>
            <span>{s.assigneeName ? `Assigned to ${s.assigneeName}` : "Unassigned"}</span>
            {s.billing ? <Badge>Billing</Badge> : null}
            {s.originalDueOn ? <span>Moved from {fmtDate(s.originalDueOn)} for a hold</span> : null}
          </div>
          {open && s.autoRule ? <p className="mt-1 text-xs text-ink-3">Ticks itself when: {AUTO_RULES[s.autoRule as AutoRule]?.label.toLowerCase() ?? s.autoRule}.</p> : null}
          {s.state === "done" ? (
            <p className="mt-1 text-xs text-ink-3">
              {s.completedAt ? fmtDate(s.completedAt) : ""}
              {s.completedByName ? ` by ${s.completedByName}` : ""}
              {s.outcome ? ` · ${REVIEW_OUTCOMES[s.outcome as keyof typeof REVIEW_OUTCOMES] ?? `Win-back date ${fmtDate(s.outcome)}`}` : ""}
              {s.note ? ` · ${s.note}` : ""}
            </p>
          ) : null}
          {s.state === "skipped" && s.skipReason ? <p className="mt-1 text-xs text-ink-3">Reason: {s.skipReason}</p> : null}
        </div>
        <DueBadge s={s} />
      </div>

      {open ? (
        <div className="mt-2 flex flex-wrap items-start gap-2">
          {s.input === "none" ? (
            <ActionForm action={completeStepAction}>
              <input type="hidden" name="taskId" value={s.taskId} />
              <SubmitButton size="sm" pendingText="Saving…">
                Done<span className="sr-only">: {about}</span>
              </SubmitButton>
            </ActionForm>
          ) : (
            <details className="min-w-0 basis-full sm:basis-auto">
              <summary className="inline-flex h-8 cursor-pointer items-center rounded-md bg-brand px-3 text-xs font-semibold text-brand-ink">
                {s.input === "note" ? "Log it" : s.input === "date" ? "Set the date" : "Record outcome"}
                <span className="sr-only">: {about}</span>
              </summary>
              <ActionForm action={completeStepAction} className="mt-2 max-w-md space-y-2 rounded-md border border-edge bg-surface-2/50 p-3">
                <input type="hidden" name="taskId" value={s.taskId} />
                {s.input === "note" ? (
                  <>
                    <label htmlFor={`note-${uid}`} className="block text-xs font-medium text-ink-2">
                      What was said (saved to staff notes)
                    </label>
                    <Input id={`note-${uid}`} name="note" required minLength={3} maxLength={2000} />
                  </>
                ) : null}
                {s.input === "outcome" ? (
                  <>
                    <label htmlFor={`outcome-${uid}`} className="block text-xs font-medium text-ink-2">
                      What happened
                    </label>
                    <Select id={`outcome-${uid}`} name="outcome" required defaultValue="">
                      <option value="" disabled>
                        Choose…
                      </option>
                      {(OUTCOMES[s.stepKey] ?? ["asked", "declined"]).map((o) => (
                        <option key={o} value={o}>
                          {REVIEW_OUTCOMES[o]}
                        </option>
                      ))}
                    </Select>
                  </>
                ) : null}
                {s.input === "date" ? (
                  <>
                    <label htmlFor={`date-${uid}`} className="block text-xs font-medium text-ink-2">
                      Win-back date (creates a follow-up task for that day)
                    </label>
                    <Input id={`date-${uid}`} name="date" type="date" required />
                  </>
                ) : null}
                <SubmitButton size="sm">Save and mark done</SubmitButton>
              </ActionForm>
            </details>
          )}
          {href ? (
            <Link href={href} className="inline-flex h-8 items-center rounded-md border border-edge px-3 text-xs font-semibold hover:bg-surface-2">
              {STEP_LINKS[s.link!]}
              <span className="sr-only"> ({about})</span>
            </Link>
          ) : null}
          <details className="min-w-0 basis-full sm:basis-auto">
            <summary className="inline-flex h-8 cursor-pointer items-center rounded-md border border-edge px-3 text-xs font-semibold text-ink-2 hover:bg-surface-2">
              Skip, snooze or assign<span className="sr-only">: {about}</span>
            </summary>
            <div className="mt-2 grid max-w-2xl gap-3 rounded-md border border-edge bg-surface-2/50 p-3 sm:grid-cols-3">
              <ActionForm action={skipStepAction} className="space-y-1.5">
                <input type="hidden" name="taskId" value={s.taskId} />
                <label htmlFor={`skip-${uid}`} className="block text-xs font-medium text-ink-2">
                  Skip: reason
                </label>
                <Input id={`skip-${uid}`} name="reason" required minLength={3} maxLength={300} />
                <SubmitButton size="sm" variant="secondary">
                  Skip step
                </SubmitButton>
              </ActionForm>
              <ActionForm action={snoozeStepAction} className="space-y-1.5">
                <input type="hidden" name="taskId" value={s.taskId} />
                <label htmlFor={`snooze-${uid}`} className="block text-xs font-medium text-ink-2">
                  Snooze for
                </label>
                <Select id={`snooze-${uid}`} name="days" defaultValue="3">
                  <option value="1">1 day</option>
                  <option value="3">3 days</option>
                  <option value="7">1 week</option>
                  <option value="14">2 weeks</option>
                </Select>
                <SubmitButton size="sm" variant="secondary">
                  Snooze
                </SubmitButton>
              </ActionForm>
              {canAssign ? (
                <ActionForm action={assignStepAction} className="space-y-1.5">
                  <input type="hidden" name="taskId" value={s.taskId} />
                  <label htmlFor={`assign-${uid}`} className="block text-xs font-medium text-ink-2">
                    Assign to
                  </label>
                  <Select id={`assign-${uid}`} name="userId" defaultValue={s.assigneeUserId ?? ""}>
                    <option value="">Nobody</option>
                    {staff.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                  <SubmitButton size="sm" variant="secondary">
                    Assign
                  </SubmitButton>
                </ActionForm>
              ) : null}
            </div>
          </details>
        </div>
      ) : null}
    </li>
  );
}
