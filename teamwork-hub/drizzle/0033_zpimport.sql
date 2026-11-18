CREATE TABLE "zp_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"athlete_id" uuid,
	"membership_id" uuid,
	"import_batch_id" uuid,
	"source_record_id" text NOT NULL,
	"description" text,
	"due_date" date NOT NULL,
	"amount_due_minor" bigint,
	"amount_paid_minor" bigint,
	"amount_unpaid_minor" bigint,
	"discount_total_minor" bigint,
	"paid_on_time" boolean,
	"zp_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zp_membership_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"import_batch_id" uuid,
	"plan_name" text NOT NULL,
	"family_id" text,
	"payment_amount_minor" bigint,
	"months" integer,
	"auto_renew" boolean,
	"renewal_type" text,
	"trial_member" boolean,
	"cancel_date" date,
	"cancel_by" text,
	"cancel_reason" text,
	"cancel_comments" text,
	"first_bill_due" date,
	"income_category" text,
	"membership_category" text,
	"att_limit" integer,
	"att_limit_type" text,
	"class_card_remaining" integer,
	"shared" boolean,
	"autopay" boolean,
	"discount_name" text,
	"discount_minor" bigint,
	"hold_reason" text,
	"hold_start" date,
	"hold_end" date,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zp_person_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"import_batch_id" uuid,
	"family_id" text,
	"zp_status" text,
	"primary_location" text,
	"primary_instructor" text,
	"signup_date" date,
	"has_password" boolean,
	"signed_documents" text,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zp_person_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"import_batch_id" uuid,
	"special_needs" text,
	"medications" text,
	"allergies" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zp_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"import_batch_id" uuid,
	"as_of" date NOT NULL,
	"entered" jsonb NOT NULL,
	"hub" jsonb NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zp_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"feed" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"import_batch_id" uuid,
	"records" integer DEFAULT 0 NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "zp_bills" ADD CONSTRAINT "zp_bills_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zp_bills" ADD CONSTRAINT "zp_bills_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zp_bills" ADD CONSTRAINT "zp_bills_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zp_membership_details" ADD CONSTRAINT "zp_membership_details_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zp_person_details" ADD CONSTRAINT "zp_person_details_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zp_person_health" ADD CONSTRAINT "zp_person_health_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "zp_bills_source_uq" ON "zp_bills" USING btree ("org_id","source_record_id");--> statement-breakpoint
CREATE INDEX "zp_bills_person_idx" ON "zp_bills" USING btree ("person_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "zp_membership_details_membership_uq" ON "zp_membership_details" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "zp_membership_details_org_idx" ON "zp_membership_details" USING btree ("org_id","import_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "zp_person_details_person_uq" ON "zp_person_details" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "zp_person_details_family_idx" ON "zp_person_details" USING btree ("org_id","family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "zp_person_health_person_uq" ON "zp_person_health" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "zp_reconciliations_org_idx" ON "zp_reconciliations" USING btree ("org_id","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "zp_webhook_events_dedupe_uq" ON "zp_webhook_events" USING btree ("org_id","feed","dedupe_key");--> statement-breakpoint
CREATE INDEX "zp_webhook_events_recent_idx" ON "zp_webhook_events" USING btree ("org_id","feed","received_at");