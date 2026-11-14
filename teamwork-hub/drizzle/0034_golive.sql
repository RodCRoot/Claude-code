CREATE TABLE "event_waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"payer_account_id" uuid NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"position" integer NOT NULL,
	"offered_at" timestamp with time zone,
	"offer_expires_at" timestamp with time zone,
	"registration_id" uuid,
	"added_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	"closed_reason" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "go_live_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"attested_by_user_id" uuid NOT NULL,
	"attested_by_name" text NOT NULL,
	"attested_on" date NOT NULL,
	"note" text,
	"value_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "waitlist_offer_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_waitlist_entries" ADD CONSTRAINT "event_waitlist_entries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_waitlist_entries" ADD CONSTRAINT "event_waitlist_entries_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_waitlist_entries" ADD CONSTRAINT "event_waitlist_entries_payer_account_id_payer_accounts_id_fk" FOREIGN KEY ("payer_account_id") REFERENCES "public"."payer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_waitlist_entries" ADD CONSTRAINT "event_waitlist_entries_registration_id_event_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."event_registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_waitlist_entries" ADD CONSTRAINT "event_waitlist_entries_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_waitlist_entries" ADD CONSTRAINT "event_waitlist_entries_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "go_live_attestations" ADD CONSTRAINT "go_live_attestations_attested_by_user_id_users_id_fk" FOREIGN KEY ("attested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "go_live_attestations" ADD CONSTRAINT "go_live_attestations_withdrawn_by_user_id_users_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_waitlist_live_uq" ON "event_waitlist_entries" USING btree ("event_id","athlete_id") WHERE "event_waitlist_entries"."status" in ('waiting','offered');--> statement-breakpoint
CREATE INDEX "event_waitlist_event_idx" ON "event_waitlist_entries" USING btree ("event_id","status","position");--> statement-breakpoint
CREATE INDEX "event_waitlist_offer_idx" ON "event_waitlist_entries" USING btree ("org_id","status","offer_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "go_live_attestations_live_uq" ON "go_live_attestations" USING btree ("org_id","key") WHERE "go_live_attestations"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "go_live_attestations_org_idx" ON "go_live_attestations" USING btree ("org_id","key");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_waitlist_offer_ck" CHECK ("events"."waitlist_offer_hours" between 1 and 720);