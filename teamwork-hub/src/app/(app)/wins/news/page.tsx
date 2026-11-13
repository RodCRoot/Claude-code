import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ClipCard } from "@/components/newswatch/clip";
import { WinsStaffTabs } from "@/components/wins/staff";
import { Callout, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { getOrg, requireCap } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { listClips } from "@/lib/newswatch/clips";
import { canApproveNews, newsOrg } from "@/lib/newswatch/settings";
import { ModuleHero } from "../../training/_components/tb";
import { bulkApproveClipsAction } from "../news-actions";

export const metadata = { title: "News clips to approve" };

export default async function NewsApprovalPage() {
  const v = await requireCap("wins.review");
  const tz = (await getOrg(v.orgId))?.timezone;
  const approver = await canApproveNews(db, v);
  const org = await newsOrg(db, v.orgId);
  const pending = await listClips(db, v, { statuses: ["suggested", "confirmed"] });
  const approved = (await listClips(db, v, { statuses: ["approved"], limit: 40 })).filter((c) => c.status === "approved");
  const selectable = pending.filter((c) => !c.blockedTopic && c.watched && c.shownAs !== null).length;
  return (
    <div className="mx-auto max-w-6xl">
      <ModuleHero kicker="Wins" title="News clips to approve" description="Headlines that News watch matched to a watched athlete or alumnus. Nothing here is shown to anyone until it is approved on this page." />
      <WinsStaffTabs v={v} current="news" />
      <Callout tone="info" className="mb-4" title="Nothing is shared without approval">
        Approving a clip shows its headline, the publication, the date and a link to the article in the app and on the gym TV, under the display name. It is never posted anywhere outside the app, and public marketing still needs the family&apos;s separate yes. {approver ? null : "You can check whether a clip is about our athlete on the Leads to check tab. Approving is for the owner, an admin, or staff the owner allowed in Settings."}
        {org && !org.settings.enabled ? (
          <span className="mt-1 block">
            News watch is switched off, so no new headlines are being read.{can(v, "settings.manage") ? (
              <>
                {" "}
                <Link href="/settings/newswatch" className="font-semibold text-brand underline">
                  Open News watch settings
                </Link>
              </>
            ) : null}
          </span>
        ) : null}
      </Callout>

      <Card id="news-pending">
        <CardHeader title="Waiting for approval" kicker={`${pending.length} pending, newest first`} />
        <CardBody>
          {pending.length === 0 ? <EmptyState title="No clips are waiting">New matches appear here after the nightly News watch run.</EmptyState> : null}
          {approver && selectable > 0 ? (
            <ActionForm action={bulkApproveClipsAction} id="bulk-approve" className="mb-3 rounded-lg border border-edge bg-surface-2 px-3 py-3">
              <p className="mb-2 text-sm text-ink-2">Tick the clips you have checked, then approve them together.</p>
              <SubmitButton confirm="Approve every ticked clip? Each one will show in the app and on the gym TV.">Approve selected clips</SubmitButton>
            </ActionForm>
          ) : null}
          <ul className="divide-y divide-edge">
            {pending.map((c) => (
              <ClipCard key={c.id} c={c} tz={tz} mode={approver ? "approve" : "none"} bulkFormId="bulk-approve" />
            ))}
          </ul>
        </CardBody>
      </Card>

      <Card id="news-approved" className="mt-4">
        <CardHeader title="Approved and showing" kicker="Take one down in one step" />
        <CardBody>
          {approved.length === 0 ? <p className="text-sm text-ink-3">No approved clips yet.</p> : null}
          <ul className="divide-y divide-edge">
            {approved.map((c) => (
              <ClipCard key={c.id} c={c} tz={tz} mode={approver ? "approved" : "none"} />
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
