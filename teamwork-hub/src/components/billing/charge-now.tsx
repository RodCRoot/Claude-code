import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ButtonLink, Callout, NotConfigured } from "@/components/ui";
import type { ChargeNowView } from "@/lib/billing/autopay";
import { formatMoney } from "@/lib/money";
import { fmt } from "@/lib/time";
import { chargeNowAction } from "@/app/(app)/billing/actions";

/**
 * "Charge now" / "Retry now" on an unpaid bill of a membership with autopay on (invoice page).
 * Two steps on the page itself: the first link only opens the confirmation (`?charge=1`), the
 * confirmation names the amount, the method and the attempt, and only its button charges.
 */
export function ChargeNowPanel({ c, confirming, staff }: { c: ChargeNowView; confirming: boolean; staff: boolean }) {
  const amount = formatMoney(c.balanceMinor, c.currency);
  const here = `/billing/invoices/${c.invoiceId}`;
  return (
    <section id="autopay-now" aria-labelledby="autopay-now-h" className="space-y-2 border-t border-edge pt-3">
      <h3 id="autopay-now-h" className="text-sm font-bold">
        Autopay
      </h3>
      {c.lastFailure ? (
        <p className="text-sm text-ink-2">
          The last automatic charge failed on {fmt(c.lastFailure.at, "MMM d, yyyy")}: {c.lastFailure.message}
        </p>
      ) : (
        <p className="text-sm text-ink-2">Autopay is on for this membership. This bill has not been charged yet.</p>
      )}
      {!c.configured ? (
        staff ? (
          <NotConfigured provider="Stripe" envVars={c.missingEnv}>
            A saved card or bank account cannot be charged until Stripe is connected. Nothing is charged automatically. Record a payment below instead.
          </NotConfigured>
        ) : (
          <Callout tone="warn" title="Automatic payments are not available yet">
            Nothing is charged automatically right now. Please pay this bill at the front desk.
          </Callout>
        )
      ) : c.blocked ? (
        <Callout tone="info">{c.blocked}</Callout>
      ) : confirming ? (
        <div className="space-y-3 rounded-md border border-brand bg-surface-2 p-3" role="group" aria-label={`Confirm: ${c.label.toLowerCase()}`}>
          <p className="text-sm font-semibold">
            Charge {amount} to {c.methodLabel} now?
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-ink-2">
            <li>
              This is automatic attempt {c.attemptNumber} for {c.number}, made today instead of on its scheduled day. It is never made twice.
            </li>
            <li>The bill is marked paid only when Stripe confirms the payment. A bank payment stays pending for a few business days.</li>
            <li>No message is sent to the family.</li>
          </ul>
          <ActionForm action={chargeNowAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="invoiceId" value={c.invoiceId} />
            <input type="hidden" name="attemptNumber" value={c.attemptNumber} />
            <SubmitButton className="min-h-11" pendingText="Charging…">
              Yes, charge {amount}
            </SubmitButton>
            <ButtonLink href={`${here}#autopay-now`} variant="ghost" className="min-h-11">
              Cancel
            </ButtonLink>
          </ActionForm>
        </div>
      ) : (
        <ButtonLink href={`${here}?charge=1#autopay-now`} variant="secondary" className="min-h-11 w-full">
          {c.label}: {amount} to {c.methodLabel}
        </ButtonLink>
      )}
    </section>
  );
}

/**
 * Shown wherever autopay can be switched on: bills that already existed are not charged by
 * switching it on, so each one is listed with the way to charge it now.
 */
export function UnpaidAutopayBills({ bills, staff, className }: { bills: ChargeNowView[]; staff: boolean; className?: string }) {
  if (!bills.length) return null;
  const one = bills.length === 1;
  return (
    <Callout tone="warn" title={one ? "Autopay is on, but one bill is still unpaid" : `Autopay is on, but ${bills.length} bills are still unpaid`} className={className}>
      <p>
        Autopay charges each new bill on its due date. {one ? "This bill" : "These bills"} already existed{bills.some((b) => b.lastFailure) ? " or failed" : ""}, so {one ? "it is" : "they are"} not charged unless you choose to.
      </p>
      <ul className="mt-2 space-y-2">
        {bills.map((b) => (
          <li key={b.invoiceId} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <Link href={`/billing/invoices/${b.invoiceId}`} className="font-semibold underline">
                {b.number}
              </Link>{" "}
              · {formatMoney(b.balanceMinor, b.currency)} unpaid
            </span>
            {!b.configured ? (
              <span className="text-xs">{staff ? "Stripe is not connected: record a payment on the bill." : "Pay at the front desk."}</span>
            ) : b.blocked ? (
              <span className="text-xs">{b.blocked}</span>
            ) : (
              <ButtonLink href={`/billing/invoices/${b.invoiceId}?charge=1#autopay-now`} size="sm" className="min-h-11">
                {b.label}…
              </ButtonLink>
            )}
          </li>
        ))}
      </ul>
    </Callout>
  );
}
