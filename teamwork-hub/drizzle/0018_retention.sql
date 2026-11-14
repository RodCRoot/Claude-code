CREATE TABLE "retention_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"level" text NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"value_at_risk_minor" bigint,
	"currency" text DEFAULT 'USD' NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"reason_code" text,
	"notes" text,
	"staff_user_id" uuid NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"tell_coach" boolean DEFAULT false NOT NULL,
	"submitted_by_user_id" uuid NOT NULL,
	"submitted_by_role" text NOT NULL,
	"follow_up_task_id" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retention_actions" ADD CONSTRAINT "retention_actions_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_actions" ADD CONSTRAINT "retention_actions_staff_user_id_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_feedback" ADD CONSTRAINT "session_feedback_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_feedback" ADD CONSTRAINT "session_feedback_session_id_schedule_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."schedule_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_feedback" ADD CONSTRAINT "session_feedback_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_feedback" ADD CONSTRAINT "session_feedback_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_feedback" ADD CONSTRAINT "session_feedback_follow_up_task_id_tasks_id_fk" FOREIGN KEY ("follow_up_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retention_actions_org_time_idx" ON "retention_actions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "retention_actions_athlete_idx" ON "retention_actions" USING btree ("athlete_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_feedback_booking_uq" ON "session_feedback" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "session_feedback_session_idx" ON "session_feedback" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_feedback_org_time_idx" ON "session_feedback" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "session_feedback_athlete_idx" ON "session_feedback" USING btree ("athlete_id");--> statement-breakpoint
ALTER TABLE "session_feedback" ADD CONSTRAINT "session_feedback_rating_ck" CHECK ("rating" BETWEEN 1 AND 5);--> statement-breakpoint
ALTER TABLE "session_feedback" ADD CONSTRAINT "session_feedback_role_ck" CHECK ("submitted_by_role" IN ('athlete','guardian'));--> statement-breakpoint
ALTER TABLE "retention_actions" ADD CONSTRAINT "retention_actions_outcome_ck" CHECK ("outcome" IN ('saved','still_at_risk','lost'));--> statement-breakpoint
ALTER TABLE "retention_actions" ADD CONSTRAINT "retention_actions_level_ck" CHECK ("level" IN ('low','watch','at_risk'));--> statement-breakpoint
ALTER TABLE "retention_actions" ADD CONSTRAINT "retention_actions_lost_reason_ck" CHECK ("outcome" <> 'lost' OR "reason_code" IS NOT NULL);
