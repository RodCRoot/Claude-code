import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, buttonClass } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { isStaff } from "@/lib/authz/policy";
import { familyAthletes } from "@/lib/dashboards";
import { SHOWCASE_POLICY_TEXT } from "@/lib/showcase/allowlist";
import { showcaseOrg } from "@/lib/showcase/catalog";
import { EXPIRY_CHOICES } from "@/lib/showcase/settings";
import { getShowcaseBuilder } from "@/lib/showcase/showcase";
import { fmt, todayLocal } from "@/lib/time";
import { ModuleHero } from "../training/_components/tb";
import { ShowcaseBuilder } from "./_components/builder";
import { LinkControls } from "./_components/link-controls";
import { showcaseRevokeAction, showcaseRotateAction, showcaseSaveAction } from "./actions";

export const metadata = { title: "Showcase" };

export default async function ShowcasePage({ searchParams }: { searchParams: Promise<{ athlete?: string }> }) {
  const v = await requireViewer();
  // Staff never build a Showcase; they get the read-only list.
  if (isStaff(v)) redirect("/people/showcases");
  const sp = await searchParams;
  const children = await familyAthletes(db, v);
  // Only athletes this viewer is linked to are selectable; an unknown id falls back to the first.
  const child = children.find((c) => c.athleteId === sp.athlete) ?? children[0];
  const isAthlete = v.role === "athlete";
  const hero = (title: string, extra?: React.ReactNode) => (
    <ModuleHero kicker="Showcase" title={title} description="A one-page profile of numbers recorded at Teamwork that you can send to a college or club coach. You choose what it shows, and you can turn it off any time.">
      {extra}
    </ModuleHero>
  );
  if (!child) {
    return (
      <>
        {hero("Showcase")}
        <EmptyState title="No athletes linked to your account yet">Ask the front desk to link your athlete to your account.</EmptyState>
      </>
    );
  }
  // A payer-only adult has no guardianship, so `familyAthletes` never lists the athlete and the lib refuses anyway.
  const b = await getShowcaseBuilder(db, v, child.athleteId);
  const org = await showcaseOrg(db, v.orgId);
  const first = b.catalog.athlete.firstName;
  const tz = org.tz;

  return (
    <div className="mx-auto max-w-[1280px]">
      {hero(
        isAthlete ? "Your Showcase" : `${first}'s Showcase`,
        children.length > 1 ? (
          <nav aria-label="Choose athlete" className="flex flex-wrap gap-2">
            {children.map((c) => {
              const current = c.athleteId === child.athleteId;
              return (
                <Link
                  key={c.athleteId}
                  href={`/showcase?athlete=${c.athleteId}`}
                  aria-current={current ? "true" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold ${current ? "bg-[#4fc3f7] text-[#0b1a2e]" : "bg-white/10 text-white ring-1 ring-white/25 hover:bg-white/20"}`}
                >
                  {c.name.split(" ")[0]}
                </Link>
              );
            })}
          </nav>
        ) : null,
      )}

      {!b.access.settings.enabled ? (
        <Callout tone="info" title="Showcase is turned off">
          Teamwork has Showcase switched off right now, so nothing can be shared and any earlier link is closed. Ask the front desk if you have questions.
        </Callout>
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Sharing"
              action={
                b.link === "live" ? <Badge variant="green">Link is on</Badge> : b.link === "expired" ? <Badge variant="yellow">Link expired</Badge> : b.row ? <Badge variant="neutral">Draft, not shared</Badge> : <Badge variant="neutral">Not started</Badge>
              }
            />
            <CardBody className="space-y-3 text-sm">
              {b.link === "live" ? (
                <p className="text-ink-2">
                  Published {b.lastConsent ? `by ${b.lastConsent.by} on ${fmt(b.lastConsent.at, "MMM d, yyyy", tz)}` : ""}. {b.row?.expiresAt ? `The link works until ${fmt(b.row.expiresAt, "MMM d, yyyy", tz)}.` : "The link works until it is turned off."} Opened{" "}
                  <span className="font-semibold tabular">{b.views.last30}</span> time{b.views.last30 === 1 ? "" : "s"} in the last 30 days ({b.views.total} in all). We count opens by day only and keep nothing about who opened it.
                </p>
              ) : b.link === "expired" ? (
                <p className="text-ink-2">The link reached its end date and shows a &quot;not available&quot; page. {b.access.canPublish ? "Publish again below to turn it back on." : "A parent or guardian can publish it again."}</p>
              ) : b.row ? (
                <p className="text-ink-2">
                  Nothing is shared right now. {b.access.canPublish ? "Publish below when it looks right." : (b.access.publishBlockedReason ?? "")}
                  {b.row.revokedAt ? ` The last link was turned off on ${fmt(b.row.revokedAt, "MMM d, yyyy", tz)} and can never be reused.` : ""}
                </p>
              ) : (
                <p className="text-ink-2">Pick what to show, check the preview, then {b.access.canPublish ? "publish to get a private link." : "save your draft for a parent or guardian to publish."}</p>
              )}
              <div className="flex flex-wrap items-start gap-2">
                {b.row && (b.access.canPublish || b.link === "live") ? (
                  <a href={`/api/showcase/${child.athleteId}/pdf`} className={buttonClass("secondary")}>
                    Download PDF
                  </a>
                ) : null}
                {b.link === "live" || b.link === "expired" ? (
                  <LinkControls athleteId={child.athleteId} canRotate={b.access.canPublish && b.link === "live"} canRevoke={b.access.canRevoke} rotateAction={showcaseRotateAction} revokeAction={showcaseRevokeAction} />
                ) : null}
              </div>
              <p className="text-xs text-ink-3">Never on a Showcase: wellness check-ins, body map, injuries or health forms, coach notes, billing, which days you attended, date of birth, home address, or the email and phone on your account.</p>
            </CardBody>
          </Card>

          {b.access.draftBlockedReason ? <Callout tone="info">{b.access.draftBlockedReason}</Callout> : null}

          <ShowcaseBuilder
            key={child.athleteId}
            athleteId={child.athleteId}
            firstName={first}
            catalog={b.catalog}
            initial={b.config}
            org={{ name: org.name, primaryColor: org.primaryColor, logoPath: org.logoPath }}
            asOf={todayLocal(tz)}
            canDraft={b.access.canDraft}
            canPublish={b.access.canPublish}
            canSeeTraining={b.access.canSeeTraining}
            publishBlockedReason={b.access.publishBlockedReason}
            published={b.link === "live"}
            defaultExpiryDays={b.access.settings.defaultExpiryDays}
            expiryChoices={[...EXPIRY_CHOICES]}
            policyText={SHOWCASE_POLICY_TEXT}
            saveAction={showcaseSaveAction}
          />
        </div>
      )}
    </div>
  );
}
