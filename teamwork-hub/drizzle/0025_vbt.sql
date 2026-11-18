CREATE TABLE "vbt_max_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"method" text NOT NULL,
	"e1rm_kg" numeric(8, 2) NOT NULL,
	"readings_used" integer NOT NULL,
	"dismissed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vbt_max_dismissals" ADD CONSTRAINT "vbt_max_dismissals_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vbt_max_dismissals" ADD CONSTRAINT "vbt_max_dismissals_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vbt_max_dismissals_idx" ON "vbt_max_dismissals" USING btree ("org_id","athlete_id","exercise_id","created_at");