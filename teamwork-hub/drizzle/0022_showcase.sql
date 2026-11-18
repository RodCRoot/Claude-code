CREATE TABLE "monthly_recaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"month" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"calc_key" text NOT NULL,
	"snapshot" jsonb,
	"coach_note" text,
	"coach_note_by" uuid,
	"coach_note_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"finalized_via" text,
	"notice_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "showcase_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"showcase_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_relationship" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_person_id" uuid,
	"fields" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"policy_text" text NOT NULL,
	"expires_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "showcase_view_days" (
	"showcase_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"day" date NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "showcase_view_days_showcase_id_day_pk" PRIMARY KEY("showcase_id","day")
);
--> statement-breakpoint
CREATE TABLE "showcases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config" jsonb NOT NULL,
	"token_hash" text,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monthly_recaps" ADD CONSTRAINT "monthly_recaps_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_recaps" ADD CONSTRAINT "monthly_recaps_coach_note_by_users_id_fk" FOREIGN KEY ("coach_note_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_consents" ADD CONSTRAINT "showcase_consents_showcase_id_showcases_id_fk" FOREIGN KEY ("showcase_id") REFERENCES "public"."showcases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_consents" ADD CONSTRAINT "showcase_consents_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_consents" ADD CONSTRAINT "showcase_consents_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_consents" ADD CONSTRAINT "showcase_consents_actor_person_id_people_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_view_days" ADD CONSTRAINT "showcase_view_days_showcase_id_showcases_id_fk" FOREIGN KEY ("showcase_id") REFERENCES "public"."showcases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcases" ADD CONSTRAINT "showcases_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcases" ADD CONSTRAINT "showcases_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcases" ADD CONSTRAINT "showcases_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcases" ADD CONSTRAINT "showcases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcases" ADD CONSTRAINT "showcases_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_recaps_uq" ON "monthly_recaps" USING btree ("org_id","athlete_id","month");--> statement-breakpoint
CREATE INDEX "monthly_recaps_month_idx" ON "monthly_recaps" USING btree ("org_id","month","status");--> statement-breakpoint
CREATE INDEX "showcase_consents_showcase_idx" ON "showcase_consents" USING btree ("showcase_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "showcases_athlete_uq" ON "showcases" USING btree ("athlete_id");--> statement-breakpoint
CREATE UNIQUE INDEX "showcases_token_uq" ON "showcases" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "showcases_org_idx" ON "showcases" USING btree ("org_id","status");
--> statement-breakpoint
-- ===== Hand-written showcase constraints (re-append after regenerating this file) =====
ALTER TABLE "showcases" ADD CONSTRAINT "showcases_status_ck" CHECK ("status" IN ('draft','published'));--> statement-breakpoint
ALTER TABLE "showcases" ADD CONSTRAINT "showcases_published_ck" CHECK ("status" <> 'published' OR ("token_hash" IS NOT NULL AND "published_at" IS NOT NULL AND "published_by" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "showcases" ADD CONSTRAINT "showcases_token_hash_ck" CHECK ("token_hash" IS NULL OR "token_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "showcase_consents" ADD CONSTRAINT "showcase_consents_kind_ck" CHECK ("kind" IN ('granted','withdrawn'));--> statement-breakpoint
ALTER TABLE "showcase_consents" ADD CONSTRAINT "showcase_consents_actor_ck" CHECK (("kind" = 'granted' AND "actor_relationship" IN ('guardian','self')) OR ("kind" = 'withdrawn' AND "actor_relationship" IN ('guardian','self','staff')));--> statement-breakpoint
ALTER TABLE "showcase_view_days" ADD CONSTRAINT "showcase_view_days_views_ck" CHECK ("views" >= 0);--> statement-breakpoint
ALTER TABLE "monthly_recaps" ADD CONSTRAINT "monthly_recaps_status_ck" CHECK ("status" IN ('open','final'));--> statement-breakpoint
ALTER TABLE "monthly_recaps" ADD CONSTRAINT "monthly_recaps_month_ck" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');--> statement-breakpoint
ALTER TABLE "monthly_recaps" ADD CONSTRAINT "monthly_recaps_final_ck" CHECK ("status" <> 'final' OR ("snapshot" IS NOT NULL AND "finalized_at" IS NOT NULL));--> statement-breakpoint
-- The consent trail is append-only, like audit_events.
CREATE OR REPLACE FUNCTION showcase_consents_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'showcase_consents is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER showcase_consents_no_update BEFORE UPDATE OR DELETE ON "showcase_consents"
  FOR EACH ROW EXECUTE FUNCTION showcase_consents_immutable();
--> statement-breakpoint
-- A finalized recap never changes: later edits to attendance, tests or goals do not rewrite history.
CREATE OR REPLACE FUNCTION monthly_recaps_final_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'final' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'a finalized monthly recap cannot be deleted';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
      OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
      OR NEW.coach_note IS DISTINCT FROM OLD.coach_note
      OR NEW.calc_key IS DISTINCT FROM OLD.calc_key
      OR NEW.month IS DISTINCT FROM OLD.month
      OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id
      OR NEW.org_id IS DISTINCT FROM OLD.org_id
      OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
      RAISE EXCEPTION 'a finalized monthly recap is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER monthly_recaps_final_guard BEFORE UPDATE OR DELETE ON "monthly_recaps"
  FOR EACH ROW EXECUTE FUNCTION monthly_recaps_final_immutable();