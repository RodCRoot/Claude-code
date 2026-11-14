import Link from "next/link";
import { db } from "@/db";
import { Badge, ButtonLink, Callout, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { listCampaigns, statusLabel } from "@/lib/messaging/campaigns";
import { fmt } from "@/lib/time";
import { CAMPAIGN_BADGE, ChannelStatus, StaffTabs } from "../_components/shared";

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage() {
  const v = await requireCap("crm.manage");
  const rows = await listCampaigns(db, v);
  return (
    <>
      <PageHeader
        title="Messages"
        description="Broadcasts: a template sent to a segment. Every campaign needs owner/admin approval, and consent, guardian routing and quiet hours apply to each recipient."
        actions={<ButtonLink href="/messages/campaigns/new">New campaign</ButtonLink>}
      />
      <StaffTabs v={v} current="campaigns" />
      <ChannelStatus />
      <Callout tone="info" className="mb-4">
        Broadcast email goes only to people who explicitly opted in to email; texts only to people who opted in to SMS. Everyone routed also gets the message in the app.
      </Callout>
      {rows.length === 0 ? (
        <EmptyState title="No campaigns yet" action={<ButtonLink href="/messages/campaigns/new">New campaign</ButtonLink>} />
      ) : (
        <Card>
          <Table caption="Campaigns">
            <thead>
              <tr>
                <Th>Campaign</Th>
                <Th>Status</Th>
                <Th>Segment</Th>
                <Th>Template</Th>
                <Th>Channels</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, segmentName, templateName, createdBy }) => (
                <tr key={c.id}>
                  <Td>
                    <Link href={`/messages/campaigns/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                    <span className="block text-xs text-ink-3">by {createdBy ?? "—"}</span>
                  </Td>
                  <Td>
                    <Badge variant={CAMPAIGN_BADGE[c.status]}>{statusLabel(c.status)}</Badge>
                  </Td>
                  <Td>{segmentName}</Td>
                  <Td>{templateName}</Td>
                  <Td>{(c.channels as string[]).map((x) => x.replace("_", "-")).join(", ")}</Td>
                  <Td className="text-xs">
                    {c.completedAt ? `Sent ${fmt(c.completedAt)}` : c.scheduledAt ? `Scheduled ${fmt(c.scheduledAt)}` : c.status === "cancelled" ? "—" : "On approval"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
