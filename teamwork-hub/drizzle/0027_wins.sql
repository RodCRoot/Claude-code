CREATE TABLE "competition_team_athletes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competition_team_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"kind" text DEFAULT 'game' NOT NULL,
	"event_date" date NOT NULL,
	"start_time_local" text,
	"opponent" text,
	"location" text,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competition_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sport" text NOT NULL,
	"kind" text DEFAULT 'school' NOT NULL,
	"season_label" text,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "win_consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"win_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_person_id" uuid,
	"relationship" text NOT NULL,
	"policy_version" text NOT NULL,
	"policy_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "win_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"note" text NOT NULL,
	"source_url" text,
	"athlete_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"win_id" uuid,
	"created_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "win_marketing_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"win_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"posted_on" date NOT NULL,
	"marked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"occurred_on" date NOT NULL,
	"sport" text NOT NULL,
	"type" text NOT NULL,
	"headline" text NOT NULL,
	"detail" text,
	"source_url" text,
	"photo_object_id" uuid,
	"photo_approved_at" timestamp with time zone,
	"photo_approved_by" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"show_in_app" boolean DEFAULT true NOT NULL,
	"show_on_tv" boolean DEFAULT true NOT NULL,
	"marketing_consent" text DEFAULT 'none' NOT NULL,
	"marketing_consent_at" timestamp with time zone,
	"marketing_consent_by" uuid,
	"consent_requested_at" timestamp with time zone,
	"consent_requested_by" uuid,
	"submitted_by" uuid,
	"submitted_as" text NOT NULL,
	"family_confirmed_at" timestamp with time zone,
	"family_confirmed_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"removed_reason" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competition_team_athletes" ADD CONSTRAINT "competition_team_athletes_team_id_competition_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."competition_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_team_athletes" ADD CONSTRAINT "competition_team_athletes_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_team_athletes" ADD CONSTRAINT "competition_team_athletes_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_team_events" ADD CONSTRAINT "competition_team_events_team_id_competition_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."competition_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_team_events" ADD CONSTRAINT "competition_team_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_teams" ADD CONSTRAINT "competition_teams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_consent_events" ADD CONSTRAINT "win_consent_events_win_id_wins_id_fk" FOREIGN KEY ("win_id") REFERENCES "public"."wins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_consent_events" ADD CONSTRAINT "win_consent_events_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_consent_events" ADD CONSTRAINT "win_consent_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_consent_events" ADD CONSTRAINT "win_consent_events_actor_person_id_people_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_win_id_wins_id_fk" FOREIGN KEY ("win_id") REFERENCES "public"."wins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_marketing_posts" ADD CONSTRAINT "win_marketing_posts_win_id_wins_id_fk" FOREIGN KEY ("win_id") REFERENCES "public"."wins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_marketing_posts" ADD CONSTRAINT "win_marketing_posts_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_photo_object_id_stored_objects_id_fk" FOREIGN KEY ("photo_object_id") REFERENCES "public"."stored_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_photo_approved_by_users_id_fk" FOREIGN KEY ("photo_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_marketing_consent_by_users_id_fk" FOREIGN KEY ("marketing_consent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_consent_requested_by_users_id_fk" FOREIGN KEY ("consent_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_family_confirmed_by_users_id_fk" FOREIGN KEY ("family_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competition_team_athletes_uq" ON "competition_team_athletes" USING btree ("team_id","athlete_id");--> statement-breakpoint
CREATE INDEX "competition_team_athletes_athlete_idx" ON "competition_team_athletes" USING btree ("org_id","athlete_id");--> statement-breakpoint
CREATE INDEX "competition_team_events_idx" ON "competition_team_events" USING btree ("org_id","event_date");--> statement-breakpoint
CREATE INDEX "competition_team_events_team_idx" ON "competition_team_events" USING btree ("team_id","event_date");--> statement-breakpoint
CREATE INDEX "competition_teams_org_idx" ON "competition_teams" USING btree ("org_id","archived_at");--> statement-breakpoint
CREATE INDEX "win_consent_events_win_idx" ON "win_consent_events" USING btree ("win_id","created_at");--> statement-breakpoint
CREATE INDEX "win_leads_org_idx" ON "win_leads" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "win_marketing_posts_uq" ON "win_marketing_posts" USING btree ("win_id","channel","posted_on");--> statement-breakpoint
CREATE INDEX "win_marketing_posts_org_idx" ON "win_marketing_posts" USING btree ("org_id","win_id");--> statement-breakpoint
CREATE INDEX "wins_athlete_idx" ON "wins" USING btree ("org_id","athlete_id","occurred_on");--> statement-breakpoint
CREATE INDEX "wins_status_idx" ON "wins" USING btree ("org_id","status","occurred_on");
--> statement-breakpoint
-- ===== Hand-written wins constraints (re-append after regenerating this file) =====
ALTER TABLE "xp_events" DROP CONSTRAINT "xp_events_kind_ck";--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_kind_ck" CHECK ("kind" IN ('session_attended','workout_completed','wellness_checkin','pr_set','goal_achieved','form_signed','on_your_own_completed','coach_shoutout','win_approved'));--> statement-breakpoint
ALTER TABLE "competition_teams" ADD CONSTRAINT "competition_teams_kind_ck" CHECK ("kind" IN ('school','club','other'));--> statement-breakpoint
ALTER TABLE "competition_team_events" ADD CONSTRAINT "competition_team_events_kind_ck" CHECK ("kind" IN ('game','meet','tournament'));--> statement-breakpoint
ALTER TABLE "competition_team_events" ADD CONSTRAINT "competition_team_events_time_ck" CHECK ("start_time_local" IS NULL OR "start_time_local" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_type_ck" CHECK ("type" IN ('personal_best','placing','selection','commitment','team_championship','character','other'));--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_status_ck" CHECK ("status" IN ('awaiting_family','pending','approved','declined','removed'));--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_marketing_consent_ck" CHECK ("marketing_consent" IN ('none','granted','declined','revoked'));--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_submitted_as_ck" CHECK ("submitted_as" IN ('athlete','guardian','staff'));--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_headline_ck" CHECK (char_length("headline") BETWEEN 3 AND 120);--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_detail_ck" CHECK ("detail" IS NULL OR char_length("detail") <= 500);--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_source_url_ck" CHECK ("source_url" IS NULL OR "source_url" ~ '^https://');--> statement-breakpoint
-- An approved win always records who approved it and when; marketing consent always records who and when.
ALTER TABLE "wins" ADD CONSTRAINT "wins_approved_ck" CHECK ("status" <> 'approved' OR ("approved_at" IS NOT NULL AND "approved_by" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_consent_who_ck" CHECK ("marketing_consent" = 'none' OR ("marketing_consent_at" IS NOT NULL AND "marketing_consent_by" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "win_consent_events" ADD CONSTRAINT "win_consent_events_action_ck" CHECK ("action" IN ('requested','granted','declined','revoked'));--> statement-breakpoint
ALTER TABLE "win_consent_events" ADD CONSTRAINT "win_consent_events_relationship_ck" CHECK ("relationship" IN ('guardian','self','staff'));--> statement-breakpoint
-- Staff may only ever record that they asked; a grant, decline or revoke is the family's own act.
ALTER TABLE "win_consent_events" ADD CONSTRAINT "win_consent_events_staff_ck" CHECK (("relationship" = 'staff') = ("action" = 'requested'));--> statement-breakpoint
ALTER TABLE "win_marketing_posts" ADD CONSTRAINT "win_marketing_posts_channel_ck" CHECK ("channel" IN ('instagram','facebook','website','newsletter','other'));--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_status_ck" CHECK ("status" IN ('open','converted','dismissed'));--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_source_url_ck" CHECK ("source_url" IS NULL OR "source_url" ~ '^https://');--> statement-breakpoint
CREATE OR REPLACE FUNCTION win_consent_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'win_consent_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER win_consent_events_no_update BEFORE UPDATE OR DELETE ON "win_consent_events"
  FOR EACH ROW EXECUTE FUNCTION win_consent_events_immutable();
