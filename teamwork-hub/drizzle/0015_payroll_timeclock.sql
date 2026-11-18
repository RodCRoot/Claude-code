CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"gross_minor" integer NOT NULL,
	"deduction_minor" integer NOT NULL,
	"net_minor" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"exported_by" uuid,
	"exported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_status_ck" CHECK ("payroll_runs"."status" in ('draft','approved','exported')),
	CONSTRAINT "payroll_runs_range_ck" CHECK ("payroll_runs"."from_date" <= "payroll_runs"."to_date")
);
--> statement-breakpoint
CREATE TABLE "payroll_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"deduction_bps" integer NOT NULL,
	"rounding" text NOT NULL,
	"thresholds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"import_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"access_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_settings_bps_ck" CHECK ("payroll_settings"."deduction_bps" >= 0 and "payroll_settings"."deduction_bps" <= 10000),
	CONSTRAINT "payroll_settings_rounding_ck" CHECK ("payroll_settings"."rounding" in ('truncate_2dp','exact'))
);
--> statement-breakpoint
CREATE TABLE "staff_clock_pins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"pin_hash" text NOT NULL,
	"set_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_pay_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"rate_minor" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_pay_rates_positive" CHECK ("staff_pay_rates"."rate_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"clock_in" timestamp with time zone NOT NULL,
	"clock_out" timestamp with time zone,
	"source" text NOT NULL,
	"original_clock_in" timestamp with time zone NOT NULL,
	"original_clock_out" timestamp with time zone,
	"created_by" uuid,
	"edited_by" uuid,
	"edited_at" timestamp with time zone,
	"edit_reason" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"ack_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"import_key" text,
	"import_raw" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entries_out_after_in" CHECK ("time_entries"."clock_out" is null or "time_entries"."clock_out" > "time_entries"."clock_in"),
	CONSTRAINT "time_entries_source_ck" CHECK ("time_entries"."source" in ('kiosk','staff','manual','import'))
);
--> statement-breakpoint
ALTER TABLE "staff_clock_pins" ADD CONSTRAINT "staff_clock_pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_pay_rates" ADD CONSTRAINT "staff_pay_rates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payroll_runs_org_idx" ON "payroll_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_clock_pin_org_hash_uq" ON "staff_clock_pins" USING btree ("org_id","pin_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_pay_rates_user_from_uq" ON "staff_pay_rates" USING btree ("user_id","effective_from");--> statement-breakpoint
CREATE INDEX "staff_pay_rates_org_idx" ON "staff_pay_rates" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "time_entries_one_open_uq" ON "time_entries" USING btree ("user_id") WHERE "time_entries"."clock_out" is null and "time_entries"."voided_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "time_entries_import_uq" ON "time_entries" USING btree ("org_id","import_key");--> statement-breakpoint
CREATE INDEX "time_entries_org_user_in_idx" ON "time_entries" USING btree ("org_id","user_id","clock_in");