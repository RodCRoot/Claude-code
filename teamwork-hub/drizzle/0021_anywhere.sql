CREATE TABLE "anywhere_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid,
	"category" text,
	"athlete_id" uuid,
	"group_id" uuid,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"target_count" integer DEFAULT 1 NOT NULL,
	"note" text,
	"assigned_by" uuid,
	"cancelled_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anywhere_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"session_title" text NOT NULL,
	"category" text NOT NULL,
	"client_key" text NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"steps_done" integer NOT NULL,
	"steps_total" integer NOT NULL,
	"duration_minutes" integer,
	"rpe" integer,
	"activity_session_id" uuid,
	"logged_by" uuid,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anywhere_ics_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"uploaded_by" uuid,
	"file_name" text NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"events" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anywhere_season_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"opponent" text,
	"location" text,
	"weekdays" jsonb,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"start_time_local" text,
	"duration_minutes" integer,
	"timezone" text NOT NULL,
	"skip_dates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ics_uid" text,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anywhere_seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"team_name" text NOT NULL,
	"sport" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anywhere_session_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"exercise_id" uuid NOT NULL,
	"prescription" text NOT NULL,
	"cue" text
);
--> statement-breakpoint
CREATE TABLE "anywhere_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"equipment" jsonb DEFAULT '["none"]'::jsonb NOT NULL,
	"suitable_under_13" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_sample" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anywhere_sport_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"event_id" uuid,
	"occurrence_date" date NOT NULL,
	"kind" text NOT NULL,
	"client_key" text NOT NULL,
	"activity_session_id" uuid NOT NULL,
	"logged_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anywhere_assignments" ADD CONSTRAINT "anywhere_assignments_session_id_anywhere_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."anywhere_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_assignments" ADD CONSTRAINT "anywhere_assignments_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_assignments" ADD CONSTRAINT "anywhere_assignments_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_assignments" ADD CONSTRAINT "anywhere_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_completions" ADD CONSTRAINT "anywhere_completions_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_completions" ADD CONSTRAINT "anywhere_completions_session_id_anywhere_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."anywhere_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_completions" ADD CONSTRAINT "anywhere_completions_activity_session_id_activity_sessions_id_fk" FOREIGN KEY ("activity_session_id") REFERENCES "public"."activity_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_completions" ADD CONSTRAINT "anywhere_completions_logged_by_users_id_fk" FOREIGN KEY ("logged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_completions" ADD CONSTRAINT "anywhere_completions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_ics_imports" ADD CONSTRAINT "anywhere_ics_imports_season_id_anywhere_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."anywhere_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_ics_imports" ADD CONSTRAINT "anywhere_ics_imports_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_season_events" ADD CONSTRAINT "anywhere_season_events_season_id_anywhere_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."anywhere_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_season_events" ADD CONSTRAINT "anywhere_season_events_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_season_events" ADD CONSTRAINT "anywhere_season_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_seasons" ADD CONSTRAINT "anywhere_seasons_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_seasons" ADD CONSTRAINT "anywhere_seasons_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_session_steps" ADD CONSTRAINT "anywhere_session_steps_session_id_anywhere_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."anywhere_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_session_steps" ADD CONSTRAINT "anywhere_session_steps_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_sessions" ADD CONSTRAINT "anywhere_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_sport_logs" ADD CONSTRAINT "anywhere_sport_logs_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_sport_logs" ADD CONSTRAINT "anywhere_sport_logs_event_id_anywhere_season_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."anywhere_season_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_sport_logs" ADD CONSTRAINT "anywhere_sport_logs_activity_session_id_activity_sessions_id_fk" FOREIGN KEY ("activity_session_id") REFERENCES "public"."activity_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anywhere_sport_logs" ADD CONSTRAINT "anywhere_sport_logs_logged_by_users_id_fk" FOREIGN KEY ("logged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anywhere_assign_athlete_idx" ON "anywhere_assignments" USING btree ("org_id","athlete_id","end_date");--> statement-breakpoint
CREATE INDEX "anywhere_assign_group_idx" ON "anywhere_assignments" USING btree ("org_id","group_id","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "anywhere_completions_key_uq" ON "anywhere_completions" USING btree ("org_id","client_key");--> statement-breakpoint
CREATE INDEX "anywhere_completions_athlete_idx" ON "anywhere_completions" USING btree ("org_id","athlete_id","local_date");--> statement-breakpoint
CREATE INDEX "anywhere_ics_season_idx" ON "anywhere_ics_imports" USING btree ("season_id","status");--> statement-breakpoint
CREATE INDEX "anywhere_events_athlete_idx" ON "anywhere_season_events" USING btree ("org_id","athlete_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "anywhere_events_uid_uq" ON "anywhere_season_events" USING btree ("season_id","ics_uid");--> statement-breakpoint
CREATE INDEX "anywhere_seasons_athlete_idx" ON "anywhere_seasons" USING btree ("org_id","athlete_id","ends_on");--> statement-breakpoint
CREATE INDEX "anywhere_steps_session_idx" ON "anywhere_session_steps" USING btree ("session_id","sort_order");--> statement-breakpoint
CREATE INDEX "anywhere_sessions_org_idx" ON "anywhere_sessions" USING btree ("org_id","status","category");--> statement-breakpoint
CREATE UNIQUE INDEX "anywhere_sport_logs_key_uq" ON "anywhere_sport_logs" USING btree ("org_id","client_key");--> statement-breakpoint
CREATE UNIQUE INDEX "anywhere_sport_logs_event_uq" ON "anywhere_sport_logs" USING btree ("event_id","occurrence_date");--> statement-breakpoint
CREATE INDEX "anywhere_sport_logs_athlete_idx" ON "anywhere_sport_logs" USING btree ("org_id","athlete_id","occurrence_date");
--> statement-breakpoint
-- ===== Hand-written anywhere constraints (re-append after regenerating this file) =====
ALTER TABLE "xp_events" DROP CONSTRAINT "xp_events_kind_ck";--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_kind_ck" CHECK ("kind" IN ('session_attended','workout_completed','wellness_checkin','pr_set','goal_achieved','form_signed','on_your_own_completed'));--> statement-breakpoint
ALTER TABLE "anywhere_sessions" ADD CONSTRAINT "anywhere_sessions_category_ck" CHECK ("category" IN ('mobility','recovery','core','speed_agility','bodyweight_strength','travel','pre_game_warmup'));--> statement-breakpoint
ALTER TABLE "anywhere_sessions" ADD CONSTRAINT "anywhere_sessions_status_ck" CHECK ("status" IN ('draft','published','archived'));--> statement-breakpoint
ALTER TABLE "anywhere_sessions" ADD CONSTRAINT "anywhere_sessions_duration_ck" CHECK ("duration_minutes" BETWEEN 1 AND 120);--> statement-breakpoint
ALTER TABLE "anywhere_assignments" ADD CONSTRAINT "anywhere_assign_target_ck" CHECK (("athlete_id" IS NULL) <> ("group_id" IS NULL));--> statement-breakpoint
ALTER TABLE "anywhere_assignments" ADD CONSTRAINT "anywhere_assign_what_ck" CHECK (("session_id" IS NULL) <> ("category" IS NULL));--> statement-breakpoint
ALTER TABLE "anywhere_assignments" ADD CONSTRAINT "anywhere_assign_dates_ck" CHECK ("end_date" >= "start_date" AND "target_count" BETWEEN 1 AND 14);--> statement-breakpoint
ALTER TABLE "anywhere_completions" ADD CONSTRAINT "anywhere_completions_rpe_ck" CHECK ("rpe" IS NULL OR "rpe" BETWEEN 0 AND 10);--> statement-breakpoint
ALTER TABLE "anywhere_completions" ADD CONSTRAINT "anywhere_completions_duration_ck" CHECK ("duration_minutes" IS NULL OR "duration_minutes" BETWEEN 1 AND 240);--> statement-breakpoint
ALTER TABLE "anywhere_completions" ADD CONSTRAINT "anywhere_completions_steps_ck" CHECK ("steps_done" >= 0 AND "steps_done" <= "steps_total");--> statement-breakpoint
ALTER TABLE "anywhere_seasons" ADD CONSTRAINT "anywhere_seasons_dates_ck" CHECK ("ends_on" >= "starts_on");--> statement-breakpoint
ALTER TABLE "anywhere_season_events" ADD CONSTRAINT "anywhere_events_kind_ck" CHECK ("kind" IN ('game','practice','tournament','travel','rest'));--> statement-breakpoint
ALTER TABLE "anywhere_season_events" ADD CONSTRAINT "anywhere_events_dates_ck" CHECK ("ends_on" >= "starts_on");--> statement-breakpoint
ALTER TABLE "anywhere_season_events" ADD CONSTRAINT "anywhere_events_time_ck" CHECK ("start_time_local" IS NULL OR "start_time_local" ~ '^[0-2][0-9]:[0-5][0-9]$');--> statement-breakpoint
ALTER TABLE "anywhere_sport_logs" ADD CONSTRAINT "anywhere_sport_logs_kind_ck" CHECK ("kind" IN ('practice','game'));
