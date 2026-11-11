import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { productVersions } from "@/db/schema";
import { Badge, ButtonLink, Callout, EmptyState, PageHeader, StatusBadge, Table, Td, Th, type BadgeVariant } from "@/components/ui";
import type { Viewer } from "@/lib/authz/policy";
import { holdsFor, periodPrice } from "@/lib/billing/memberships";
import { billExtras, listInvoices, listMemberships, myPayerAccounts, scheduledBills } from "@/lib/billing/queries";
import { creditSummary } from "@/lib/credits";
import { fmtDate, todayLocal } from "@/lib/time";
import { FamilySuggestion } from "@/components/growth/family-suggestion";
import { BillingTabs, Money } from "./_components";

/**
 * Family-facing "My Profile" screens: Family, Memberships, Bills. Staff keep the accounting views
 * (invoices, ledgers); families see the same records under the words they already use.
 */

type BillRow = {
  key: string;
  due: string;
  description: React.ReactNode;
  amount: React.ReactNode;
  status: React.ReactNode;
  action?: React.ReactNode;
};

const panel = "min-w-0 overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]";
const panelHead = "border-b border-edge bg-th px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-ink-2 sm:px-4";

/** Due date, Description, Amount, Status (+ action): a table on wider screens, stacked rows on a phone. */
export function BillTable({ caption, rows, dateLabel = "Due date" }: { caption: string; rows: BillRow[]; dateLabel?: string }) {
  const hasAction = rows.some((r) => r.action);
  return (
    <>
      <div className="hidden sm:block">
        <Table caption={caption}>
          <thead>
            <tr>
              <Th className="pl-4">{dateLabel}</Th>
              <Th>Description</Th>
              <Th align="right">Amount</Th>
              <Th>Status</Th>
              {hasAction ? <Th /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <Td className="pl-4 whitespace-nowrap tabular">{r.due}</Td>
                <Td>{r.description}</Td>
                <Td align="right" className="font-semibold whitespace-nowrap">
                  {r.amount}
                </Td>
                <Td>{r.status}</Td>
                {hasAction ? (
                  <Td align="right" className="pr-4">
                    {r.action}
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <ul className="divide-y divide-edge sm:hidden" aria-label={caption}>
        {rows.map((r) => (
          <li key={r.key} className="space-y-2 px-3 py-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs text-ink-3 tabular">
                  {dateLabel} {r.due}
                </div>
                <div className="mt-0.5">{r.description}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-bold tabular">{r.amount}</div>
                <div className="mt-1">{r.status}</div>
              </div>
            </div>
            {r.action ? <div className="[&>a]:min-h-11 [&>a]:w-full">{r.action}</div> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

type InvoiceRow = Awaited<ReturnType<typeof listInvoices>>[number];
type Extras = Awaited<ReturnType<typeof billExtras>>;

/** Paid / Unpaid / Failed (+ the honest in-between states this app has: Processing, Void, Closed). */
export function BillStatus({ r, extras, today }: { r: InvoiceRow; extras?: Extras[string]; today: string }) {
  const st = r.invoice.status;
  let label = st.replaceAll("_", " ");
  let variant: BadgeVariant = "neutral";
  let title: string | undefined;
  if (st === "paid") [label, variant] = ["Paid", "green"];
  else if (st === "void") label = "Void";
  else if (st === "uncollectible") label = "Closed";
  else if (st === "open") {
    if (r.money.pendingMinor > 0) [label, variant, title] = ["Processing", "yellow", "A payment is in flight. It is not counted as paid until the provider confirms it."];
    else if (extras?.lastAttemptFailed) [label, variant, title] = ["Failed", "red", "The last online payment did not go through. Nothing was charged."];
    else if (r.invoice.dueDate && r.invoice.dueDate < today) [label, variant] = ["Unpaid · past due", "red"];
    else [label, variant] = ["Unpaid", "yellow"];
  }
  return (
    <Badge variant={variant} title={title}>
      {label}
    </Badge>
  );
}

function billDescription(r: InvoiceRow, extras?: Extras[string]) {
  return (
    <>
      <Link className="font-medium hover:underline" href={`/billing/invoices/${r.invoice.id}`}>
        {extras?.description || r.invoice.memo || `Bill ${r.invoice.number}`}
      </Link>
      <div className="text-xs text-ink-3">
        {r.invoice.number}
        {r.invoice.isDemo ? " · DEMO" : ""}
      </div>
    </>
  );
}

/** Bills: unpaid first with Pay Now, then upcoming scheduled bills, then history. */
export async function FamilyBills({ v }: { v: Viewer }) {
  const today = todayLocal();
  const [accounts, rows, upcoming] = await Promise.all([myPayerAccounts(db, v), listInvoices(db, v, { limit: 200 }), db.transaction((tx) => scheduledBills(tx, v))]);
  const extras = await billExtras(db, v, rows.map((r) => r.invoice.id));
  const canPay = new Set(accounts.filter((a) => a.canPay).map((a) => a.payer.id));
  const several = accounts.length > 1;
  const payerName = (id: string | null) => (several ? accounts.find((a) => a.payer.id === id)?.payer.name : undefined);
  const unpaid = rows.filter((r) => r.invoice.status === "open").sort((a, b) => (a.invoice.dueDate ?? "9").localeCompare(b.invoice.dueDate ?? "9"));
  const history = rows.filter((r) => r.invoice.status !== "open").sort((a, b) => (b.invoice.dueDate ?? "").localeCompare(a.invoice.dueDate ?? ""));
  const currencies = new Set(unpaid.map((r) => r.invoice.currency));
  const totalDue = unpaid.reduce((s, r) => s + r.money.balanceMinor, 0);
  const viewOnly = accounts.filter((a) => !a.canPay);

  const toRow = (r: InvoiceRow, mode: "unpaid" | "history"): BillRow => {
    const payable = mode === "unpaid" && canPay.has(r.invoice.payerAccountId) && r.money.balanceMinor > 0 && r.money.pendingMinor === 0;
    const name = payerName(r.invoice.payerAccountId);
    return {
      key: r.invoice.id,
      due: fmtDate(r.invoice.dueDate),
      description: (
        <>
          {billDescription(r, extras[r.invoice.id])}
          {name ? <div className="text-xs text-ink-3">{name}</div> : null}
        </>
      ),
      amount: <Money minor={mode === "unpaid" ? r.money.balanceMinor : r.invoice.totalMinor} currency={r.invoice.currency} />,
      status: <BillStatus r={r} extras={extras[r.invoice.id]} today={today} />,
      action:
        mode === "unpaid" ? (
          <ButtonLink size="sm" href={`/billing/invoices/${r.invoice.id}#pay`} variant={payable ? "primary" : "secondary"}>
            {payable ? "Pay Now" : "View"}
            <span className="sr-only"> {r.invoice.number}</span>
          </ButtonLink>
        ) : (
          <ButtonLink size="sm" href={`/billing/invoices/${r.invoice.id}/receipt`} variant="secondary">
            {r.invoice.status === "paid" ? "Receipt" : "View"}
            <span className="sr-only"> {r.invoice.number}</span>
          </ButtonLink>
        ),
    };
  };

  return (
    <>
      <PageHeader kicker="My Profile" title="Bills" description="What is due, what is coming up, and what has been paid." />
      <BillingTabs current="invoices" staff={false} />
      {accounts.length === 0 ? (
        <EmptyState title="No billing accounts">You aren&apos;t listed on a billing account. If you expected to see one, please contact the front desk.</EmptyState>
      ) : (
        <div className="space-y-5">
          {viewOnly.length ? (
            <Callout tone="info">
              You can view the bills and receipts on {viewOnly.map((a) => a.payer.name).join(" and ")}. Payments are made by another authorized person on the account.
            </Callout>
          ) : null}
          <section aria-labelledby="unpaid-h" className={panel}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge bg-th px-3 py-2.5 sm:px-4">
              <h2 id="unpaid-h" className="text-xs font-bold uppercase tracking-wide text-ink-2">
                Unpaid bills <span className="tabular text-ink-3">({unpaid.length})</span>
              </h2>
              {unpaid.length && currencies.size === 1 ? (
                <p className="text-sm">
                  Total due{" "}
                  <strong>
                    <Money minor={totalDue} currency={unpaid[0].invoice.currency} />
                  </strong>
                </p>
              ) : null}
            </div>
            {unpaid.length === 0 ? <p className="px-4 py-4 text-sm text-ink-3">Nothing due. Thank you!</p> : <BillTable caption="Unpaid bills" rows={unpaid.map((r) => toRow(r, "unpaid"))} />}
          </section>

          <section aria-labelledby="upcoming-h" className={panel}>
            <h2 id="upcoming-h" className={panelHead}>
              Upcoming bills <span className="tabular text-ink-3">({upcoming.length})</span>
            </h2>
            {upcoming.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-3">No bills are scheduled.</p>
            ) : (
              <>
                <BillTable
                  caption="Upcoming bills"
                  rows={upcoming.map((u) => ({
                    key: u.membershipId,
                    due: fmtDate(u.dueDate),
                    description: (
                      <Link className="font-medium hover:underline" href={`/billing/memberships/${u.membershipId}`}>
                        {u.description}
                      </Link>
                    ),
                    amount: <Money minor={u.amountMinor} currency={u.currency} />,
                    status: <Badge variant="blue">Scheduled</Badge>,
                  }))}
                />
                <p className="border-t border-edge px-4 py-2 text-xs text-ink-3">Scheduled amounts are the regular membership price after any discount. A partial period, a hold or a plan change can change the final bill.</p>
              </>
            )}
          </section>

          <section aria-labelledby="history-h" className={panel}>
            <h2 id="history-h" className={panelHead}>
              Bill history <span className="tabular text-ink-3">({history.length})</span>
            </h2>
            {history.length === 0 ? <p className="px-4 py-4 text-sm text-ink-3">No past bills yet.</p> : <BillTable caption="Bill history" rows={history.map((r) => toRow(r, "history"))} />}
          </section>
        </div>
      )}
    </>
  );
}

/** Family tab: who is on each billing account, what they have, and what is due. */
export async function FamilyHome({ v }: { v: Viewer }) {
  const [accounts, invs, ms] = await Promise.all([myPayerAccounts(db, v), listInvoices(db, v, { status: "open", limit: 100 }), listMemberships(db, v)]);
  return (
    <>
      <PageHeader kicker="My Profile" title="Family" description="Your family members, their memberships and session credits, and what is due on each billing account." />
      <BillingTabs current="overview" staff={false} />
      <FamilySuggestion viewer={v} className="mb-5" />
      {accounts.length === 0 ? <EmptyState title="No billing accounts">You aren&apos;t listed on a billing account. If you expected to see one, please contact the front desk.</EmptyState> : null}
      <div className="grid gap-5 [&>*]:min-w-0">
        {accounts.map((a) => {
          const due = invs.filter((r) => r.invoice.payerAccountId === a.payer.id);
          const dueTotal = due.reduce((s, r) => s + r.money.balanceMinor, 0);
          const oneCurrency = new Set(due.map((r) => r.invoice.currency)).size <= 1;
          return (
            <section key={a.payer.id} aria-label={a.payer.name} className={panel}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge bg-th px-3 py-2.5 sm:px-4">
                <div>
                  <div className="kicker">Billing account</div>
                  <h2 className="text-base font-bold">{a.payer.name}</h2>
                </div>
                {a.canPay ? <Badge variant="green">You can pay</Badge> : <Badge title="You can view bills on this account but not pay them">View only</Badge>}
              </div>
              <div className="space-y-4 px-3 py-3 sm:px-4">
                {!a.canPay ? <Callout tone="info">You can view this account&apos;s bills and receipts. Payments are made by another authorized person on the account.</Callout> : null}
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-edge px-3 py-2.5">
                  <div>
                    <div className="text-xs font-semibold text-ink-2">Balance due</div>
                    {due.length === 0 ? (
                      <p className="text-sm text-ink-3">Nothing due. Thank you!</p>
                    ) : (
                      <p className="text-xl font-bold tabular">
                        {oneCurrency ? <Money minor={dueTotal} currency={due[0].invoice.currency} /> : `${due.length} bills`}
                        <span className="ml-2 text-xs font-normal text-ink-3">
                          {due.length} unpaid bill{due.length === 1 ? "" : "s"}
                        </span>
                      </p>
                    )}
                  </div>
                  {due.length === 1 ? (
                    <ButtonLink href={`/billing/invoices/${due[0].invoice.id}#pay`} variant={a.canPay ? "primary" : "secondary"} className="min-h-11">
                      {a.canPay ? "Pay Now" : "View bill"}
                    </ButtonLink>
                  ) : (
                    <ButtonLink href="/billing/invoices" variant={due.length && a.canPay ? "primary" : "secondary"} className="min-h-11">
                      {due.length && a.canPay ? "Pay Now" : "View bills"}
                    </ButtonLink>
                  )}
                </div>
                {due.length ? (
                  <ul className="divide-y divide-edge rounded-md border border-edge text-sm">
                    {due.map((r) => (
                      <li key={r.invoice.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <Link href={`/billing/invoices/${r.invoice.id}`} className="font-medium hover:underline">
                          Bill {r.invoice.number}
                        </Link>
                        <span className="text-xs text-ink-3">
                          due {fmtDate(r.invoice.dueDate)} · <Money minor={r.money.balanceMinor} currency={r.invoice.currency} className="font-semibold text-ink" />
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Family members</h3>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {a.athletes.map((ath) => {
                      const mine = ms.filter((m) => m.m.athleteId === ath.athleteId && m.m.payerAccountId === a.payer.id && m.m.status !== "cancelled");
                      return (
                        <li key={ath.athleteId} className="rounded-md border border-edge px-3 py-2 text-sm">
                          <div className="font-semibold">
                            {ath.first} {ath.last}
                          </div>
                          {mine.length === 0 ? (
                            <div className="text-xs text-ink-3">No membership</div>
                          ) : (
                            mine.map((m) => (
                              <div key={m.m.id} className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                                <Link href={`/billing/memberships/${m.m.id}`} className="font-medium text-ink-2 hover:underline">
                                  {m.productName}
                                </Link>
                                <StatusBadge status={m.m.status} />
                              </div>
                            ))
                          )}
                          <div className="mt-1 text-xs text-ink-2 tabular">
                            {ath.summary.available} session credit{ath.summary.available === 1 ? "" : "s"} available
                            {ath.summary.reserved ? ` · ${ath.summary.reserved} held for reservations` : ""}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

const INTERVAL: Record<string, string> = { week: "week", month: "month", year: "year" };

/** Memberships: one card per membership per person. */
export async function FamilyMemberships({ v }: { v: Viewer }) {
  const today = todayLocal();
  const [rows, accounts] = await Promise.all([listMemberships(db, v), myPayerAccounts(db, v)]);
  const order = ["active", "trialing", "past_due", "on_hold", "pending", "cancelled"];
  rows.sort((a, b) => order.indexOf(a.m.status) - order.indexOf(b.m.status));
  const cards = await Promise.all(
    rows.map(async (r) => {
      const [version] = await db.select().from(productVersions).where(eq(productVersions.id, r.m.productVersionId));
      const [holds, credits, price] = await Promise.all([holdsFor(db, r.m.id), creditSummary(db, r.m.athleteId), version ? periodPrice(db, r.m, version) : null]);
      return { r, version, hold: holds.find((h) => h.endDate >= today) ?? null, credits, price };
    }),
  );
  const packs = accounts.flatMap((a) => a.athletes).filter((ath, i, all) => all.findIndex((x) => x.athleteId === ath.athleteId) === i);
  return (
    <>
      <PageHeader kicker="My Profile" title="Memberships" />
      <BillingTabs current="memberships" staff={false} />
      {cards.length === 0 ? (
        <EmptyState title="No memberships">No one on your billing accounts has a membership yet. Ask the front desk about plans.</EmptyState>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
          {cards.map(({ r, version, hold, credits, price }) => {
            const m = r.m;
            const external = m.billingProvider === "external_zenplanner";
            const ended = m.status === "cancelled";
            const ends = m.endDate ?? m.cancelAt;
            const onHoldNow = hold && hold.startDate <= today;
            return (
              <li key={m.id} className={panel}>
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-edge bg-th px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="kicker">
                      {r.first} {r.last}
                    </div>
                    <h2 className="text-base font-bold">
                      <Link href={`/billing/memberships/${m.id}`} className="hover:underline">
                        {r.productName}
                      </Link>
                    </h2>
                  </div>
                  <StatusBadge status={m.status} />
                </div>
                <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1.5 px-4 py-3 text-sm">
                  <dt className="text-ink-3">Begin date</dt>
                  <dd>{fmtDate(m.startDate)}</dd>
                  <dt className="text-ink-3">{ends ? "End date" : "Renews"}</dt>
                  <dd>{ends ? fmtDate(ends) : ended || external || !m.nextBillDate ? "—" : fmtDate(m.nextBillDate)}</dd>
                  <dt className="text-ink-3">Price</dt>
                  <dd className="tabular">
                    {price && version ? (
                      <>
                        <Money minor={price.net} currency={version.currency} />
                        {INTERVAL[version.interval] ? ` per ${INTERVAL[version.interval]}` : ""}
                        {price.discount ? <span className="text-xs text-ink-3"> after discount</span> : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </dd>
                  <dt className="text-ink-3">Billing day</dt>
                  <dd>
                    {external
                      ? "Billed in the previous system until the move is complete"
                      : m.billingProvider === "none"
                        ? "No billing"
                        : version?.interval === "month" && m.billingAnchorDay
                          ? `Day ${m.billingAnchorDay} of each month`
                          : version?.interval === "week"
                            ? "Weekly"
                            : "—"}
                  </dd>
                  <dt className="text-ink-3">Includes</dt>
                  <dd>{version?.classesPerWeek ? `${version.classesPerWeek} classes per week` : version?.unlimited ? "Unlimited classes" : version?.creditsPerPeriod ? `${version.creditsPerPeriod} session credits per ${INTERVAL[version.interval] ?? "period"}` : "—"}</dd>
                  {!version?.unlimited && !version?.classesPerWeek ? (
                    <>
                      <dt className="text-ink-3">Sessions remaining</dt>
                      <dd className="tabular">{credits.available}</dd>
                    </>
                  ) : null}
                  <dt className="text-ink-3">Hold</dt>
                  <dd>
                    {hold ? (
                      <>
                        <Badge variant="yellow">{onHoldNow ? "On hold" : "Hold scheduled"}</Badge> {fmtDate(hold.startDate)} to {fmtDate(hold.endDate)}
                      </>
                    ) : (
                      "None"
                    )}
                  </dd>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
      {packs.length ? (
        <section aria-labelledby="packs-h" className={`${panel} mt-5`}>
          <h2 id="packs-h" className={panelHead}>
            Session credits
          </h2>
          <ul className="divide-y divide-edge text-sm">
            {packs.map((p) => (
              <li key={p.athleteId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span className="font-medium">
                  {p.first} {p.last}
                </span>
                <span className="tabular text-ink-2">
                  <strong className="text-ink">{p.summary.available}</strong> remaining{p.summary.reserved ? ` · ${p.summary.reserved} held for reservations` : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-edge px-4 py-2 text-xs text-ink-3">To pause, change or cancel a membership, please contact the front desk.</p>
        </section>
      ) : null}
    </>
  );
}
