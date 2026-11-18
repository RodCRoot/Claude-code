CREATE TABLE "membership_agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"product_version_id" uuid NOT NULL,
	"form_request_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"terms" jsonb NOT NULL,
	"terms_hash" text NOT NULL,
	"signed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"superseded_by_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_method_setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"payer_account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"requested_type" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"provider_session_id" text,
	"provider_setup_intent_id" text,
	"provider_method_id" text,
	"checkout_url" text,
	"verification_url" text,
	"mandate_acceptance" jsonb,
	"make_default" boolean DEFAULT false NOT NULL,
	"signup_flow_id" uuid,
	"idempotency_key" text NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"started_by" uuid,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signup_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"athlete_id" uuid NOT NULL,
	"payer_account_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"product_version_id" uuid,
	"start_date" date,
	"membership_id" uuid,
	"payment_choice" text,
	"started_by" uuid,
	"started_by_staff" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "autopay" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "autopay_method_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "agreement_state" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "origin" text DEFAULT 'checkout' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "provider_customer_id" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "details_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "setup_succeeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "mandate_ref" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "mandate_status" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "mandate_acceptance" jsonb;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "failure_message" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "setup_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "removed_by" uuid;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "fee_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "form_requests" ADD COLUMN "rendered_body_markdown" text;--> statement-breakpoint
ALTER TABLE "form_requests" ADD COLUMN "merge_values" jsonb;--> statement-breakpoint
ALTER TABLE "membership_agreements" ADD CONSTRAINT "membership_agreements_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_agreements" ADD CONSTRAINT "membership_agreements_product_version_id_product_versions_id_fk" FOREIGN KEY ("product_version_id") REFERENCES "public"."product_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_method_setups" ADD CONSTRAINT "payment_method_setups_payer_account_id_payer_accounts_id_fk" FOREIGN KEY ("payer_account_id") REFERENCES "public"."payer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_flows" ADD CONSTRAINT "signup_flows_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_flows" ADD CONSTRAINT "signup_flows_payer_account_id_payer_accounts_id_fk" FOREIGN KEY ("payer_account_id") REFERENCES "public"."payer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_flows" ADD CONSTRAINT "signup_flows_product_version_id_product_versions_id_fk" FOREIGN KEY ("product_version_id") REFERENCES "public"."product_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_flows" ADD CONSTRAINT "signup_flows_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_agreements_m_idx" ON "membership_agreements" USING btree ("membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_agreements_req_uq" ON "membership_agreements" USING btree ("form_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pm_setups_idem_uq" ON "payment_method_setups" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pm_setups_session_uq" ON "payment_method_setups" USING btree ("provider","provider_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pm_setups_intent_uq" ON "payment_method_setups" USING btree ("provider","provider_setup_intent_id");--> statement-breakpoint
CREATE INDEX "signup_flows_payer_idx" ON "signup_flows" USING btree ("payer_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "signup_flows_open_uq" ON "signup_flows" USING btree ("athlete_id") WHERE "signup_flows"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_provider_uq" ON "payment_methods" USING btree ("provider","provider_method_id");--> statement-breakpoint
CREATE INDEX "payment_methods_payer_idx" ON "payment_methods" USING btree ("payer_account_id","status");--> statement-breakpoint
-- Hand-written: a membership agreement's rendered text (and its merge values) is frozen once issued.
CREATE OR REPLACE FUNCTION form_request_rendered_body_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.rendered_body_markdown IS NOT NULL AND (
    NEW.rendered_body_markdown IS DISTINCT FROM OLD.rendered_body_markdown
    OR NEW.merge_values IS DISTINCT FROM OLD.merge_values
    OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
  ) THEN
    RAISE EXCEPTION 'The agreement text of form request % is frozen and cannot be changed', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER form_request_rendered_body_frozen BEFORE UPDATE ON form_requests
  FOR EACH ROW EXECUTE FUNCTION form_request_rendered_body_guard();
