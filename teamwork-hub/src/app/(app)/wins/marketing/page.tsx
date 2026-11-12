import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { CopyCaption } from "@/components/wins/client";
import { WinsStaffTabs } from "@/components/wins/staff";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, Select } from "@/components/ui";
import { MARKETING_CHANNELS } from "@/db/schema";
import { getOrg, requireCap } from "@/lib/auth/viewer";
import { fmt, fmtDate, todayLocal } from "@/lib/time";
import { marketingQueue } from "@/lib/wins/marketing";
import { CHANNEL_LABEL, CONSENT_LABEL } from "@/lib/wins/shared";
import { ModuleHero } from "../../training/_components/tb";
import { markPostedAction, markTakenDownAction, requestConsentAction } from "../actions";

export const metadata = { title: "Marketing queue" };

export default async function MarketingQueuePage() {
  const v = await requireCap("wins.marketing");
  const tz = (await getOrg(v.orgId))?.timezone;
  const today = todayLocal(tz);
  const q = await marketingQueue(db, v);
  return (
    <div className="mx-auto max-w-6xl">
      <ModuleHero kicker="Wins" title="Marketing queue" description="Approved wins whose family said yes to public marketing. Copy a caption and post it yourself; this app posts nothing anywhere and sends no messages." />
      <WinsStaffTabs v={v} current="marketing" />

      {q.takeDown.length ? (
        <Callout tone="bad" title="Take these down" className="mb-4">
          <p>These were marked as posted, and since then the family withdrew permission, the win was removed, or the athlete was hidden. Remove the posts, then confirm here.</p>
          <ul className="mt-2 divide-y divide-edge">
            {q.takeDown.map((t) => (
              <li key={t.winId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 text-ink">
                  <span className="font-semibold">{t.athleteName}</span>: {t.headline}
                  <span className="block text-xs text-ink-2">
                    {t.reason}. Posted on {t.posts.map((p) => `${CHANNEL_LABEL[p.channel]} (${fmtDate(p.postedOn)})`).join(", ")}
                  </span>
                </span>
                <ActionForm action={markTakenDownAction}>
                  <input type="hidden" name="winId" value={t.winId} />
                  <SubmitButton variant="secondary" size="sm" confirm="Confirm that every post of this win has been taken down?">
                    Posts taken down<span className="sr-only">: {t.headline}</span>
                  </SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <div className="space-y-4">
        <Card id="marketing-ready">
          <CardHeader title="Ready to post" kicker={`${q.ready.length} with family consent`} />
          <CardBody>
            {q.ready.length === 0 ? <EmptyState title="Nothing ready yet">A win appears here once it is approved and the family has given marketing consent.</EmptyState> : null}
            <ul className="divide-y divide-edge">
              {q.ready.map((i) => (
                <li key={i.winId} className="space-y-3 py-4 first:pt-0 last:pb-0">
                  <div>
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="text-[15px] font-bold">{i.displayName}</span>
                      <Badge variant="yellow">{i.typeLabel}</Badge>
                      <Badge variant="green">Consent given{i.consentAt ? ` ${fmt(i.consentAt, "MMM d", tz)}` : ""}</Badge>
                      {i.posts.map((p) => (
                        <Badge key={`${p.channel}-${p.postedOn}`} variant="blue">
                          Posted: {CHANNEL_LABEL[p.channel]}, {fmtDate(p.postedOn)}
                        </Badge>
                      ))}
                    </p>
                    <p className="mt-1 font-medium">{i.headline}</p>
                    {i.detail ? <p className="text-sm text-ink-2">{i.detail}</p> : null}
                    <p className="mt-1 text-xs text-ink-3">
                      {i.sport} · {fmtDate(i.occurredOn)} · Use the name <strong>{i.displayName}</strong> only. Family record:{" "}
                      <Link href={`/people/${i.personId}`} className="underline">
                        {i.athleteName}
                      </Link>
                      {i.photo ? " · An approved photo is on the win (open the Review tab to view it)." : " · No approved photo."}
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    {i.captions.map((c, idx) => (
                      <CopyCaption key={c.label} id={`cap-${i.winId}-${idx}`} label={`Draft: ${c.label}`} text={c.text} />
                    ))}
                  </div>
                  <ActionForm action={markPostedAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="winId" value={i.winId} />
                    <Field label="Posted on" htmlFor={`ch-${i.winId}`}>
                      <Select id={`ch-${i.winId}`} name="channel" defaultValue="instagram">
                        {MARKETING_CHANNELS.map((c) => (
                          <option key={c} value={c}>
                            {CHANNEL_LABEL[c]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Date" htmlFor={`pd-${i.winId}`}>
                      <Input id={`pd-${i.winId}`} name="postedOn" type="date" defaultValue={today} max={today} required />
                    </Field>
                    <SubmitButton variant="secondary">
                      Mark as posted<span className="sr-only">: {i.headline}</span>
                    </SubmitButton>
                  </ActionForm>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-3">Caption drafts are sample wording from fixed templates, filled in on this page. Edit them before posting.</p>
          </CardBody>
        </Card>

        <Card id="marketing-ask">
          <CardHeader title="Approved, no marketing consent" kicker="Do not post these" />
          <CardBody>
            {q.needConsent.length === 0 ? <p className="text-sm text-ink-3">None.</p> : null}
            <ul className="divide-y divide-edge">
              {q.needConsent.map((i) => (
                <li key={i.winId} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
                  <span className="min-w-0 text-sm">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">{i.athleteName}</span>
                      <Badge variant="yellow">{i.typeLabel}</Badge>
                      <Badge variant={i.consent === "none" ? "neutral" : "red"}>{i.consent === "none" ? (i.asked ? "Asked, no answer yet" : "Not asked") : CONSENT_LABEL[i.consent]}</Badge>
                    </span>
                    <span className="mt-1 block font-medium">{i.headline}</span>
                  </span>
                  {i.consent === "none" && !i.asked ? (
                    <ActionForm action={requestConsentAction}>
                      <input type="hidden" name="winId" value={i.winId} />
                      <SubmitButton variant="secondary" size="sm" pendingText="Asking…">
                        Ask the family<span className="sr-only">: {i.headline}</span>
                      </SubmitButton>
                    </ActionForm>
                  ) : i.consent === "none" ? (
                    <span className="text-xs text-ink-3">Shown to the family in the app.</span>
                  ) : (
                    <span className="text-xs text-ink-3">The family can change this themselves.</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-3">&ldquo;Ask the family&rdquo; puts a request on the parent or guardian&apos;s Home and Wins pages (the athlete&apos;s own, for adults). It sends no email or text. Athletes whose names are hidden are never listed here.</p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
