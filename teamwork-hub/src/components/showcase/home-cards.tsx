import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import { showcases } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { showcaseAccess } from "@/lib/showcase/access";
import { recapNotice } from "@/lib/showcase/recap";
import { linkStateOf } from "@/lib/showcase/showcase";

/**
 * Athlete Home (family view of /today): a Showcase card and this month's recap link.
 * Renders nothing the viewer has no access to (payer-only adults, Showcase turned off).
 */
export async function ShowcaseHomeCards({ v, athleteId, firstName }: { v: Viewer; athleteId: string; firstName: string }) {
  const [access, notice] = await Promise.all([showcaseAccess(db, v, athleteId), recapNotice(db, v, athleteId)]);
  const showShowcase = access.canView && access.settings.enabled && access.relationship !== "staff";
  const [row] = showShowcase ? await db.select().from(showcases).where(and(eq(showcases.orgId, v.orgId), eq(showcases.athleteId, athleteId))) : [];
  const link = linkStateOf(row);
  const mine = v.role === "athlete";
  if (!showShowcase && !notice) return null;
  return (
    <>
      {showShowcase ? (
        <Card>
          <CardHeader
            title="Showcase"
            kicker="For college and club coaches"
            action={link === "live" ? <Badge variant="green">Link is on</Badge> : link === "expired" ? <Badge variant="yellow">Expired</Badge> : row ? <Badge variant="neutral">Draft</Badge> : undefined}
          />
          <CardBody className="space-y-2 text-sm">
            <p className="text-ink-2">
              {link === "live"
                ? `${mine ? "Your" : `${firstName}'s`} numbers page is shared by private link.`
                : row
                  ? access.canPublish
                    ? "A draft is waiting. Publish it when it looks right."
                    : "Your draft is saved. A parent or guardian publishes it."
                  : `Turn ${mine ? "your" : `${firstName}'s`} test results and lifts into one page you can send to a coach.`}
            </p>
            <Link href={`/showcase?athlete=${athleteId}`} className="inline-flex font-semibold text-brand underline">
              {row ? "Open Showcase" : "Build a Showcase"}
            </Link>
          </CardBody>
        </Card>
      ) : null}
      {notice ? (
        <Card>
          <CardBody className="space-y-1.5 text-sm">
            {notice.ready ? (
              <p className="flex flex-wrap items-center gap-2">
                <Badge variant="brand">New</Badge>
                <Link href={`/recap/${notice.ready.month}?athlete=${athleteId}`} className="font-semibold text-brand underline">
                  {notice.ready.label} recap is ready
                </Link>
              </p>
            ) : null}
            <p className="flex items-center justify-between gap-3">
              <Link href={`/recap/${notice.current}?athlete=${athleteId}`} className="font-semibold text-brand underline">
                This month&apos;s recap
              </Link>
              <Link href={`/recap?athlete=${athleteId}`} className="text-ink-2 underline">
                All months
              </Link>
            </p>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
