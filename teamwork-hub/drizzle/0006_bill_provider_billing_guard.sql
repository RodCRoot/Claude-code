-- Billing integrity (additive). A membership billed by a provider subscription (Stripe Billing /
-- PayPal Subscriptions) must never also be scheduled for Teamwork renewal invoices. The renewal job
-- only selects billing_provider = 'manual', and this constraint makes the schedule impossible too.
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_provider_billed_not_renewed"
  CHECK ("billing_provider" NOT IN ('stripe', 'paypal') OR "next_bill_date" IS NULL);
--> statement-breakpoint
-- A provider-billed membership is always linked to exactly one provider subscription.
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_provider_billed_has_subscription"
  CHECK ("billing_provider" NOT IN ('stripe', 'paypal') OR "provider_subscription_id" IS NOT NULL);
