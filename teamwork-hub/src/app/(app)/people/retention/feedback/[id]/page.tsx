import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { requireStaff } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { fmt } from "@/lib/time";
import { feedbackDetail, RATING_LABELS } from "@/lib/retention/feedback";
import { Badge, ButtonLink, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { RatingText } from "@/components/retention/parts";

export const metadata = { title: "Session feedback" };

export default async function FeedbackDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let f: Awaited<ReturnType<typeof feedbackDetail>>;
  try {
    f = await feedbackDetail(db, v, id);
  } catch (e) {
    if (e instanceof AuthzError) redirect("/denied");
    throw e;
  }
  return (
    <>
      <PageHeader
        kicker="Retention · Session feedback"
        title={`Feedback from ${f.athleteName}`}
        description={`${f.sessionTitle} · ${fmt(f.sessionStartsAt, "EEE MMM d, h:mm a", f.timezone)}${f.coachName ? ` · ${f.coachName}` : ""}`}
        actions={
          <>
            <ButtonLink href={`/people/${f.personId}`} variant="secondary">
              Open profile
            </ButtonLink>
            <ButtonLink href={`/messages/new?athlete=${f.athleteId}`}>Open conversation</ButtonLink>
          </>
        }
      />
      <Card className="max-w-2xl">
        <CardHeader
          title="Response"
          kicker={`Left by the ${f.submittedByRole === "guardian" ? "parent / guardian" : "athlete"} · ${fmt(f.createdAt, "MMM d, yyyy h:mm a", f.timezone)}`}
          action={f.tellCoach ? <Badge variant="blue">Shared with coach</Badge> : <Badge>Not shared with coach</Badge>}
        />
        <CardBody className="space-y-3 text-sm">
          <p>
            <RatingText rating={f.rating} label={RATING_LABELS[f.rating]} />
          </p>
          {f.comment ? <blockquote className="whitespace-pre-wrap rounded-md border-l-4 border-edge bg-surface-2 px-3 py-2 text-ink-2">{f.comment}</blockquote> : <p className="text-ink-3">No comment was left.</p>}
          {!f.tellCoach ? <p className="text-xs text-ink-3">The family did not tick “tell my coach”. Coaches see only class averages: do not pass this on with a name.</p> : null}
          <p className="text-xs text-ink-3">
            Nothing was sent to the family. Follow up personally, then log what happened on the{" "}
            <Link href="/people/retention" className="font-medium text-brand underline">
              retention radar
            </Link>
            .
          </p>
        </CardBody>
      </Card>
    </>
  );
}
