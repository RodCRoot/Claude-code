CREATE TABLE "alumni" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"sport" text,
	"college" text,
	"grad_year" integer,
	"athlete_id" uuid,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"watch" boolean DEFAULT false NOT NULL,
	"watch_basis" text,
	"watch_set_by" uuid,
	"watch_set_at" timestamp with time zone,
	"full_name_ok" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_fetch_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"day" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_id" uuid,
	"link_key" text NOT NULL,
	"title_key" text NOT NULL,
	"headline" text NOT NULL,
	"source_name" text NOT NULL,
	"published_at" timestamp with time zone,
	"link" text NOT NULL,
	"snippet" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_negatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid,
	"alumni_id" uuid,
	"news_item_id" uuid,
	"title_key" text,
	"publication" text,
	"term" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"sites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"min_interval_minutes" integer DEFAULT 720 NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_status" text,
	"last_result" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"backoff_until" timestamp with time zone,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_watch_athletes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"opted_in" boolean DEFAULT false NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_as" text,
	"requested_at" timestamp with time zone,
	"requested_by" uuid,
	"school" text,
	"sport" text,
	"town" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_watch_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"athlete_id" uuid,
	"alumni_id" uuid,
	"action" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_person_id" uuid,
	"relationship" text NOT NULL,
	"policy_version" text,
	"policy_text" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "win_leads" ADD COLUMN "kind" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "win_leads" ADD COLUMN "news_item_id" uuid;--> statement-breakpoint
ALTER TABLE "win_leads" ADD COLUMN "alumni_id" uuid;--> statement-breakpoint
ALTER TABLE "win_leads" ADD COLUMN "news_status" text;--> statement-breakpoint
ALTER TABLE "win_leads" ADD COLUMN "match_level" text;--> statement-breakpoint
ALTER TABLE "win_leads" ADD COLUMN "match_score" integer;--> statement-breakpoint
ALTER TABLE "win_leads" ADD COLUMN "match_reasons" jsonb;--> statement-breakpoint
ALTER TABLE "win_leads" ADD COLUMN "sensitive_note" text;--> statement-breakpoint
ALTER TABLE "win_leads" ADD COLUMN "triaged_by" uuid;--> statement-breakpoint
ALTER TABLE "win_leads" ADD COLUMN "triaged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "win_leads" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "win_leads" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wins" ADD COLUMN "news_source" text;--> statement-breakpoint
ALTER TABLE "alumni" ADD CONSTRAINT "alumni_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumni" ADD CONSTRAINT "alumni_watch_set_by_users_id_fk" FOREIGN KEY ("watch_set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumni" ADD CONSTRAINT "alumni_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_source_id_news_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."news_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_negatives" ADD CONSTRAINT "news_negatives_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_negatives" ADD CONSTRAINT "news_negatives_alumni_id_alumni_id_fk" FOREIGN KEY ("alumni_id") REFERENCES "public"."alumni"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_negatives" ADD CONSTRAINT "news_negatives_news_item_id_news_items_id_fk" FOREIGN KEY ("news_item_id") REFERENCES "public"."news_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_negatives" ADD CONSTRAINT "news_negatives_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_sources" ADD CONSTRAINT "news_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_watch_athletes" ADD CONSTRAINT "news_watch_athletes_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_watch_athletes" ADD CONSTRAINT "news_watch_athletes_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_watch_athletes" ADD CONSTRAINT "news_watch_athletes_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_watch_events" ADD CONSTRAINT "news_watch_events_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_watch_events" ADD CONSTRAINT "news_watch_events_alumni_id_alumni_id_fk" FOREIGN KEY ("alumni_id") REFERENCES "public"."alumni"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_watch_events" ADD CONSTRAINT "news_watch_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_watch_events" ADD CONSTRAINT "news_watch_events_actor_person_id_people_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alumni_org_idx" ON "alumni" USING btree ("org_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_athlete_uq" ON "alumni" USING btree ("athlete_id");--> statement-breakpoint
CREATE UNIQUE INDEX "news_fetch_days_uq" ON "news_fetch_days" USING btree ("org_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "news_items_link_uq" ON "news_items" USING btree ("org_id","link_key");--> statement-breakpoint
CREATE INDEX "news_items_title_idx" ON "news_items" USING btree ("org_id","title_key");--> statement-breakpoint
CREATE INDEX "news_negatives_athlete_idx" ON "news_negatives" USING btree ("org_id","athlete_id");--> statement-breakpoint
CREATE INDEX "news_negatives_alumni_idx" ON "news_negatives" USING btree ("org_id","alumni_id");--> statement-breakpoint
CREATE INDEX "news_sources_org_idx" ON "news_sources" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "news_watch_athletes_uq" ON "news_watch_athletes" USING btree ("athlete_id");--> statement-breakpoint
CREATE INDEX "news_watch_athletes_org_idx" ON "news_watch_athletes" USING btree ("org_id","opted_in");--> statement-breakpoint
CREATE INDEX "news_watch_events_athlete_idx" ON "news_watch_events" USING btree ("org_id","athlete_id","created_at");--> statement-breakpoint
CREATE INDEX "news_watch_events_alumni_idx" ON "news_watch_events" USING btree ("org_id","alumni_id","created_at");--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_news_item_id_news_items_id_fk" FOREIGN KEY ("news_item_id") REFERENCES "public"."news_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_alumni_id_alumni_id_fk" FOREIGN KEY ("alumni_id") REFERENCES "public"."alumni"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_triaged_by_users_id_fk" FOREIGN KEY ("triaged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "win_leads_news_idx" ON "win_leads" USING btree ("org_id","kind","news_status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "win_leads_news_athlete_uq" ON "win_leads" USING btree ("news_item_id","athlete_id");--> statement-breakpoint
CREATE UNIQUE INDEX "win_leads_news_alumni_uq" ON "win_leads" USING btree ("news_item_id","alumni_id");--> statement-breakpoint
-- Hand-written from here (News watch). Wins may now be of type 'in_the_news' (every existing type kept).
ALTER TABLE "wins" DROP CONSTRAINT "wins_type_ck";--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_type_ck" CHECK ("type" IN ('personal_best','placing','selection','commitment','team_championship','character','other','in_the_news'));--> statement-breakpoint
-- The publication is stored only on a news win, and a news win always has its link and publication.
ALTER TABLE "wins" ADD CONSTRAINT "wins_news_source_ck" CHECK (("type" = 'in_the_news') = ("news_source" IS NOT NULL) AND ("type" <> 'in_the_news' OR "source_url" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_kind_ck" CHECK ("kind" IN ('staff','news'));--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_news_status_ck" CHECK ("news_status" IS NULL OR "news_status" IN ('suggested','confirmed','approved','rejected','not_ours','ignored','withdrawn','removed'));--> statement-breakpoint
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_match_level_ck" CHECK ("match_level" IS NULL OR "match_level" IN ('likely','possible'));--> statement-breakpoint
-- A news clip has an article, a status and exactly one person; a staff lead has none of the news fields.
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_news_shape_ck" CHECK (
  ("kind" = 'news' AND "news_item_id" IS NOT NULL AND "news_status" IS NOT NULL AND (("athlete_id" IS NULL) <> ("alumni_id" IS NULL)))
  OR ("kind" = 'staff' AND "news_item_id" IS NULL AND "news_status" IS NULL AND "alumni_id" IS NULL));--> statement-breakpoint
-- Nothing is shared without a person: an approved (or later taken down) clip always records who approved it and when.
ALTER TABLE "win_leads" ADD CONSTRAINT "win_leads_news_approved_ck" CHECK ("news_status" IS NULL OR "news_status" <> 'approved' OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "news_sources" ADD CONSTRAINT "news_sources_kind_ck" CHECK ("kind" IN ('rss','search'));--> statement-breakpoint
ALTER TABLE "news_sources" ADD CONSTRAINT "news_sources_audience_ck" CHECK ("audience" IN ('all','athletes','alumni'));--> statement-breakpoint
ALTER TABLE "news_sources" ADD CONSTRAINT "news_sources_url_ck" CHECK ("url" ~ '^https://');--> statement-breakpoint
ALTER TABLE "news_sources" ADD CONSTRAINT "news_sources_interval_ck" CHECK ("min_interval_minutes" >= 60);--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_link_ck" CHECK ("link" ~ '^https://');--> statement-breakpoint
-- Only a headline and at most a short summary are ever stored: never article text.
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_size_ck" CHECK (char_length("headline") <= 300 AND ("snippet" IS NULL OR char_length("snippet") <= 280));--> statement-breakpoint
-- An alumnus is watched only with a recorded basis, by a recorded staff member.
ALTER TABLE "alumni" ADD CONSTRAINT "alumni_watch_basis_ck" CHECK (NOT "watch" OR ("watch_basis" IS NOT NULL AND char_length("watch_basis") >= 5 AND "watch_set_by" IS NOT NULL AND "watch_set_at" IS NOT NULL AND "active"));--> statement-breakpoint
-- An athlete opt-in always records who decided, and staff can never switch it on.
ALTER TABLE "news_watch_athletes" ADD CONSTRAINT "news_watch_athletes_optin_ck" CHECK (NOT "opted_in" OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "decided_as" IN ('guardian','self')));--> statement-breakpoint
ALTER TABLE "news_watch_athletes" ADD CONSTRAINT "news_watch_athletes_decided_as_ck" CHECK ("decided_as" IS NULL OR "decided_as" IN ('guardian','self','staff'));--> statement-breakpoint
ALTER TABLE "news_watch_events" ADD CONSTRAINT "news_watch_events_action_ck" CHECK ("action" IN ('requested','granted','declined','revoked','alumni_added','alumni_removed'));--> statement-breakpoint
ALTER TABLE "news_watch_events" ADD CONSTRAINT "news_watch_events_relationship_ck" CHECK ("relationship" IN ('guardian','self','staff'));--> statement-breakpoint
ALTER TABLE "news_watch_events" ADD CONSTRAINT "news_watch_events_who_ck" CHECK (("athlete_id" IS NULL) <> ("alumni_id" IS NULL));--> statement-breakpoint
-- Staff never grant an opt-in; only staff ask, and only staff manage the alumni list.
ALTER TABLE "news_watch_events" ADD CONSTRAINT "news_watch_events_staff_ck" CHECK (
  ("relationship" = 'staff' AND "action" <> 'granted') OR ("relationship" <> 'staff' AND "action" IN ('granted','declined','revoked')));--> statement-breakpoint
CREATE OR REPLACE FUNCTION news_watch_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'news_watch_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER news_watch_events_no_update BEFORE UPDATE OR DELETE ON "news_watch_events"
  FOR EACH ROW EXECUTE FUNCTION news_watch_events_immutable();
