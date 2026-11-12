CREATE TABLE "checkin_kiosk_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"booking_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"question_set_version" text NOT NULL,
	"readiness" integer,
	"sleep_quality" integer,
	"sleep_hours" double precision,
	"fatigue" integer,
	"mood" integer,
	"stress" integer,
	"prior_soreness" integer,
	"prior_booking_id" uuid,
	"prefilled" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"soreness" integer,
	"hurt" boolean,
	"hurt_started_in_session" boolean,
	"note" text,
	"rpe" integer,
	"duration_minutes" integer,
	"liked_chips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"liked_text" text,
	"disliked_chips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disliked_text" text,
	"nothing_to_change" boolean,
	"tell_coach" boolean DEFAULT false NOT NULL,
	"answered_by" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"logged_by_parent" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'app' NOT NULL,
	"activity_session_id" uuid,
	"alert_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_task_id" uuid,
	"experience_task_id" uuid,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_checkins_phase_ck" CHECK ("session_checkins"."phase" in ('pre','post')),
	CONSTRAINT "session_checkins_ranges_ck" CHECK (
      ("session_checkins"."readiness" is null or "session_checkins"."readiness" between 1 and 5)
      and ("session_checkins"."sleep_quality" is null or "session_checkins"."sleep_quality" between 1 and 5)
      and ("session_checkins"."fatigue" is null or "session_checkins"."fatigue" between 1 and 5)
      and ("session_checkins"."mood" is null or "session_checkins"."mood" between 1 and 5)
      and ("session_checkins"."stress" is null or "session_checkins"."stress" between 1 and 5)
      and ("session_checkins"."soreness" is null or "session_checkins"."soreness" between 0 and 10)
      and ("session_checkins"."prior_soreness" is null or "session_checkins"."prior_soreness" between 0 and 10)
      and ("session_checkins"."rpe" is null or "session_checkins"."rpe" between 0 and 10))
);
--> statement-breakpoint
ALTER TABLE "schedule_sessions" ADD COLUMN "intended_rpe" integer;--> statement-breakpoint
ALTER TABLE "body_region_reports" ADD COLUMN "source_checkin_id" uuid;--> statement-breakpoint
ALTER TABLE "checkin_kiosk_passes" ADD CONSTRAINT "checkin_kiosk_passes_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkin_kiosk_passes" ADD CONSTRAINT "checkin_kiosk_passes_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_checkins" ADD CONSTRAINT "session_checkins_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_checkins" ADD CONSTRAINT "session_checkins_session_id_schedule_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."schedule_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_checkins" ADD CONSTRAINT "session_checkins_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_checkins" ADD CONSTRAINT "session_checkins_prior_booking_id_bookings_id_fk" FOREIGN KEY ("prior_booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_checkins" ADD CONSTRAINT "session_checkins_review_task_id_tasks_id_fk" FOREIGN KEY ("review_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_checkins" ADD CONSTRAINT "session_checkins_experience_task_id_tasks_id_fk" FOREIGN KEY ("experience_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_checkins" ADD CONSTRAINT "session_checkins_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkin_kiosk_passes_token_uq" ON "checkin_kiosk_passes" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "checkin_kiosk_passes_expiry_idx" ON "checkin_kiosk_passes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_checkins_booking_phase_uq" ON "session_checkins" USING btree ("booking_id","phase");--> statement-breakpoint
CREATE INDEX "session_checkins_session_idx" ON "session_checkins" USING btree ("session_id","phase");--> statement-breakpoint
CREATE INDEX "session_checkins_athlete_idx" ON "session_checkins" USING btree ("athlete_id","created_at");--> statement-breakpoint
CREATE INDEX "session_checkins_org_time_idx" ON "session_checkins" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "body_reports_checkin_idx" ON "body_region_reports" USING btree ("source_checkin_id");