import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { WinsStaffTabs } from "@/components/wins/staff";
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, Input, Textarea } from "@/components/ui";
import { getOrg, requireCap } from "@/lib/auth/viewer";
import { fmt, fmtDate } from "@/lib/time";
import { CONSENT_LABEL, DETAIL_MAX, HEADLINE_MAX } from "@/lib/wins/shared";
import { reviewQueue, type ReviewItem } from "@/lib/wins/wins";
import { ModuleHero } from "../../training/_components/tb";
import { approveWinAction, editWinAction, photoApprovalAction, withdrawWinAction } from "../actions";

export const metadata = { title: "Review wins" };

const SUBMITTED_BY = { athlete: "the athlete", guardian: "a parent or guardian", staff: "staff" } as const;

function Meta({ w, tz }: { w: ReviewItem; tz?: string }) {
  return (
    <>
      <p className="flex flex-wrap items-center gap-2">
        <Link href={`/people/${w.personId}`} className="text-[15px] font-bold hover:underline">
          {w.athleteName}
        </Link>
        <Badge variant="yellow">{w.typeLabel}</Badge>
        <span className="text-xs text-ink-3">
          {w.sport} · {fmtDate(w.occurredOn)}
        </span>
      </p>
      <p className="mt-1 text-xs text-ink-3">
        Sent by {SUBMITTED_BY[w.submittedAs]}
        {w.submittedByName ? ` (${w.submittedByName})` : ""} on {fmt(w.createdAt, "MMM d", tz)} · Others would see: <strong>{w.displayName ?? "nothing (name hidden)"}</strong> · App feed {w.showInApp ? "on" : "off"}, TV {w.showOnTv ? "on" : "off"} · Marketing consent: {CONSENT_LABEL[w.marketingConsent].toLowerCase()}
      </p>
      {w.sourceUrl ? (
        <p className="mt-1 text-xs">
          <a href={w.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold text-brand underline">
            Source link<span className="sr-only"> for {w.athleteName} (opens in a new tab)</span>
          </a>{" "}
          <span className="text-ink-3">Staff and the family only. Never shown on the feed or the TV.</span>
        </p>
      ) : null}
    </>
  );
}

function RemoveForm({ w }: { w: ReviewItem }) {
  return (
    <details>
      <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-2 underline">
        Remove<span className="sr-only">: {w.headline}</span>
      </summary>
      <ActionForm action={withdrawWinAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="winId" value={w.id} />
        <Field label="Reason (kept in the audit log)" htmlFor={`rm-${w.id}`} required className="min-w-0 flex-1">
          <Input id={`rm-${w.id}`} name="reason" required maxLength={200} autoComplete="off" />
        </Field>
        <SubmitButton variant="secondary" pendingText="Removing…">
          Remove win
        </SubmitButton>
      </ActionForm>
    </details>
  );
}

function Photo({ w }: { w: ReviewItem }) {
  if (!w.hasPhoto) return null;
  // eslint-disable-next-line @next/next/no-img-element -- served by an auth-checked route
  return <img src={`/api/wins/${w.id}/photo`} alt={`Photo sent with: ${w.headline}`} className="mt-2 max-h-48 rounded-md border border-edge" />;
}

export default async function WinsReviewPage() {
  const v = await requireCap("wins.review");
  const tz = (await getOrg(v.orgId))?.timezone;
  const [queue, approved] = await Promise.all([reviewQueue(db, v), reviewQueue(db, v, { statuses: ["approved"], limit: 25 })]);
  const pending = queue.filter((w) => w.status === "pending");
  const waiting = queue.filter((w) => w.status === "awaiting_family");
  return (
    <div className="mx-auto max-w-6xl">
      <ModuleHero kicker="Wins" title="Review" description="Nothing is shown to anyone but the athlete's own family until you approve it. Check the wording: first names only, and nothing about health, injuries, body weight or school grades." />
      <WinsStaffTabs v={v} current="review" />
      <div className="space-y-4">
        <Card id="wins-pending">
          <CardHeader title="Waiting for review" kicker={`${pending.length} win${pending.length === 1 ? "" : "s"}`} />
          <CardBody>
            {pending.length === 0 ? <EmptyState title="Nothing waiting">New wins from athletes, parents and staff show up here.</EmptyState> : null}
            <ul className="divide-y divide-edge">
              {pending.map((w) => (
                <li key={w.id} className="space-y-2 py-4 first:pt-0 last:pb-0">
                  <Meta w={w} tz={tz} />
                  <Photo w={w} />
                  <ActionForm action={approveWinAction} className="space-y-3">
                    <input type="hidden" name="winId" value={w.id} />
                    <Field label="Headline" htmlFor={`h-${w.id}`} required hint={w.marketingConsent === "granted" ? "The family gave marketing consent for this wording, so it cannot be changed." : `You can tidy the wording before approving. Up to ${HEADLINE_MAX} characters.`}>
                      <Input id={`h-${w.id}`} name="headline" required maxLength={HEADLINE_MAX} defaultValue={w.headline} autoComplete="off" />
                    </Field>
                    <Field label="Detail (optional)" htmlFor={`d-${w.id}`}>
                      <Textarea id={`d-${w.id}`} name="detail" rows={2} maxLength={DETAIL_MAX} defaultValue={w.detail ?? ""} />
                    </Field>
                    {w.hasPhoto ? (
                      <label className="flex min-h-11 items-center gap-3 text-sm">
                        <input type="checkbox" name="approvePhoto" className="size-5 shrink-0 accent-brand" />
                        <span>
                          Approve the photo for display too<span className="sr-only">: {w.headline}</span>
                        </span>
                      </label>
                    ) : null}
                    <SubmitButton pendingText="Approving…">
                      Approve<span className="sr-only">: {w.headline}</span>
                    </SubmitButton>
                  </ActionForm>
                  <RemoveForm w={w} />
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        {waiting.length ? (
          <Card id="wins-awaiting">
            <CardHeader title="Drafts waiting for a family" kicker="From leads" />
            <CardBody>
              <ul className="divide-y divide-edge">
                {waiting.map((w) => (
                  <li key={w.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
                    <Meta w={w} tz={tz} />
                    <p className="font-medium">{w.headline}</p>
                    <p className="text-xs text-ink-3">The family sees this in the app and can confirm or remove it. No message was sent; mention it next time they are in.</p>
                    <RemoveForm w={w} />
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}

        <Card id="wins-approved">
          <CardHeader title="Recently approved" kicker="Edit wording, photo, or remove" />
          <CardBody>
            {approved.length === 0 ? <p className="text-sm text-ink-3">No approved wins yet.</p> : null}
            <ul className="divide-y divide-edge">
              {approved.map((w) => (
                <li key={w.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
                  <Meta w={w} tz={tz} />
                  <p className="font-medium">{w.headline}</p>
                  {w.detail ? <p className="text-sm text-ink-2">{w.detail}</p> : null}
                  <details>
                    <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-2 underline">
                      Edit wording{w.hasPhoto ? " or photo" : ""}
                      <span className="sr-only">: {w.headline}</span>
                    </summary>
                    <div className="space-y-3">
                      <ActionForm action={editWinAction} className="space-y-3">
                        <input type="hidden" name="winId" value={w.id} />
                        <Field label="Headline" htmlFor={`eh-${w.id}`} required>
                          <Input id={`eh-${w.id}`} name="headline" required maxLength={HEADLINE_MAX} defaultValue={w.headline} autoComplete="off" />
                        </Field>
                        <Field label="Detail (optional)" htmlFor={`ed-${w.id}`}>
                          <Textarea id={`ed-${w.id}`} name="detail" rows={2} maxLength={DETAIL_MAX} defaultValue={w.detail ?? ""} />
                        </Field>
                        <SubmitButton variant="secondary">Save wording</SubmitButton>
                      </ActionForm>
                      {w.hasPhoto ? (
                        <div>
                          <Photo w={w} />
                          <ActionForm action={photoApprovalAction} className="mt-2">
                            <input type="hidden" name="winId" value={w.id} />
                            <input type="hidden" name="approved" value={w.photoApproved ? "no" : "yes"} />
                            <SubmitButton variant="secondary" size="sm">
                              {w.photoApproved ? "Take the photo off display" : "Approve the photo for display"}
                            </SubmitButton>
                          </ActionForm>
                        </div>
                      ) : null}
                    </div>
                  </details>
                  <RemoveForm w={w} />
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
