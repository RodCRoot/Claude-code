import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { can } from "@/lib/authz/policy";
import { listCatalog, PRODUCT_KINDS } from "@/lib/billing/catalog";
import { fmtDate, todayLocal } from "@/lib/time";
import { createProductAction, createVersionAction, toggleProductAction } from "../actions";
import { BillingTabs, Money, requireBillingStaff } from "../_components";

export const metadata = { title: "Products" };

function VersionFields({ prefix, recurring }: { prefix: string; recurring?: boolean }) {
  const id = (k: string) => `${prefix}-${k}`;
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      <Field label="Price ($)" htmlFor={id("price")} required hint="Enter the real price"><Input id={id("price")} name="price" inputMode="decimal" required /></Field>
      <Field label="Effective from" htmlFor={id("eff")} required><Input id={id("eff")} name="effectiveFrom" type="date" required defaultValue={todayLocal()} /></Field>
      <Field label="Billing interval" htmlFor={id("int")} hint="Recurring memberships only">
        <Select id={id("int")} name="interval" defaultValue={recurring ? "month" : "none"}>
          <option value="none">One-time</option><option value="week">Weekly</option><option value="month">Monthly</option><option value="year">Yearly</option>
        </Select>
      </Field>
      <Field label="Credits (per purchase/period)" htmlFor={id("cr")}><Input id={id("cr")} name="credits" type="number" min={1} /></Field>
      <Field label="Credit expiry (days)" htmlFor={id("ce")}><Input id={id("ce")} name="creditExpiryDays" type="number" min={1} /></Field>
      <Field label="Trial days" htmlFor={id("tr")}><Input id={id("tr")} name="trialDays" type="number" min={0} /></Field>
      <Field label="Commitment (months)" htmlFor={id("cm")}><Input id={id("cm")} name="commitmentMonths" type="number" min={0} /></Field>
      <Field label="Cancellation notice (days)" htmlFor={id("nd")}><Input id={id("nd")} name="noticeDays" type="number" min={0} /></Field>
      <Field label="Classes per week" htmlFor={id("cpw")} hint="1x / 2x / 3x plans. Leave empty for no weekly limit."><Input id={id("cpw")} name="classesPerWeek" type="number" min={1} max={14} /></Field>
      <Field label="Sibling discount (%)" htmlFor={id("sd")} hint="Informational. The family discount from Settings → Membership policy applies automatically."><Input id={id("sd")} name="siblingPercentOff" type="number" min={0} max={100} /></Field>
      <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" name="unlimited" /> Unlimited sessions</label>
    </div>
  );
}

export default async function ProductsPage() {
  const v = await requireBillingStaff();
  const today = todayLocal();
  const catalog = await listCatalog(db, v.orgId, today);
  const manage = can(v, "billing.manage");
  return (
    <>
      <PageHeader kicker="Billing" title="Products & price versions" description="Prices are immutable versions with effective dates. A price change creates a new version; existing memberships keep the version they bought." />
      <BillingTabs current="products" staff />
      {catalog.some((c) => c.product.name.startsWith("Sample")) ? (
        <Callout tone="warn" title="Sample catalog" className="mb-4">Products named “Sample — …” carry placeholder prices for the demo. Real products and prices are the owner&apos;s to enter.</Callout>
      ) : null}
      <Card>
        <CardBody className="pt-4">
          <Table caption="Products">
            <thead><tr><Th>Product</Th><Th>Kind</Th><Th align="right">Current price</Th><Th>Terms</Th><Th>Versions</Th><Th /></tr></thead>
            <tbody>
              {catalog.map(({ product: p, current, versions, upcoming }) => (
                <tr key={p.id} className={p.active ? "" : "opacity-60"}>
                  <Td>
                    <div className="font-medium">{p.name}</div>
                    {p.sku ? <div className="text-xs text-ink-3">SKU {p.sku}</div> : null}
                    {!p.active ? <Badge>archived</Badge> : null}
                  </Td>
                  <Td>{PRODUCT_KINDS.find((k) => k.value === p.kind)?.label}</Td>
                  <Td align="right">{current ? <><Money minor={current.priceMinor} currency={current.currency} />{current.interval !== "none" ? `/${current.interval}` : ""}</> : <span className="text-ink-3">none in effect</span>}</Td>
                  <Td className="text-xs">
                    {current ? [
                      current.classesPerWeek ? `${current.classesPerWeek}x/week` : current.unlimited ? "unlimited" : current.creditsPerPeriod ? `${current.creditsPerPeriod} credits` : null,
                      current.creditExpiryDays ? `expire ${current.creditExpiryDays}d` : null,
                      current.familyDiscount?.siblingPercentOff ? `sibling ${current.familyDiscount.siblingPercentOff}%` : null,
                      current.commitmentMonths ? `${current.commitmentMonths}mo commitment` : null,
                      current.cancellationNoticeDays ? `${current.cancellationNoticeDays}d notice` : null,
                      current.trialDays ? `${current.trialDays}d trial` : null,
                    ].filter(Boolean).join(" · ") : "—"}
                    {upcoming.length ? <div className="text-warn">Upcoming: {upcoming.map((u) => `v${u.version} from ${fmtDate(u.effectiveFrom)}`).join(", ")}</div> : null}
                  </Td>
                  <Td>
                    <details>
                      <summary className="cursor-pointer text-sm">{versions.length} version(s)</summary>
                      <ul className="mt-1 space-y-0.5 text-xs">
                        {versions.map((x) => (
                          <li key={x.id}>v{x.version}: <Money minor={x.priceMinor} /> · {fmtDate(x.effectiveFrom)} → {x.effectiveTo ? fmtDate(x.effectiveTo) : "open"}</li>
                        ))}
                      </ul>
                      {manage ? (
                        <ActionForm action={createVersionAction} className="mt-3 min-w-[min(80vw,640px)] space-y-3 rounded-lg border border-edge p-3">
                          <input type="hidden" name="productId" value={p.id} />
                          <p className="text-xs font-semibold">New version (price/terms change)</p>
                          <VersionFields prefix={`v-${p.id}`} recurring={p.kind === "recurring_membership"} />
                          <SubmitButton size="sm">Create version</SubmitButton>
                        </ActionForm>
                      ) : null}
                    </details>
                  </Td>
                  <Td>
                    {manage ? (
                      <ActionForm action={toggleProductAction}>
                        <input type="hidden" name="productId" value={p.id} />
                        <input type="hidden" name="active" value={p.active ? "false" : "true"} />
                        <SubmitButton size="sm" variant="ghost">{p.active ? "Archive" : "Restore"}</SubmitButton>
                      </ActionForm>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>
      {manage ? (
        <Card className="mt-6">
          <CardHeader title="New product" />
          <CardBody>
            <ActionForm action={createProductAction} className="space-y-4" resetOnSuccess>
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Name" htmlFor="pname" required className="sm:col-span-2"><Input id="pname" name="name" required /></Field>
                <Field label="Kind" htmlFor="pkind" required>
                  <Select id="pkind" name="kind" required>{PRODUCT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select>
                </Field>
                <Field label="SKU (retail)" htmlFor="psku"><Input id="psku" name="sku" /></Field>
                <Field label="Category" htmlFor="pcat"><Input id="pcat" name="category" /></Field>
                <Field label="Description" htmlFor="pdesc" className="sm:col-span-3"><Input id="pdesc" name="description" /></Field>
              </div>
              <VersionFields prefix="new" />
              <SubmitButton>Create product</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
