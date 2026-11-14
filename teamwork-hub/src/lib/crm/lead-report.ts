import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import type { ReportDef } from "@/lib/reports";
import { localDayBounds } from "@/lib/time";
import { vocabOverrides } from "@/lib/zenplanner/vocab";
import { NO_INTEREST, leadSport, normalizeLeadInterest, normalizeLeadSource } from "./lead-vocab";

type Row = Record<string, unknown>;

type Bucket = { leads: number; converted: number; lost: number };

/**
 * Leads by source and by interest, both grouped by the normalised value (lead-vocab.ts), so
 * "web_inquiry", "Website" and "website" are one row. Stored values are not changed.
 */
export const LEAD_REPORTS: ReportDef[] = [
  {
    key: "leads-by-source",
    title: "Leads by source and interest",
    category: "Growth",
    definition:
      "Leads created in the date range, counted once under their source and once under their interest. Values are grouped by the list's own spelling: an older spelling of a list value counts with it (web inquiry with Website, walk in with Walk-in), and a value that is not on the list is shown as stored. Leads typed in by staff without a source are under \"No source\". An older lead that only recorded a sport has no interest. Converted = became an athlete. Lost = in a lost stage now.",
    cap: "crm.manage",
    columns: [
      { key: "group", label: "Grouped by" },
      { key: "value", label: "Value" },
      { key: "on_list", label: "On the list" },
      { key: "leads", label: "Leads", kind: "int" },
      { key: "converted", label: "Converted", kind: "int" },
      { key: "lost", label: "Lost", kind: "int" },
      { key: "open", label: "Still open", kind: "int" },
      { key: "conversion_rate", label: "Converted ÷ leads", kind: "pct" },
    ],
    run: async (tx: Tx, orgId, r) => {
      const start = localDayBounds(r.from, r.tz).start.toISOString();
      const end = localDayBounds(r.to, r.tz).end.toISOString();
      const overrides = await vocabOverrides(tx, orgId);
      const rows = (
        await tx.execute(sql`
          select l.source, l.interest, l.inquiry, (l.converted_at is not null) as converted, coalesce(ls.is_lost, false) as lost
          from leads l left join lead_stages ls on ls.org_id = l.org_id and ls.key = l.stage
          where l.org_id = ${orgId} and l.created_at >= ${start} and l.created_at < ${end}`)
      ).rows as Row[];
      const by = { Source: new Map<string, Bucket & { onList: boolean }>(), Interest: new Map<string, Bucket & { onList: boolean }>() };
      const bump = (m: Map<string, Bucket & { onList: boolean }>, label: string, onList: boolean, x: Row) => {
        const b = m.get(label) ?? { leads: 0, converted: 0, lost: 0, onList };
        b.leads += 1;
        if (x.converted) b.converted += 1;
        else if (x.lost) b.lost += 1;
        m.set(label, b);
      };
      for (const x of rows) {
        const s = normalizeLeadSource(x.source as string | null, overrides);
        bump(by.Source, s.label, s.onList, x);
        const lead = { interest: (x.interest as string | null) ?? null, inquiry: (x.inquiry as Record<string, unknown>) ?? {} };
        const i = normalizeLeadInterest(lead.interest, overrides);
        // An older lead kept the sport in the interest column; that is not an interest.
        const sportOnly = !i.onList && leadSport(lead, overrides) === lead.interest;
        bump(by.Interest, sportOnly ? NO_INTEREST : i.label, sportOnly ? false : i.onList, x);
      }
      const out: Row[] = [];
      for (const group of ["Source", "Interest"] as const) {
        for (const [value, b] of [...by[group]].sort((a, z) => z[1].leads - a[1].leads || a[0].localeCompare(z[0]))) {
          out.push({ group, value, on_list: b.onList ? "Yes" : "No", leads: b.leads, converted: b.converted, lost: b.lost, open: b.leads - b.converted - b.lost, conversion_rate: b.leads ? b.converted / b.leads : null });
        }
      }
      const converted = rows.filter((x) => x.converted).length;
      return {
        rows: out,
        summary: [
          { label: "Leads", value: rows.length },
          { label: "Converted", value: converted },
          { label: "Sources in use", value: by.Source.size },
        ],
      };
    },
  },
];
