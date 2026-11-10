import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { EmptyState } from "@/components/ui";
import { anywhereAccess } from "@/lib/anywhere/common";
import { sessionForAthlete } from "@/lib/anywhere/sessions";
import { AuthzError } from "@/lib/authz/policy";
import { ModuleHero } from "../../../training/_components/tb";
import { SessionPlayer } from "../../_components/session-player";
import { familyContext, SafetyNote, SessionMeta } from "../../_shared";

export const metadata = { title: "On Your Own session" };

export default async function AnywhereSessionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ athlete?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { v, children, child } = await familyContext(sp.athlete);
  if (!child || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const back = `/anywhere${children.length > 1 ? `?athlete=${child.athleteId}` : ""}`;
  const access = await anywhereAccess(db, v, child.athleteId);
  // Unpublished, not suitable for this athlete's age, another organization's, or no training access: same answer.
  const session = await sessionForAthlete(db, v, child.athleteId, id).catch((e) => {
    if (e instanceof AuthzError) return null;
    throw e;
  });
  if (!session || !access) {
    return (
      <div className="mx-auto max-w-3xl">
        <ModuleHero kicker="On Your Own" title="Session not available" />
        <EmptyState title="That session is not available" action={<Link href={back} className="font-semibold text-brand underline">Back to On Your Own</Link>}>
          It may have been changed by your coach. Pick another one from the list.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-3xl">
      <ModuleHero kicker="On Your Own" title={session.title} description={session.description ?? undefined}>
        <SessionMeta s={session} />
      </ModuleHero>
      <SafetyNote className="mb-4" />
      <SessionPlayer
        athleteId={child.athleteId}
        sessionId={session.id}
        plannedMinutes={session.durationMinutes}
        canLog={access.canLog}
        backHref={back}
        steps={session.steps.map((s) => ({ id: s.id, name: s.exercise.name, prescription: s.prescription, cue: s.cue, notes: s.exercise.coachingNotes, videoUrl: s.exercise.videoUrl }))}
      />
      <p className="mt-4">
        <Link href={back} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand underline">
          Back to all sessions
        </Link>
      </p>
    </div>
  );
}
