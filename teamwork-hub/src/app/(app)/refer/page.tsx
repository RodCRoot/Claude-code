import QRCode from "qrcode";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { CopyLink } from "@/components/growth/copy-link";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { env } from "@/lib/env";
import { FAMILY_STAGE_LABEL, familyReferralView, syncReferrals, type FamilyReferralStage } from "@/lib/growth/referrals";
import { formatMoney } from "@/lib/money";
import { fmtDate, todayLocal } from "@/lib/time";

export const metadata = { title: "Refer a friend" };

const STAGE_BADGE: Record<FamilyReferralStage, "neutral" | "blue" | "green"> = { inquired: "neutral", started: "blue", earned: "green" };
const STEPS: FamilyReferralStage[] = ["inquired", "started", "earned"];

export default async function ReferPage() {
  const v = await requireViewer();
  if (v.role !== "guardian" && v.role !== "athlete") redirect("/people/referrals");
  const view = await db.transaction(async (tx) => {
    await syncReferrals(tx, v.orgId, todayLocal());
    return familyReferralView(tx, v, env().APP_URL);
  });
  const qr = new Map<string, string>();
  for (const a of view.accounts) if (a.link) qr.set(a.payerAccountId, await QRCode.toDataURL(a.link, { margin: 1, width: 440, errorCorrectionLevel: "M" }));
  const earnedText =
    view.earnedWhen === "first_paid_invoice" ? "after their first payment is complete" : `after they have been training with us for ${view.daysActive} days`;

  return (
    <>
      <PageHeader kicker="Refer a friend" title="Share Teamwork with a friend" description="Know a family who would enjoy training here? Share your link. It takes them to our assessment request form." />
      {!view.enabled ? (
        <EmptyState title="The referral program is not open yet">We will let you know when it starts. In the meantime, friends are always welcome to request an assessment from our website.</EmptyState>
      ) : view.accounts.length === 0 ? (
        <EmptyState title="No referral link yet">Referral links belong to a billing account, and you are not listed on one. The front desk can help set that up.</EmptyState>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[3fr_2fr] [&>*]:min-w-0">
          <div className="space-y-5">
            {view.accounts.map((a) => (
              <Card key={a.payerAccountId}>
                <CardHeader title="Your referral link" kicker={view.accounts.length > 1 ? a.payerName : undefined} />
                <CardBody>
                  <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                    <div className="min-w-0 flex-1 space-y-3">
                      <CopyLink id={`link-${a.payerAccountId}`} value={a.link!} label="Link to share" />
                      <p className="text-sm text-ink-3">Send it by text or email, or let a friend scan the code with their phone camera.</p>
                      {a.creditBalanceMinor > 0 ? (
                        <p className="text-sm">
                          Account credit from referrals: <span className="font-semibold tabular">{formatMoney(a.creditBalanceMinor, view.currency)}</span>
                          <span className="block text-xs text-ink-3">The front desk applies it to a bill for you.</span>
                        </p>
                      ) : null}
                    </div>
                    {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL, nothing to optimize */}
                    <img src={qr.get(a.payerAccountId)} alt="QR code that opens your referral link" width={160} height={160} className="size-40 shrink-0 self-center rounded-md border border-edge bg-white p-2 sm:self-start" />
                  </div>
                </CardBody>
              </Card>
            ))}

            <Card>
              <CardHeader title="Your referrals" kicker="First name and last initial only" />
              <CardBody>
                {view.accounts.every((a) => a.referrals.length === 0) ? (
                  <p className="text-sm text-ink-3">No referrals yet. When a friend uses your link, they will show up here.</p>
                ) : (
                  <ul className="divide-y divide-edge">
                    {view.accounts.flatMap((a) =>
                      a.referrals.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                          <div>
                            <span className="font-medium">{r.name}</span>
                            <span className="ml-2 text-xs text-ink-3">{fmtDate(r.date)}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span aria-hidden className="hidden items-center gap-1 sm:flex">
                              {STEPS.map((s, i) => (
                                <span key={s} className={`h-1.5 w-8 rounded-full ${i <= STEPS.indexOf(r.stage) ? "bg-brand" : "bg-surface-2"}`} />
                              ))}
                            </span>
                            <Badge variant={STAGE_BADGE[r.stage]}>{FAMILY_STAGE_LABEL[r.stage]}</Badge>
                          </div>
                        </li>
                      )),
                    )}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>

          <div className="space-y-5">
            <Card>
              <CardHeader title="How it works" />
              <CardBody className="space-y-3 text-sm text-ink-2">
                {view.howItWorks ? <p className="whitespace-pre-line">{view.howItWorks}</p> : null}
                <ol className="list-decimal space-y-1.5 pl-5">
                  <li>Share your link with a family who is new to Teamwork.</li>
                  <li>They request an assessment using your link.</li>
                  <li>
                    {view.rewardText ? (
                      <>
                        You receive <strong>{view.rewardText}</strong> {earnedText}.
                      </>
                    ) : (
                      <>We say thank you in person. There is no set reward right now.</>
                    )}
                  </li>
                </ol>
                {view.referredRewardText ? (
                  <p>
                    Your friend receives <strong>{view.referredRewardText}</strong> too.
                  </p>
                ) : null}
                <Callout tone="info">
                  A staff member reviews each reward before it is added, so it can take a few days to appear. Referrals count for families who are new to Teamwork and live in a different household.
                </Callout>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="What we share with you" />
              <CardBody className="text-sm text-ink-2">
                To protect your friend&apos;s privacy you see only their first name, last initial and how far along they are. We never show their contact details, schedule or billing.
              </CardBody>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
