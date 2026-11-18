import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ExportButton, DefinitionsDrawer, ExportLink, MonthsSelect, NA, ScoreboardTabs, money } from "@/components/scoreboard/shell";
import { Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { monthLabel } from "@/lib/scoreboard/core";
import { leadSourceOptions, marketingEconomics } from "@/lib/scoreboard/marketing";
import { deleteSpendAction, saveSpendAction } from "../actions";
import { loadScoreboard, type ScoreboardSearch } from "../_load";

export const metadata = { title: "Marketing economics" };

export default async function MarketingPage({ searchParams }: { searchParams: Promise<ScoreboardSearch> }) {
  const { v, c, months, canManage } = await loadScoreboard(searchParams, { ignoreFilter: true });
  const mk = await marketingEconomics(db, v, c, { months });
  const sources = await leadSourceOptions(db, v.orgId);
  const q = { months };
  const orNA = (x: number | null) => (x == null ? <NA /> : formatMoney(x));
  return (
    <>
      <PageHeader
        kicker="Owner scoreboard"
        title="Marketing economics"
        description="What a lead and a new member cost, from the spend you enter here and the lead sources the CRM already stores."
        actions={
          <ExportButton table="marketing-channels" q={q}>Export CSV</ExportButton>
        }
      />
      <ScoreboardTabs current="marketing" q={{}} />
      <form action="/scoreboard/marketing" className="mb-5 flex flex-wrap items-end gap-3 rounded-md border border-edge bg-surface px-3 py-3">
        <MonthsSelect value={months} />
        <button type="submit" className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink">
          Apply
        </button>
        <p className="basis-full text-xs text-ink-3">Marketing spend is not split by location or program, so this tab is always organization-wide.</p>
      </form>

      <Callout tone="warn" title="Gross revenue, not profit" className="mb-5">
        Lifetime revenue here is money collected per member before any cost of coaching, rent or anything else. A ratio of 3 means three dollars of revenue per marketing dollar, not three dollars of profit. Spend is whatever was typed in below; nothing is read from an ad platform.
      </Callout>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Cost per lead" value={orNA(mk.totals.costPerLeadMinor)} hint={`${mk.totals.spendMinor == null ? "No spend entered" : formatMoney(mk.totals.spendMinor)} / ${mk.totals.leads} leads`} />
        <Stat label="Cost per new member" value={orNA(mk.totals.costPerMemberMinor)} hint={`${mk.totals.newMembers} new members`} />
        <Stat label="Avg monthly revenue per member" value={orNA(mk.arpmMinor)} hint="Collected on membership invoices, complete months" />
        <Stat label="Avg length of engagement" value={mk.loeMonths == null ? <NA /> : `${mk.loeMonths} months`} />
        <Stat label="Est. lifetime revenue per member" value={orNA(mk.ltvMinor)} hint="Monthly revenue x months. Gross, not profit" />
        <Stat label="Lifetime revenue : acquisition cost" value={mk.ratio == null ? <NA /> : `${mk.ratio} : 1`} hint="Gross revenue against marketing spend only" />
      </div>

      <Card className="mb-5">
        <CardHeader title="By channel / lead source" kicker={`${monthLabel(mk.first)} to ${monthLabel(mk.last)}`} action={<ExportLink table="marketing-channels" q={q} />} />
        <CardBody className="pt-0">
          {mk.channels.length === 0 ? (
            <EmptyState title="No spend entered and no leads in this period" />
          ) : (
            <Table caption="Marketing by channel">
              <thead>
                <tr>
                  <Th>Channel / lead source</Th>
                  <Th align="right">Spend</Th>
                  <Th align="right">Leads</Th>
                  <Th align="right">Cost per lead</Th>
                  <Th align="right">New members</Th>
                  <Th align="right">Cost per new member</Th>
                </tr>
              </thead>
              <tbody>
                {mk.channels.map((r) => (
                  <tr key={r.channel}>
                    <Td className="font-medium">{r.channel}</Td>
                    <Td align="right">{r.spendMinor == null ? <NA>none entered</NA> : formatMoney(r.spendMinor)}</Td>
                    <Td align="right">{r.leads}</Td>
                    <Td align="right">{orNA(r.costPerLeadMinor)}</Td>
                    <Td align="right">{r.newMembers}</Td>
                    <Td align="right">{orNA(r.costPerMemberMinor)}</Td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <Td>All channels</Td>
                  <Td align="right">{money(mk.totals.spendMinor)}</Td>
                  <Td align="right">{mk.totals.leads}</Td>
                  <Td align="right">{orNA(mk.totals.costPerLeadMinor)}</Td>
                  <Td align="right">{mk.totals.newMembers}</Td>
                  <Td align="right">{orNA(mk.totals.costPerMemberMinor)}</Td>
                </tr>
              </tbody>
            </Table>
          )}
          <p className="mt-3 text-xs text-ink-3">A channel with leads but no spend entered shows no cost (not $0). A new member belongs to the source of the lead they were converted from.</p>
        </CardBody>
      </Card>

      <Card className="mb-5">
        <CardHeader title="By month" action={<ExportLink table="marketing-months" q={q} />} />
        <CardBody className="pt-0">
          <Table caption="Marketing by month">
            <thead>
              <tr>
                <Th>Month</Th>
                <Th align="right">Spend</Th>
                <Th align="right">Leads</Th>
                <Th align="right">Cost per lead</Th>
                <Th align="right">New members</Th>
                <Th align="right">Cost per new member</Th>
              </tr>
            </thead>
            <tbody>
              {mk.months.map((m) => (
                <tr key={m.month}>
                  <Td className="whitespace-nowrap font-medium">
                    {m.label}
                    {m.partial ? <span className="text-xs font-normal text-ink-3"> to date</span> : null}
                  </Td>
                  <Td align="right">{m.spendMinor == null ? <NA>none entered</NA> : formatMoney(m.spendMinor)}</Td>
                  <Td align="right">{m.leads}</Td>
                  <Td align="right">{orNA(m.costPerLeadMinor)}</Td>
                  <Td align="right">{m.newMembers}</Td>
                  <Td align="right">{orNA(m.costPerMemberMinor)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>

      <Card className="mb-5">
        <CardHeader title="Monthly marketing spend" kicker={canManage ? "Entered by hand. Owner / admin" : "Entered by the owner or an admin"} action={<ExportLink table="marketing-spend" q={q} />} />
        <CardBody className="space-y-4 pt-0">
          {canManage ? (
            <ActionForm action={saveSpendAction} resetOnSuccess className="space-y-3">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">
                <Field label="Month" htmlFor="sp-month" required>
                  <Input id="sp-month" name="month" type="month" defaultValue={c.today.slice(0, 7)} required />
                </Field>
                <Field label="Channel" htmlFor="sp-channel" hint="Use a lead source name to get cost per lead for it." required>
                  <Input id="sp-channel" name="channel" list="sp-channels" maxLength={60} required />
                </Field>
                <Field label="Amount (USD)" htmlFor="sp-amount" required>
                  <Input id="sp-amount" name="amount" inputMode="decimal" placeholder="0.00" required />
                </Field>
                <Field label="Note" htmlFor="sp-note">
                  <Input id="sp-note" name="note" maxLength={300} />
                </Field>
              </div>
              <datalist id="sp-channels">
                {sources.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <SubmitButton>Save spend</SubmitButton>
              <p className="text-xs text-ink-3">Saving the same month and channel again replaces the amount. Every change is audited.</p>
            </ActionForm>
          ) : null}
          {mk.entries.length === 0 ? (
            <EmptyState title="No spend entered for these months" />
          ) : (
            <Table caption="Marketing spend entries">
              <thead>
                <tr>
                  <Th>Month</Th>
                  <Th>Channel</Th>
                  <Th align="right">Amount</Th>
                  <Th>Note</Th>
                  {canManage ? <Th /> : null}
                </tr>
              </thead>
              <tbody>
                {mk.entries.map((e) => (
                  <tr key={e.id}>
                    <Td className="whitespace-nowrap">{monthLabel(e.month)}</Td>
                    <Td>{e.channel}</Td>
                    <Td align="right">{formatMoney(e.amountMinor)}</Td>
                    <Td>{e.note}</Td>
                    {canManage ? (
                      <Td align="right">
                        <ActionForm action={deleteSpendAction}>
                          <input type="hidden" name="id" value={e.id} />
                          <SubmitButton variant="ghost" size="sm" confirm={`Remove ${e.channel} for ${monthLabel(e.month)}?`}>
                            Remove<span className="sr-only"> {e.channel} {monthLabel(e.month)}</span>
                          </SubmitButton>
                        </ActionForm>
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <DefinitionsDrawer tab="marketing" />
    </>
  );
}
