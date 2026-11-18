CREATE TABLE "athlete_checkin_pins" (
	"athlete_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"pin_hash" text NOT NULL,
	"set_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kiosk_pin_attempts" (
	"org_id" uuid NOT NULL,
	"session_key" text NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiosk_pin_attempts_org_id_session_key_pk" PRIMARY KEY("org_id","session_key")
);
--> statement-breakpoint
ALTER TABLE "athlete_checkin_pins" ADD CONSTRAINT "athlete_checkin_pins_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_checkin_pins" ADD CONSTRAINT "athlete_checkin_pins_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkin_pin_org_hash_uq" ON "athlete_checkin_pins" USING btree ("org_id","pin_hash");