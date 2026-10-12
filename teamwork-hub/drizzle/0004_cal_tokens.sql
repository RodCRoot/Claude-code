CREATE TABLE "calendar_oauth_tokens" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"access_token_enc" text,
	"access_token_expires_at" timestamp with time zone,
	"scopes" text NOT NULL,
	"refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "freebusy_calendar_id" text;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_oauth_tokens" ADD CONSTRAINT "calendar_oauth_tokens_connection_id_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cal_conn_user_provider_uq" ON "calendar_connections" USING btree ("org_id","user_id","provider");