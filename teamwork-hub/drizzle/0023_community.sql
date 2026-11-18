CREATE TABLE "community_challenge_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"challenge_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"value" integer NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"mode" text NOT NULL,
	"metric" text NOT NULL,
	"target" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"group_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_display_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"set_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_display_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_shoutouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"template" text NOT NULL,
	"note" text,
	"local_date" date NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community_challenge_completions" ADD CONSTRAINT "community_challenge_completions_challenge_id_community_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."community_challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_challenge_completions" ADD CONSTRAINT "community_challenge_completions_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_challenges" ADD CONSTRAINT "community_challenges_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_challenges" ADD CONSTRAINT "community_challenges_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_display_prefs" ADD CONSTRAINT "community_display_prefs_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_display_prefs" ADD CONSTRAINT "community_display_prefs_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_display_tokens" ADD CONSTRAINT "community_display_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_display_tokens" ADD CONSTRAINT "community_display_tokens_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_shoutouts" ADD CONSTRAINT "community_shoutouts_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_shoutouts" ADD CONSTRAINT "community_shoutouts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_shoutouts" ADD CONSTRAINT "community_shoutouts_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_challenge_completions_uq" ON "community_challenge_completions" USING btree ("challenge_id","athlete_id");--> statement-breakpoint
CREATE INDEX "community_challenge_completions_athlete_idx" ON "community_challenge_completions" USING btree ("org_id","athlete_id");--> statement-breakpoint
CREATE INDEX "community_challenges_org_idx" ON "community_challenges" USING btree ("org_id","status","ends_on");--> statement-breakpoint
CREATE UNIQUE INDEX "community_display_prefs_athlete_uq" ON "community_display_prefs" USING btree ("athlete_id");--> statement-breakpoint
CREATE INDEX "community_display_prefs_org_idx" ON "community_display_prefs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "community_display_tokens_hash_uq" ON "community_display_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "community_display_tokens_org_idx" ON "community_display_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "community_shoutouts_athlete_idx" ON "community_shoutouts" USING btree ("org_id","athlete_id","created_at");--> statement-breakpoint
CREATE INDEX "community_shoutouts_author_day_idx" ON "community_shoutouts" USING btree ("org_id","author_user_id","local_date");
--> statement-breakpoint
-- ===== Hand-written community constraints (re-append after regenerating this file) =====
ALTER TABLE "xp_events" DROP CONSTRAINT "xp_events_kind_ck";--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_kind_ck" CHECK ("kind" IN ('session_attended','workout_completed','wellness_checkin','pr_set','goal_achieved','form_signed','on_your_own_completed','coach_shoutout'));--> statement-breakpoint
ALTER TABLE "community_display_prefs" ADD CONSTRAINT "community_display_prefs_mode_ck" CHECK ("mode" IN ('first_last_initial','first_name_only','hidden'));--> statement-breakpoint
ALTER TABLE "community_shoutouts" ADD CONSTRAINT "community_shoutouts_template_ck" CHECK ("template" IN ('great_effort','leader_today','new_pr','consistency'));--> statement-breakpoint
ALTER TABLE "community_shoutouts" ADD CONSTRAINT "community_shoutouts_note_ck" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 140);--> statement-breakpoint
ALTER TABLE "community_challenges" ADD CONSTRAINT "community_challenges_mode_ck" CHECK ("mode" IN ('individual','group_total'));--> statement-breakpoint
ALTER TABLE "community_challenges" ADD CONSTRAINT "community_challenges_metric_ck" CHECK ("metric" IN ('attendance','workouts','streak_weeks'));--> statement-breakpoint
ALTER TABLE "community_challenges" ADD CONSTRAINT "community_challenges_status_ck" CHECK ("status" IN ('active','archived'));--> statement-breakpoint
ALTER TABLE "community_challenges" ADD CONSTRAINT "community_challenges_dates_ck" CHECK ("ends_on" >= "starts_on");--> statement-breakpoint
ALTER TABLE "community_challenges" ADD CONSTRAINT "community_challenges_target_ck" CHECK ("target" BETWEEN 1 AND 100000);