CREATE TABLE "coach_reflections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"coach_user_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"went_well" text,
	"stuck" text,
	"help_needed" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey_steps" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"step_key" text NOT NULL,
	"name" text NOT NULL,
	"owner_role" text NOT NULL,
	"auto_rule" text,
	"billing" boolean DEFAULT false NOT NULL,
	"due_on" date NOT NULL,
	"original_due_on" date,
	"snoozed_until" date,
	"skip_reason" text,
	"completed_via" text,
	"outcome" text,
	"note" text,
	"suppressed" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"anchor_key" text NOT NULL,
	"anchor_id" uuid,
	"started_on" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"completed_at" timestamp with time zone,
	"closed_reason" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid,
	"section" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_checklist_items_section_ck" CHECK ("ops_checklist_items"."section" in ('opening','closing','cleaning','weekly'))
);
--> statement-breakpoint
CREATE TABLE "ops_checklist_ticks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"ticked_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coach_reflections" ADD CONSTRAINT "coach_reflections_coach_user_id_users_id_fk" FOREIGN KEY ("coach_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_steps" ADD CONSTRAINT "journey_steps_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_steps" ADD CONSTRAINT "journey_steps_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_steps" ADD CONSTRAINT "journey_steps_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_checklist_items" ADD CONSTRAINT "ops_checklist_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_checklist_ticks" ADD CONSTRAINT "ops_checklist_ticks_item_id_ops_checklist_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."ops_checklist_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_checklist_ticks" ADD CONSTRAINT "ops_checklist_ticks_ticked_by_users_id_fk" FOREIGN KEY ("ticked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coach_reflections_uq" ON "coach_reflections" USING btree ("org_id","coach_user_id","week_start");--> statement-breakpoint
CREATE UNIQUE INDEX "journey_steps_key_uq" ON "journey_steps" USING btree ("journey_id","step_key");--> statement-breakpoint
CREATE INDEX "journey_steps_athlete_idx" ON "journey_steps" USING btree ("athlete_id");--> statement-breakpoint
CREATE INDEX "journey_steps_org_due_idx" ON "journey_steps" USING btree ("org_id","due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "journeys_anchor_uq" ON "journeys" USING btree ("org_id","anchor_key");--> statement-breakpoint
CREATE INDEX "journeys_athlete_idx" ON "journeys" USING btree ("athlete_id");--> statement-breakpoint
CREATE INDEX "journeys_org_kind_idx" ON "journeys" USING btree ("org_id","kind","status");--> statement-breakpoint
CREATE INDEX "ops_checklist_items_org_idx" ON "ops_checklist_items" USING btree ("org_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_checklist_ticks_uq" ON "ops_checklist_ticks" USING btree ("item_id","local_date");--> statement-breakpoint
CREATE INDEX "ops_checklist_ticks_org_date_idx" ON "ops_checklist_ticks" USING btree ("org_id","local_date");