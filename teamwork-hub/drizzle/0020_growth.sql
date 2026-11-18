CREATE TABLE "account_credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"payer_account_id" uuid NOT NULL,
	"delta_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"kind" text NOT NULL,
	"reward_id" uuid,
	"invoice_id" uuid,
	"reason" text,
	"actor_user_id" uuid,
	"idempotency_key" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"offer_key" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"offer_key" text NOT NULL,
	"event" text NOT NULL,
	"audience" text NOT NULL,
	"user_id" uuid,
	"day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"payer_account_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"referral_id" uuid NOT NULL,
	"beneficiary" text NOT NULL,
	"payer_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint,
	"currency" text,
	"credits" integer,
	"credit_expiry_days" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"athlete_id" uuid,
	"credit_bucket_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decline_reason" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code_id" uuid NOT NULL,
	"referrer_payer_account_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"status" text DEFAULT 'inquired' NOT NULL,
	"rejection_reason" text,
	"attached_via" text DEFAULT 'link' NOT NULL,
	"attached_by" uuid,
	"converted_athlete_id" uuid,
	"converted_payer_account_id" uuid,
	"membership_id" uuid,
	"qualifying_invoice_id" uuid,
	"started_at" timestamp with time zone,
	"earned_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sellable_online" boolean DEFAULT false NOT NULL,
	"includes" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payer_account_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_version_id" uuid NOT NULL,
	"placed_by_user_id" uuid,
	"idempotency_key" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trial_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid,
	"person_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"credits" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"credit_bucket_id" uuid,
	"issued_by" uuid,
	"idempotency_key" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_credit_ledger" ADD CONSTRAINT "account_credit_ledger_payer_account_id_payer_accounts_id_fk" FOREIGN KEY ("payer_account_id") REFERENCES "public"."payer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credit_ledger" ADD CONSTRAINT "account_credit_ledger_reward_id_referral_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."referral_rewards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credit_ledger" ADD CONSTRAINT "account_credit_ledger_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credit_ledger" ADD CONSTRAINT "account_credit_ledger_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_dismissals" ADD CONSTRAINT "offer_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_dismissals" ADD CONSTRAINT "offer_dismissals_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_payer_account_id_payer_accounts_id_fk" FOREIGN KEY ("payer_account_id") REFERENCES "public"."payer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referral_id_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referrals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_payer_account_id_payer_accounts_id_fk" FOREIGN KEY ("payer_account_id") REFERENCES "public"."payer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_credit_bucket_id_credit_buckets_id_fk" FOREIGN KEY ("credit_bucket_id") REFERENCES "public"."credit_buckets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_code_id_referral_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."referral_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_payer_account_id_payer_accounts_id_fk" FOREIGN KEY ("referrer_payer_account_id") REFERENCES "public"."payer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_attached_by_users_id_fk" FOREIGN KEY ("attached_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_converted_athlete_id_athletes_id_fk" FOREIGN KEY ("converted_athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_converted_payer_account_id_payer_accounts_id_fk" FOREIGN KEY ("converted_payer_account_id") REFERENCES "public"."payer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_qualifying_invoice_id_invoices_id_fk" FOREIGN KEY ("qualifying_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_listings" ADD CONSTRAINT "shop_listings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_listings" ADD CONSTRAINT "shop_listings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_payer_account_id_payer_accounts_id_fk" FOREIGN KEY ("payer_account_id") REFERENCES "public"."payer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_product_version_id_product_versions_id_fk" FOREIGN KEY ("product_version_id") REFERENCES "public"."product_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_placed_by_user_id_users_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_passes" ADD CONSTRAINT "trial_passes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_passes" ADD CONSTRAINT "trial_passes_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_passes" ADD CONSTRAINT "trial_passes_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_passes" ADD CONSTRAINT "trial_passes_credit_bucket_id_credit_buckets_id_fk" FOREIGN KEY ("credit_bucket_id") REFERENCES "public"."credit_buckets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_passes" ADD CONSTRAINT "trial_passes_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_credit_idem_uq" ON "account_credit_ledger" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "account_credit_payer_idx" ON "account_credit_ledger" USING btree ("payer_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_dismissals_uq" ON "offer_dismissals" USING btree ("user_id","athlete_id","offer_key");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_events_daily_uq" ON "offer_events" USING btree ("user_id","athlete_id","offer_key","event","day");--> statement-breakpoint
CREATE INDEX "offer_events_org_idx" ON "offer_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_code_uq" ON "referral_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_active_payer_uq" ON "referral_codes" USING btree ("payer_account_id") WHERE "referral_codes"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "referral_rewards_uq" ON "referral_rewards" USING btree ("referral_id","beneficiary");--> statement-breakpoint
CREATE INDEX "referral_rewards_status_idx" ON "referral_rewards" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_lead_uq" ON "referrals" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("org_id","referrer_payer_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_listings_product_uq" ON "shop_listings" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_orders_idem_uq" ON "shop_orders" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_orders_invoice_uq" ON "shop_orders" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trial_passes_idem_uq" ON "trial_passes" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "trial_passes_lead_idx" ON "trial_passes" USING btree ("lead_id");--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_status_ck" CHECK ("status" IN ('active','revoked'));--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_code_format_ck" CHECK ("code" ~ '^[a-z0-9]{8,16}$');--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_status_ck" CHECK ("status" IN ('inquired','started','earned','rejected'));--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_rejection_ck" CHECK (("status" = 'rejected') = ("rejection_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_status_ck" CHECK ("status" IN ('pending','approved','declined'));--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_beneficiary_ck" CHECK ("beneficiary" IN ('referrer','referred'));--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_shape_ck" CHECK (
  ("kind" = 'account_credit' AND "amount_minor" > 0 AND "currency" ~ '^[A-Z]{3}$' AND "credits" IS NULL)
  OR ("kind" = 'session_credits' AND "credits" > 0 AND "amount_minor" IS NULL));--> statement-breakpoint
ALTER TABLE "account_credit_ledger" ADD CONSTRAINT "account_credit_nonzero_ck" CHECK ("delta_minor" <> 0 AND "currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "account_credit_ledger" ADD CONSTRAINT "account_credit_kind_ck" CHECK (("kind" = 'referral_reward' AND "delta_minor" > 0 AND "reward_id" IS NOT NULL) OR ("kind" = 'applied_to_invoice' AND "delta_minor" < 0 AND "invoice_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "trial_passes" ADD CONSTRAINT "trial_passes_credits_ck" CHECK ("credits" > 0 AND length(btrim("reason")) > 0);--> statement-breakpoint
ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_event_ck" CHECK ("event" IN ('shown','accepted','dismissed','task_created') AND "audience" IN ('family','staff'));