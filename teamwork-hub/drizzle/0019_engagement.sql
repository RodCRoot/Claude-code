CREATE TABLE "athlete_badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"badge_key" text NOT NULL,
	"earned_at" timestamp with time zone NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"title" text NOT NULL,
	"metric_definition_id" uuid,
	"exercise_id" uuid,
	"target_value" double precision,
	"target_unit" text,
	"direction" text,
	"baseline_value" double precision,
	"baseline_context" jsonb,
	"max_basis" text,
	"target_date" date,
	"status" text DEFAULT 'active' NOT NULL,
	"achieved_at" timestamp with time zone,
	"achieved_value" double precision,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "xp_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"points" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "athlete_badges" ADD CONSTRAINT "athlete_badges_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_goals" ADD CONSTRAINT "athlete_goals_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_goals" ADD CONSTRAINT "athlete_goals_metric_definition_id_metric_definitions_id_fk" FOREIGN KEY ("metric_definition_id") REFERENCES "public"."metric_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_goals" ADD CONSTRAINT "athlete_goals_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_goals" ADD CONSTRAINT "athlete_goals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_badges_uq" ON "athlete_badges" USING btree ("athlete_id","badge_key");--> statement-breakpoint
CREATE INDEX "athlete_badges_org_idx" ON "athlete_badges" USING btree ("org_id","athlete_id");--> statement-breakpoint
CREATE INDEX "athlete_goals_athlete_idx" ON "athlete_goals" USING btree ("org_id","athlete_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "xp_events_idem_uq" ON "xp_events" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "xp_events_athlete_idx" ON "xp_events" USING btree ("athlete_id","occurred_at");
--> statement-breakpoint
-- ===== Hand-written engagement constraints (re-append after regenerating this file) =====
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_kind_ck" CHECK ("kind" IN ('session_attended','workout_completed','wellness_checkin','pr_set','goal_achieved','form_signed'));--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_points_ck" CHECK ("points" >= 0 AND "points" <= 10000);--> statement-breakpoint
ALTER TABLE "athlete_goals" ADD CONSTRAINT "athlete_goals_status_ck" CHECK ("status" IN ('active','achieved','archived'));--> statement-breakpoint
ALTER TABLE "athlete_goals" ADD CONSTRAINT "athlete_goals_direction_ck" CHECK ("direction" IS NULL OR "direction" IN ('increase','decrease'));--> statement-breakpoint
ALTER TABLE "athlete_goals" ADD CONSTRAINT "athlete_goals_one_link_ck" CHECK ("metric_definition_id" IS NULL OR "exercise_id" IS NULL);--> statement-breakpoint
ALTER TABLE "athlete_goals" ADD CONSTRAINT "athlete_goals_target_ck" CHECK (("metric_definition_id" IS NULL AND "exercise_id" IS NULL) OR ("target_value" IS NOT NULL AND "target_unit" IS NOT NULL AND "direction" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "athlete_goals" ADD CONSTRAINT "athlete_goals_max_basis_ck" CHECK ("max_basis" IS NULL OR "max_basis" IN ('measured','estimated'));--> statement-breakpoint
-- The XP ledger is append-only, like audit_events.
CREATE OR REPLACE FUNCTION xp_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'xp_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER xp_events_no_update BEFORE UPDATE OR DELETE ON "xp_events"
  FOR EACH ROW EXECUTE FUNCTION xp_events_immutable();