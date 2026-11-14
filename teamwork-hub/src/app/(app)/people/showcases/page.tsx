import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { PeopleTabs } from "@/components/people-tabs";
import { Badge, Callout, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { getOrg, requireStaff } from "@/lib/auth/viewer";
import { can, isAdmin } from "@/lib/authz/policy";
import { showcaseSettingsOf } from "@/lib/showcase/settings";
import { listPublishedShowcases } from "@/lib/showcase/showcase";
import { fmt } from "@/lib/time";
import { staffRevokeShowcaseAction } from "../../showcase/actions";

export const metadata = { title: "Published Showcases" };

export default async function PublishedShowcasesPage() {
  const v = await requireStaff();
  const org = await getOrg(v.orgId);
  const rows = await listPublishedShowcases(db, v);
  const admin = isAdmin(v);
  const enabled = showcaseSettingsOf(org?.settings).enabled;
  return (
    <>
      <PageHeader
        kicker="People"
        title="Published Showcases"
        description="Athletes whose family has published a Showcase page to share with college or club coaches. Read-only: families choose what is shown. Staff never see the link itself."
      />
      <PeopleTabs current="showcases" showLeads={can(v, "crm.manage")} showRequests={can(v, "people.manage") || can(v, "crm.manage")} />
      {!enabled ? (
        <Callout tone="warn" title="Showcase is turned off" className="mb-4">
          Every shared link shows a &quot;not available&quot; page while this is off. An owner or admin can turn it back on in Settings.
        </Callout>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title="No published Showcases">{v.role === "coach" ? "None of your assigned athletes has a published Showcase yet." : "When a family publishes a Showcase it appears here."}</EmptyState>
      ) : (
        <Table caption="Published Showcases">
          <thead>
            <tr>
              <Th>Athlete</Th>
              <Th>Shows</Th>
              <Th>Published</Th>
              <Th>Link</Th>
              <Th align="right">Opens, 30 days</Th>
              {admin ? <Th align="right">Action</Th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link href={`/people/${r.personId}`} className="font-semibold text-brand hover:underline">
                    {r.athleteName}
                  </Link>
                </Td>
                <Td className="max-w-md text-xs text-ink-2">{r.shows.join(" · ")}</Td>
                <Td className="whitespace-nowrap">
                  {fmt(r.publishedAt, "MMM d, yyyy", org?.timezone)}
                  <span className="block text-xs text-ink-3">by {r.publishedBy ?? "family"}</span>
                </Td>
                <Td className="whitespace-nowrap">
                  {r.link === "live" ? <Badge variant="green">On</Badge> : <Badge variant="yellow">Expired</Badge>}
                  <span className="block text-xs text-ink-3">{r.expiresAt ? `until ${fmt(r.expiresAt, "MMM d, yyyy", org?.timezone)}` : "no end date"}</span>
                </Td>
                <Td align="right" className="tabular">
                  {r.views30}
                </Td>
                {admin ? (
                  <Td align="right">
                    <ActionForm action={staffRevokeShowcaseAction}>
                      <input type="hidden" name="showcaseId" value={r.id} />
                      <SubmitButton variant="outline" size="sm" pendingText="Turning off…" confirm={`Turn off the Showcase link for ${r.athleteName}? It stops working right away. The family can publish again later.`}>
                        Turn off<span className="sr-only"> link for {r.athleteName}</span>
                      </SubmitButton>
                    </ActionForm>
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="mt-3 text-xs text-ink-3">Turning a link off is recorded in the audit log and in the Showcase consent history. Opens are counted per day; nothing about visitors is stored.</p>
    </>
  );
}
