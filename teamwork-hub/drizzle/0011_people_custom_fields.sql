ALTER TABLE "custom_field_defs" ADD COLUMN "required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_defs" ADD COLUMN "visibility" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_defs" ADD COLUMN "show_in_list" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_defs" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_defs" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_defs" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_defs_org_key_uq" ON "custom_field_defs" USING btree ("org_id","key");--> statement-breakpoint
ALTER TABLE "custom_field_defs" ADD CONSTRAINT "custom_field_defs_type_ck" CHECK ("field_type" IN ('text','number','date','select','boolean'));
--> statement-breakpoint
ALTER TABLE "custom_field_defs" ADD CONSTRAINT "custom_field_defs_applies_ck" CHECK ("applies_to" IN ('person','athlete','lead'));
--> statement-breakpoint
ALTER TABLE "custom_field_defs" ADD CONSTRAINT "custom_field_defs_visibility_ck" CHECK ("visibility" IN ('staff','family'));
--> statement-breakpoint
ALTER TABLE "custom_field_defs" ADD CONSTRAINT "custom_field_defs_key_ck" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,39}$');
