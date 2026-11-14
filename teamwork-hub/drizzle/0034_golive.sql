CREATE TABLE "go_live_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"attested_by_user_id" uuid NOT NULL,
	"attested_by_name" text NOT NULL,
	"attested_on" date NOT NULL,
	"note" text,
	"value_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "go_live_attestations" ADD CONSTRAINT "go_live_attestations_attested_by_user_id_users_id_fk" FOREIGN KEY ("attested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "go_live_attestations" ADD CONSTRAINT "go_live_attestations_withdrawn_by_user_id_users_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "go_live_attestations_live_uq" ON "go_live_attestations" USING btree ("org_id","key") WHERE "go_live_attestations"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "go_live_attestations_org_idx" ON "go_live_attestations" USING btree ("org_id","key");