ALTER TABLE "invoices" ADD COLUMN "family_rate_percent" integer;--> statement-breakpoint
ALTER TABLE "account_credit_ledger" ADD COLUMN "membership_id" uuid;--> statement-breakpoint
ALTER TABLE "account_credit_ledger" ADD CONSTRAINT "account_credit_ledger_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_credit_membership_idx" ON "account_credit_ledger" USING btree ("membership_id");--> statement-breakpoint
-- Hand-written (not generated): the ledger's kind CHECK gains the family rate sibling credit.
ALTER TABLE "account_credit_ledger" DROP CONSTRAINT "account_credit_kind_ck";--> statement-breakpoint
ALTER TABLE "account_credit_ledger" ADD CONSTRAINT "account_credit_kind_ck" CHECK (("kind" = 'referral_reward' AND "delta_minor" > 0 AND "reward_id" IS NOT NULL) OR ("kind" = 'applied_to_invoice' AND "delta_minor" < 0 AND "invoice_id" IS NOT NULL) OR ("kind" = 'family_rate_credit' AND "delta_minor" > 0 AND "invoice_id" IS NOT NULL AND "membership_id" IS NOT NULL));