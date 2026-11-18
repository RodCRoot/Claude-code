import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Input } from "@/components/ui";
import { fmtDate } from "@/lib/time";
import type { ReachOutRow } from "@/lib/journey/steps";
import { logReachOutAction } from "@/app/(app)/follow-ups/actions";

/** One member to reach out to (a no-show or an absence) with "Log a reach-out". Nothing is sent. */
export function ReachOutItem({ r, reason }: { r: ReachOutRow; reason: "no_show" | "absent" }) {
  const uid = `${reason}-${r.athleteId.slice(0, 8)}`;
  return (
    <li className="px-4 py-3">
      <div className="text-sm">
        <Link href={`/people/${r.personId}`} className="font-medium underline">
          {r.name}
        </Link>
        <span className="block text-xs text-ink-3">{r.detail}</span>
        <span className="block text-xs text-ink-3">{r.lastReachOut ? `Last reach-out logged ${fmtDate(r.lastReachOut.at)}${r.lastReachOut.by ? ` by ${r.lastReachOut.by}` : ""}` : "No reach-out logged yet"}</span>
      </div>
      <details className="mt-2">
        <summary className="inline-flex h-8 cursor-pointer items-center rounded-md border border-edge px-3 text-xs font-semibold hover:bg-surface-2">
          Log a reach-out<span className="sr-only"> to {r.name}</span>
        </summary>
        <ActionForm action={logReachOutAction} className="mt-2 max-w-md space-y-2 rounded-md border border-edge bg-surface-2/50 p-3" resetOnSuccess>
          <input type="hidden" name="athleteId" value={r.athleteId} />
          <input type="hidden" name="reason" value={reason} />
          <label htmlFor={`ro-${uid}`} className="block text-xs font-medium text-ink-2">
            What you did and what they said (saved to staff notes)
          </label>
          <Input id={`ro-${uid}`} name="note" required minLength={3} maxLength={2000} />
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton size="sm">Save reach-out</SubmitButton>
            <Link href={`/messages/new?athlete=${r.athleteId}`} className="text-xs font-semibold text-brand underline">
              Write a message instead
            </Link>
          </div>
        </ActionForm>
      </details>
    </li>
  );
}
