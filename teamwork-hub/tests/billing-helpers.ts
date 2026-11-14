import { eq, sql } from "drizzle-orm";
import { paymentMethods, payerAccounts } from "@/db/schema";
import { ingestWebhook } from "@/lib/billing/webhooks";
import { signedHeaders } from "./fixtures/payments/stripe";
import { testDb } from "./helpers/db";

export const sendStripe = (event: object) => {
  const body = JSON.stringify(event);
  return ingestWebhook(testDb(), "stripe", body, signedHeaders(body));
};

/** Give a payer a Stripe customer reference, as if a setup had been started. */
export async function giveCustomer(payerAccountId: string, customerId = `cus_test_${payerAccountId.slice(0, 8)}`) {
  await testDb().execute(sql`update payer_accounts set provider_refs = provider_refs || ${JSON.stringify({ stripeCustomerId: customerId })}::jsonb where id = ${payerAccountId}`);
  return customerId;
}

/** An already-active saved method (as left behind by verified webhooks). Synthetic values. */
export async function activeMethod(payerAccountId: string, o: { type?: "card" | "us_bank_account"; isDefault?: boolean; last4?: string; expMonth?: number; expYear?: number; id?: string } = {}) {
  const customer = await giveCustomer(payerAccountId);
  const type = o.type ?? "card";
  const pm = o.id ?? `pm_test_${type === "card" ? "card" : "bank"}_${Math.random().toString(36).slice(2, 10)}`;
  const [m] = await testDb()
    .insert(paymentMethods)
    .values({
      payerAccountId,
      provider: "stripe",
      providerCustomerId: customer,
      providerMethodId: pm,
      type,
      brand: type === "card" ? "visa" : null,
      bankName: type === "us_bank_account" ? "First Example Bank" : null,
      last4: o.last4 ?? (type === "card" ? "4242" : "6789"),
      expMonth: type === "card" ? (o.expMonth ?? 8) : null,
      expYear: type === "card" ? (o.expYear ?? 2028) : null,
      status: "active",
      isDefault: o.isDefault ?? true,
      detailsAt: new Date(),
      setupSucceededAt: new Date(),
      mandateRef: type === "us_bank_account" ? `mandate_test_${pm.slice(-6)}` : null,
      mandateStatus: type === "us_bank_account" ? "active" : null,
    })
    .returning();
  return m;
}

export async function payerRow(id: string) {
  const [p] = await testDb().select().from(payerAccounts).where(eq(payerAccounts.id, id));
  return p;
}
