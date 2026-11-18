import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SettingsTabs } from "@/components/settings-tabs";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { agreementSettings, agreementTemplateVersion, unsignedAgreements } from "@/lib/agreements/issue";
import { MERGE_FIELDS, RESIGN_TRIGGERS } from "@/lib/agreements/terms";
import { requireCap } from "@/lib/auth/viewer";
import { autopaySettings, type FeeEstimate } from "@/lib/billing/autopay-settings";
import { MANDATE_TEXT_VERSION } from "@/lib/billing/mandate-text";
import { expiringCards } from "@/lib/billing/payment-methods";
import { minorToDecimal } from "@/lib/payments/provider";
import { getSavedMethodProvider } from "@/lib/payments";
import { fmtDate } from "@/lib/time";
import { createSampleAgreementAction, saveAgreementSettingsAction, saveAutopaySettingsAction } from "./actions";

export const metadata = { title: "Payments and agreements" };

const pct = (e: FeeEstimate | null) => (e ? String(e.percentBps / 100) : "");
const usd = (n: number | null | undefined) => (n == null ? "" : minorToDecimal(n));

export default async function PaymentsSettingsPage() {
  const v = await requireCap("settings.manage");
  const [auto, agr, tpl, expiring, unsigned] = await Promise.all([autopaySettings(db, v.orgId), agreementSettings(db, v.orgId), agreementTemplateVersion(db, v.orgId), expiringCards(db, v.orgId), unsignedAgreements(db, v.orgId)]);
  const adapter = getSavedMethodProvider();
  const need = (k: string) => (auto.unconfirmed.includes(k) ? <Badge variant="yellow">Needs confirmation</Badge> : null);
  return (
    <>
      <PageHeader kicker="Settings" title="Payments and agreements" description="Autopay retries, the optional bank pay discount, fee estimates, and the rules for membership agreements. Nothing here sets a price or a fee rate for you." />
      <SettingsTabs current="payments" />
      {!adapter.isConfigured() ? (
        <Callout tone="warn" title="Stripe is not configured" className="mb-5">
          Saved cards, bank accounts and autopay need {adapter.missingEnv().join(", ")} on the server. Until then families see an honest &quot;not available yet&quot; notice, nothing is charged automatically, and bills are paid manually as today.
        </Callout>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader title="Autopay retries and bank pay discount" />
          <CardBody>
            <ActionForm action={saveAutopaySettingsAction} className="space-y-4">
              <Field label={<span className="flex items-center gap-2">Retry a declined card after (days) {need("cardRetryDays")}</span>} htmlFor="cardRetryDays" hint="Comma separated, one entry per retry. Leave empty for no automatic retries. A card that needs updating (expired, closed) is never retried. Sample starting values.">
                <Input id="cardRetryDays" name="cardRetryDays" defaultValue={auto.cardRetryDays.join(", ")} inputMode="numeric" />
              </Field>
              <Field label={<span className="flex items-center gap-2">Retry a bank payment returned for insufficient funds after (days) {need("achRetryWaitDays")}</span>} htmlFor="achRetryWaitDays" hint="One retry only. A closed account or a revoked authorization is never retried: the family is asked for a new payment method. Sample starting value.">
                <Input id="achRetryWaitDays" name="achRetryWaitDays" type="number" min={1} max={60} defaultValue={auto.achRetryWaitDays} className="w-28" />
              </Field>
              <fieldset className="space-y-2 rounded-md border border-edge p-3">
                <legend className="px-1 text-sm font-semibold">Bank pay discount (optional)</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="bankPayDiscountEnabled" defaultChecked={auto.bankPayDiscount.enabled} className="mt-1 size-4" />
                  <span>Take a discount off each monthly bill when the autopay method is a bank account. Off by default. There is no card surcharge feature.</span>
                </label>
                <div className="flex flex-wrap gap-3">
                  <label className="text-sm">
                    <span className="mb-1 block font-semibold">Type</span>
                    <Select name="bankPayDiscountKind" defaultValue={auto.bankPayDiscount.kind}>
                      <option value="fixed">Dollar amount</option>
                      <option value="percent">Percent</option>
                    </Select>
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block font-semibold">Amount</span>
                    <Input name="bankPayDiscountValue" defaultValue={auto.bankPayDiscount.value ? (auto.bankPayDiscount.kind === "percent" ? String(auto.bankPayDiscount.value) : usd(auto.bankPayDiscount.value)) : ""} placeholder="5.00 or 2" className="w-32" />
                  </label>
                </div>
                <p className="text-xs text-ink-3">It shows on the bill as &quot;Bank pay discount&quot;. Ask your accountant and lawyer before turning it on.</p>
              </fieldset>
              <fieldset className="space-y-2 rounded-md border border-edge p-3">
                <legend className="px-1 text-sm font-semibold">Fee estimates (optional)</legend>
                <p className="text-xs text-ink-3">Estimates only, used in the Processing fees report next to the real fees Stripe reports. Copy the rates for your account from Stripe&apos;s pricing page; none are built in.</p>
                {(
                  [
                    ["estCard", "Card", auto.feeEstimates.card],
                    ["estBank", "Bank account (ACH)", auto.feeEstimates.us_bank_account],
                  ] as const
                ).map(([k, label, e]) => (
                  <div key={k} className="flex flex-wrap items-end gap-3">
                    <span className="w-full text-sm font-semibold sm:w-36">{label}</span>
                    <label className="text-xs">
                      <span className="mb-1 block">Percent</span>
                      <Input name={`${k}Percent`} defaultValue={pct(e)} inputMode="decimal" className="w-24" />
                    </label>
                    <label className="text-xs">
                      <span className="mb-1 block">Plus fixed ($)</span>
                      <Input name={`${k}Fixed`} defaultValue={e ? usd(e.fixedMinor) : ""} inputMode="decimal" className="w-24" />
                    </label>
                    <label className="text-xs">
                      <span className="mb-1 block">Cap ($, optional)</span>
                      <Input name={`${k}Cap`} defaultValue={usd(e?.capMinor)} inputMode="decimal" className="w-24" />
                    </label>
                  </div>
                ))}
              </fieldset>
              <SubmitButton>Save payment settings</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Membership agreement rules" />
          <CardBody className="space-y-4">
            {tpl ? (
              <p className="text-sm text-ink-2">
                Template: <Link href={`/documents/templates/${tpl.tpl.id}`} className="font-semibold underline">{tpl.tpl.name}</Link> v{tpl.ver.version} {tpl.ver.isSampleText ? <Badge variant="yellow">Sample text</Badge> : <Badge variant="green">Approved text</Badge>}
              </p>
            ) : (
              <ActionForm action={createSampleAgreementAction} className="space-y-2">
                <Callout tone="warn" title="No membership agreement template">
                  Create the sample template to try the sign-up flow. It is placeholder wording for your lawyer to replace, not legal advice.
                </Callout>
                <SubmitButton variant="secondary">Create the sample template</SubmitButton>
              </ActionForm>
            )}
            <ActionForm action={saveAgreementSettingsAction} className="space-y-4">
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold">While an agreement is unsigned</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="blockReservationsUntilSigned" defaultChecked={agr.blockReservationsUntilSigned} className="mt-1 size-4" />
                  <span>Reservations are blocked until it is signed (same as required forms).</span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="billingWaitsForSignature" defaultChecked={agr.billingWaitsForSignature} className="mt-1 size-4" />
                  <span>Billing waits for the signature. Unchecked means bills go out as scheduled.</span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="requireForNewMemberships" defaultChecked={agr.requireForNewMemberships} className="mt-1 size-4" />
                  <span>Tick &quot;Require a membership agreement&quot; by default when staff add a membership.</span>
                </label>
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold">A new agreement must be signed when</legend>
                {RESIGN_TRIGGERS.map((t) => (
                  <label key={t.key} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name={`resign_${t.key}`} defaultChecked={agr.resignOn.includes(t.key)} className="mt-1 size-4" />
                    <span>
                      <span className="font-semibold">{t.label}.</span> <span className="text-ink-2">{t.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <SubmitButton>Save agreement rules</SubmitButton>
            </ActionForm>
            <details className="text-sm">
              <summary className="cursor-pointer font-semibold">Merge fields for the template</summary>
              <p className="mt-2 text-xs text-ink-3">Type these in the template body. Each is filled from the membership, its plan version and your policy settings when the agreement is issued, and the result is frozen in the signed record. Bank debit authorization text version: {MANDATE_TEXT_VERSION} (sample).</p>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {MERGE_FIELDS.map((f) => (
                  <li key={f.key} className="text-xs">
                    <code className="rounded bg-surface-2 px-1">{`{{${f.key}}}`}</code> {f.label}
                  </li>
                ))}
              </ul>
            </details>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Cards expiring in the next 60 days" />
          <CardBody>
            {expiring.length === 0 ? (
              <p className="text-sm text-ink-2">No saved card expires in the next 60 days.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {expiring.map((e) => (
                  <li key={e.methodId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-edge px-3 py-2">
                    <Link href={`/billing/payment-methods?payer=${e.payerAccountId}`} className="font-semibold hover:underline">{e.payerName}</Link>
                    <span className="text-ink-2">{e.label} · good through {fmtDate(e.expiresOn)}{e.autopayMemberships ? ` · autopay for ${e.autopayMemberships}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Agreements waiting for a signature" />
          <CardBody>
            {unsigned.length === 0 ? (
              <p className="text-sm text-ink-2">Every membership that needs an agreement has one signed.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {unsigned.map((u) => (
                  <li key={u.membershipId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-edge px-3 py-2">
                    <Link href={`/billing/memberships/${u.membershipId}`} className="font-semibold hover:underline">{u.athleteName}</Link>
                    <span className="text-ink-2">{u.product} · issued {fmtDate(u.issuedAt)} · <Link href={`/documents/requests/${u.formRequestId}`} className="underline">open</Link></span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
