import { ActionForm, SubmitButton } from "@/components/forms";
import { Callout } from "@/components/ui";
import { mandateText, MANDATE_TEXT_VERSION, STORAGE_NOTICE } from "@/lib/billing/mandate-text";
import { startMethodSetupAction } from "@/app/(app)/billing/payment-methods/actions";

/**
 * "Add card" / "Add bank account" for one payer account. Both lead to a Stripe-hosted page; no card or
 * bank number is typed into Teamwork Hub. Without Stripe keys the honest not-configured state is shown.
 */
export function AddMethod({ payerAccountId, orgName, configured, signupFlowId, idPrefix = "pm" }: { payerAccountId: string; orgName: string; configured: boolean; signupFlowId?: string; idPrefix?: string }) {
  if (!configured) {
    return (
      <Callout tone="warn" title="Saving a card or bank account is not available yet">
        Online card and bank payments are not connected for this gym yet, so nothing can be saved here and nothing will be charged automatically. Bills can still be paid at the front desk (cash, check or another method the gym accepts).
      </Callout>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">{STORAGE_NOTICE}</p>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <ActionForm action={startMethodSetupAction} className="space-y-3 rounded-md border border-edge p-3">
          <input type="hidden" name="payerAccountId" value={payerAccountId} />
          <input type="hidden" name="type" value="card" />
          {signupFlowId ? <input type="hidden" name="signupFlowId" value={signupFlowId} /> : null}
          <h3 className="text-sm font-bold">Card</h3>
          <p className="text-sm text-ink-2">Credit or debit card. You enter it on Stripe&apos;s secure page.</p>
          <SubmitButton variant="secondary" className="min-h-11 w-full sm:w-auto">
            Add a card
          </SubmitButton>
        </ActionForm>
        <ActionForm action={startMethodSetupAction} className="space-y-3 rounded-md border border-edge p-3">
          <input type="hidden" name="payerAccountId" value={payerAccountId} />
          <input type="hidden" name="type" value="us_bank_account" />
          {signupFlowId ? <input type="hidden" name="signupFlowId" value={signupFlowId} /> : null}
          <h3 className="text-sm font-bold">Bank account</h3>
          <p className="text-sm text-ink-2">US checking or savings account. Bank payments take a few business days to clear, and the bill shows as pending until they do.</p>
          <div className="rounded-md bg-surface-2 p-3 text-xs leading-relaxed text-ink-2" id={`${idPrefix}-mandate-text`}>
            <span className="font-semibold">Bank debit authorization (version {MANDATE_TEXT_VERSION}).</span> {mandateText(orgName)}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="mandateAccepted" className="mt-1 size-4" aria-describedby={`${idPrefix}-mandate-text`} />
            <span>I have read and agree to the bank debit authorization above.</span>
          </label>
          <SubmitButton variant="secondary" className="min-h-11 w-full sm:w-auto">
            Add a bank account
          </SubmitButton>
        </ActionForm>
      </div>
    </div>
  );
}
