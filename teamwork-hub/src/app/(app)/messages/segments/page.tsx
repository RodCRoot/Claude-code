import Link from "next/link";
import { db } from "@/db";
import { Badge, ButtonLink, Callout, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { describeFilters, filterOptions, listSegments } from "@/lib/messaging/segments";
import { StaffTabs } from "../_components/shared";

export const metadata = { title: "Segments" };

export default async function SegmentsPage() {
  const v = await requireCap("crm.manage");
  const [rows, opts] = await Promise.all([listSegments(db, v), filterOptions(db, v)]);
  const names = {
    groups: new Map(opts.groups.map((g) => [g.id, g.name])),
    products: new Map(opts.products.map((p) => [p.id, p.name])),
    tags: new Map(opts.tags.map((t) => [t.id, t.name])),
    forms: new Map(opts.forms.map((f) => [f.id, f.name])),
  };
  return (
    <>
      <PageHeader
        title="Messages"
        description="Saved audiences for broadcast campaigns. Counts are live: they reflect today's rosters, memberships, attendance and guardian links."
        actions={<ButtonLink href="/messages/segments/new">New segment</ButtonLink>}
      />
      <StaffTabs v={v} current="segments" />
      <Callout tone="info" className="mb-4">
        A segment picks athletes (or open leads); messages about minors go to each guardian allowed to message, never to the minor. Email/SMS consent and quiet hours are applied when a campaign is previewed and again when it sends.
      </Callout>
      {rows.length === 0 ? (
        <EmptyState title="No segments yet" action={<ButtonLink href="/messages/segments/new">New segment</ButtonLink>} />
      ) : (
        <Card>
          <Table caption="Segments">
            <thead>
              <tr>
                <Th>Segment</Th>
                <Th>Filters</Th>
                <Th align="right">Matched</Th>
                <Th align="right">Recipients</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.segment.id}>
                  <Td>
                    <Link href={`/messages/segments/${r.segment.id}`} className="font-medium hover:underline">
                      {r.segment.name}
                    </Link>
                    {r.healthReason ? (
                      <Badge variant="yellow" className="ml-1" title={r.healthReason}>
                        health data
                      </Badge>
                    ) : null}
                    {r.segment.description ? <span className="block text-xs text-ink-3">{r.segment.description}</span> : null}
                  </Td>
                  <Td className="text-xs text-ink-2">{describeFilters(r.segment.filters, names)}</Td>
                  <Td align="right">{r.restricted ? <span className="text-xs text-ink-3">restricted</span> : r.matched}</Td>
                  <Td align="right">{r.restricted ? "—" : r.recipients}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
