CREATE TABLE "scoreboard_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"month" date NOT NULL,
	"category" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scoreboard_expenses_amount_ck" CHECK ("scoreboard_expenses"."amount_minor" >= 0),
	CONSTRAINT "scoreboard_expenses_month_ck" CHECK (extract(day from "scoreboard_expenses"."month") = 1),
	CONSTRAINT "scoreboard_expenses_category_ck" CHECK ("scoreboard_expenses"."category" in ('rent','software','payroll_manual','other'))
);
--> statement-breakpoint
CREATE TABLE "scoreboard_marketing_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"month" date NOT NULL,
	"channel" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"note" text,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scoreboard_spend_amount_ck" CHECK ("scoreboard_marketing_spend"."amount_minor" >= 0),
	CONSTRAINT "scoreboard_spend_month_ck" CHECK (extract(day from "scoreboard_marketing_spend"."month") = 1)
);
--> statement-breakpoint
ALTER TABLE "scoreboard_expenses" ADD CONSTRAINT "scoreboard_expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoreboard_marketing_spend" ADD CONSTRAINT "scoreboard_marketing_spend_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scoreboard_expenses_uq" ON "scoreboard_expenses" USING btree ("org_id","month","category",lower("label"));--> statement-breakpoint
CREATE INDEX "scoreboard_expenses_org_idx" ON "scoreboard_expenses" USING btree ("org_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "scoreboard_spend_uq" ON "scoreboard_marketing_spend" USING btree ("org_id","month",lower("channel"));