"use client";

import { startTransition, useActionState } from "react";
import { FormMessage, SubmitButton, type ActionState } from "@/components/forms";
import { ShareLinkBox } from "./builder";

type ServerAction = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/** "Make a new link" and "Turn link off" for a published Showcase. */
export function LinkControls({ athleteId, canRotate, canRevoke, rotateAction, revokeAction }: { athleteId: string; canRotate: boolean; canRevoke: boolean; rotateAction: ServerAction; revokeAction: ServerAction }) {
  const [rot, rotate, rotating] = useActionState(rotateAction, {} as ActionState);
  const [rev, revoke, revoking] = useActionState(revokeAction, {} as ActionState);
  const submit = (fn: (fd: FormData) => void) => (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => fn(fd));
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {canRotate ? (
          <form onSubmit={submit(rotate)} aria-busy={rotating}>
            <input type="hidden" name="athleteId" value={athleteId} />
            <SubmitButton variant="secondary" pendingText="Working…" confirm="Make a new link? The link you shared before will stop working.">
              Make a new link
            </SubmitButton>
          </form>
        ) : null}
        {canRevoke ? (
          <form onSubmit={submit(revoke)} aria-busy={revoking}>
            <input type="hidden" name="athleteId" value={athleteId} />
            <SubmitButton variant="danger" pendingText="Turning off…" confirm="Turn the link off? It stops working right away for everyone who has it.">
              Turn link off
            </SubmitButton>
          </form>
        ) : null}
      </div>
      <FormMessage state={rot.error || rot.ok ? rot : rev} />
      {rot.ok && typeof rot.data?.sharePath === "string" ? <ShareLinkBox path={rot.data.sharePath} /> : null}
    </div>
  );
}
