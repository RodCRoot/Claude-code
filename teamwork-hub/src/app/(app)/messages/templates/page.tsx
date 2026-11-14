import Link from "next/link";
import { db } from "@/db";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { listTemplates } from "@/lib/automation/templates";
import { fmtDate } from "@/lib/time";
import { StaffTabs } from "../_components/shared";

export const metadata = { title: "Message templates" };

export default async function TemplatesPage() {
  const v = await requireCap("crm.manage");
  const rows = await listTemplates(db, v.orgId);
  return (
    <>
      <PageHeader title="Messages" description="Reusable message text with {{variables}}. Used by automations and when composing." actions={<ButtonLink href="/messages/templates/new">New template</ButtonLink>} />
      <StaffTabs v={v} current="templates" />
      {rows.length === 0 ? (
        <EmptyState title="No templates yet" action={<ButtonLink href="/messages/templates/new">New template</ButtonLink>} />
      ) : (
        <Card>
          <Table caption="Templates">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Channel</Th>
                <Th>Subject</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <Td>
                    <Link href={`/messages/templates/${t.id}`} className="font-medium hover:underline">
                      {t.name}
                    </Link>
                    {t.isSample ? (
                      <Badge variant="yellow" className="ml-2">
                        SAMPLE text
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>{t.channel.replace("_", "-")}</Td>
                  <Td className="text-ink-2">{t.subject ?? "—"}</Td>
                  <Td>{fmtDate(t.updatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
