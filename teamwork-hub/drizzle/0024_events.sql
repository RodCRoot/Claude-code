CREATE TABLE "event_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"payer_account_id" uuid NOT NULL,
	"invoice_id" uuid,
	"status" text DEFAULT 'held' NOT NULL,
	"base_price_minor" integer NOT NULL,
	"early_bird" boolean DEFAULT false NOT NULL,
	"sibling_discount_minor" integer DEFAULT 0 NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"registered_by_user_id" uuid,
	"submit_key" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_reg_amount_ck" CHECK ("event_registrations"."amount_minor" >= 0 and "event_registrations"."base_price_minor" >= 0 and "event_registrations"."sibling_discount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "event_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"org_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'camp' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"capacity" integer NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"early_bird_price_minor" integer,
	"early_bird_until" date,
	"sibling_discount_percent" integer,
	"registration_opens_on" date,
	"registration_closes_on" date,
	"min_age" integer,
	"max_age" integer,
	"required_form_template_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hold_hours" integer DEFAULT 48 NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_capacity_ck" CHECK ("events"."capacity" > 0),
	CONSTRAINT "events_price_ck" CHECK ("events"."price_minor" >= 0 and ("events"."early_bird_price_minor" is null or "events"."early_bird_price_minor" >= 0)),
	CONSTRAINT "events_sibling_ck" CHECK ("events"."sibling_discount_percent" is null or ("events"."sibling_discount_percent" between 1 and 100)),
	CONSTRAINT "events_hold_ck" CHECK ("events"."hold_hours" between 1 and 720)
);
--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_payer_account_id_payer_accounts_id_fk" FOREIGN KEY ("payer_account_id") REFERENCES "public"."payer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_registered_by_user_id_users_id_fk" FOREIGN KEY ("registered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_sessions" ADD CONSTRAINT "event_sessions_session_id_schedule_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."schedule_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_sessions" ADD CONSTRAINT "event_sessions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_reg_live_uq" ON "event_registrations" USING btree ("event_id","athlete_id") WHERE "event_registrations"."status" in ('held','confirmed');--> statement-breakpoint
CREATE INDEX "event_reg_event_idx" ON "event_registrations" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "event_reg_invoice_idx" ON "event_registrations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "event_reg_submit_idx" ON "event_registrations" USING btree ("org_id","submit_key");--> statement-breakpoint
CREATE INDEX "event_sessions_event_idx" ON "event_sessions" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "events_org_status_idx" ON "events" USING btree ("org_id","status");